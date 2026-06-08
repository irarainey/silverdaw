// ─────────────────────────────────────────────────────────────────────────────
// MixdownEngine — offline render.
//
// Topology mirrors the live engine exactly. Each clip drives the same per-clip
// source graph the audio thread drives during playback:
//
//   AudioFormatReader
//    → AudioFormatReaderSource           (at source sample rate)
//    → OffsetSource(WarpProcessor)       (timeline window + warp at source rate)
//    → AudioTransportSource              (no read-ahead, source→projectRate via
//                                         JUCE's internal ResamplingAudioSource)
//    → [future per-clip processor chain insert — at project rate]
//    → mix bus                           (stereo at projectRate)
//    → libsamplerate (project→outputRate, only when they differ)
//    → WAV writer
//
// Sharing OffsetSource + WarpProcessor with the live engine means warped clips
// in the exported file are produced by the exact same code path that produces
// them at playback time: same priming, same start-delay discard, same mode
// flags, same ratio interpretation. Any future clip-level processor (reverb,
// EQ, compressor) gets inserted in one place and is used identically in both
// live and offline.
// ─────────────────────────────────────────────────────────────────────────────

#include "MixdownRender.h"

#include "AudioEngine.h"   // for silverdaw::OffsetSource
#include "AudioConstants.h"
#include "BridgeServer.h"
#include "Log.h"
#include "LoudnessAnalyzer.h"
#include "MixdownBroadcast.h"
#include "MixdownDither.h"
#include "MixdownEngine.h"
#include "MixdownExport.h"
#include "MixdownGraph.h"
#include "MixdownNormalize.h"
#include "MixdownRenderPass1.h"
#include "ProjectState.h"
#include "WarpProcessor.h"

#include <algorithm>
#include <cmath>
#include <limits>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>

#if JUCE_WINDOWS
#include <windows.h>
#endif

namespace silverdaw
{

// Output-format / metadata writers live in MixdownExport.cpp; the offline
// source-graph types live in MixdownGraph.{h,cpp}. Hoist the pieces the render
// pipeline touches so its call sites below read unqualified.
using mixdown_export::atomicReplace;
using mixdown_export::createOutputWriter;
using mixdown_export::findLameExecutable;
using mixdown_export::writeAiffTextChunks;
using mixdown_export::writeFlacVorbisComment;

using mixdown_graph::kBlockFrames;
using mixdown_graph::kOutputChannels;

// Bridge-envelope emitters live in MixdownBroadcast.cpp.
using mixdown_bridge::broadcastDone;
using mixdown_bridge::broadcastFailed;
using mixdown_bridge::broadcastProgress;

// Dither generators are seeded here and shared with the render passes.
using mixdown_dither::Xorshift32;

namespace
{

// Min spacing between progress envelopes so the bridge isn't flooded.
constexpr int kProgressMinIntervalMs = 50;

} // anonymous namespace

// ─────────────────────────────────────────────────────────────────────────────
// Render worker — runs on the thread pool (posted by renderMixdownAsync).
// ─────────────────────────────────────────────────────────────────────────────

void runMixdownJob(MixdownSnapshot snapshot,
                   MixdownOptions options,
                   BridgeServer& bridge,
                   std::atomic<bool>& cancelFlag,
                   std::atomic<bool>& busyFlag)
{
        struct BusyGuard
        {
            std::atomic<bool>& flag;
            ~BusyGuard() { flag.store(false); }
        } busyGuard{busyFlag};

        const auto failWith = [&](MixdownFailureCode code, const juce::String& message)
        {
            silverdaw::log::warn("mixdown", "fail code=" + juce::String(mixdownFailureCodeToString(code)) +
                                                 " msg=" + message);
            broadcastFailed(bridge, code, message);
        };

        if (snapshot.tracks.empty())
        {
            failWith(MixdownFailureCode::Invalid, "No clips to render.");
            return;
        }
        if (options.lengthMs <= 0.0)
        {
            failWith(MixdownFailureCode::Invalid, "Mixdown length must be positive.");
            return;
        }
        if (options.outputSampleRate != 44100 && options.outputSampleRate != 48000)
        {
            failWith(MixdownFailureCode::Invalid,
                     "Unsupported output sample rate " + juce::String(options.outputSampleRate));
            return;
        }

        // ── MP3 setup ───────────────────────────────────────────────
        // LAME is a 16-bit-only pipeline; force bit depth + dither up
        // front so the rest of the pump loop's PCM quantisation path
        // does the right thing regardless of what the frontend sent.
        const bool mp3 = options.format == MixdownOptions::Format::Mp3;
        juce::File lameApp;
        if (mp3)
        {
            lameApp = findLameExecutable();
            if (! lameApp.existsAsFile())
            {
                failWith(MixdownFailureCode::Invalid,
                         "MP3 encoder (lame.exe) is not bundled with this build. "
                         "See backend/third_party/lame/README.md.");
                return;
            }
            options.bitDepth = 16;
            options.dither = true;
        }
        // Loudness modes are only meaningful at standard sample
        // rates (BS.1770-4 calibration). The general output-rate
        // guard above already restricts us to 44.1/48 kHz; if that
        // ever widens, this guard keeps the analyzer honest.
        if (options.loudnessMode != MixdownOptions::LoudnessMode::Off
            && options.outputSampleRate != 44100
            && options.outputSampleRate != 48000)
        {
            failWith(MixdownFailureCode::Invalid,
                     "Loudness analysis requires 44.1 or 48 kHz output.");
            return;
        }
        const bool normalizing = options.loudnessMode == MixdownOptions::LoudnessMode::Normalize;
        const bool analyzing = options.loudnessMode != MixdownOptions::LoudnessMode::Off;
        std::unique_ptr<LoudnessAnalyzer> analyzer;
        if (analyzing)
        {
            try
            {
                analyzer = std::make_unique<LoudnessAnalyzer>(
                    static_cast<double>(options.outputSampleRate));
            }
            catch (const juce::String& e)
            {
                failWith(MixdownFailureCode::Invalid,
                         "Could not start loudness analyzer: " + e);
                return;
            }
        }

        broadcastProgress(bridge, 0.0, "prepare");

        // Open writer on `<file>.tmp` so the rename is atomic and
        // same-volume on Windows.
        const auto targetFile = options.outputFile;
        const auto parentDir = targetFile.getParentDirectory();
        if (!parentDir.exists() && !parentDir.createDirectory())
        {
            failWith(MixdownFailureCode::Io,
                     "Cannot create output folder: " + parentDir.getFullPathName());
            return;
        }
        const auto tmpFile = parentDir.getChildFile(targetFile.getFileName() + ".tmp");
        tmpFile.deleteFile();
        // Normalize mode renders a 32-float intermediate to a
        // distinct `.f32.tmp` sidecar in pass 1 (no dither, full
        // precision); pass 2 streams that intermediate through the
        // gain stage and into the user's chosen final writer
        // (writing to `.tmp`, then atomic rename to `targetFile`).
        const auto f32TmpFile = parentDir.getChildFile(targetFile.getFileName() + ".f32.tmp");
        f32TmpFile.deleteFile();

        juce::AudioFormatManager formatManager;
        formatManager.registerBasicFormats();

        // Modern writer factory. Switches on format + bit-depth and
        // selects the right SampleFormat (integral for PCM/FLAC, IEEE
        // float for 32-bit WAV float). Using the AudioFormatWriterOptions
        // API rather than the deprecated metadata-var overload also kills
        // the JUCE C4996 deprecation warning we used to get.
        // For Normalize the pass-1 writer is a 32-float WAV at the
        // output sample rate written to `.f32.tmp`. The user-chosen
        // format / bit-depth is deferred to pass 2. For Off and
        // AnalyzeOnly the pass-1 writer is the final user-chosen
        // writer to `.tmp`.
        const juce::File& pass1File = normalizing ? f32TmpFile : tmpFile;
        std::unique_ptr<juce::OutputStream> outStream = std::make_unique<juce::FileOutputStream>(pass1File);
        if (! static_cast<juce::FileOutputStream*>(outStream.get())->openedOk())
        {
            failWith(MixdownFailureCode::Io,
                     "Cannot open output file for writing: " + pass1File.getFullPathName());
            return;
        }

        const int chosenBitDepth = options.bitDepth;
        const bool wantFloatWav =
            options.format == MixdownOptions::Format::Wav && chosenBitDepth == 32;
        // Pass-1 writer settings depend on the mode.
        const int pass1BitDepth = normalizing ? 32 : chosenBitDepth;
        const bool pass1WantsFloat = normalizing ? true : wantFloatWav;

        auto writerOptions = juce::AudioFormatWriterOptions{}
                                 .withSampleRate(static_cast<double>(options.outputSampleRate))
                                 .withNumChannels(kOutputChannels)
                                 .withBitsPerSample(pass1BitDepth)
                                 .withSampleFormat(pass1WantsFloat
                                                       ? juce::AudioFormatWriterOptions::SampleFormat::floatingPoint
                                                       : juce::AudioFormatWriterOptions::SampleFormat::integral);

        std::unique_ptr<juce::AudioFormatWriter> writer;
        if (normalizing)
        {
            // Pass-1 intermediate is always WAV regardless of the
            // user-requested final format (FLAC writers can't be
            // streamed in append-friendly chunks the way we'd want
            // for the pass-2 read-back).
            juce::WavAudioFormat wav;
            writer = wav.createWriterFor(outStream, writerOptions);
        }
        else
        {
            writer = mixdown_export::createOutputWriter(
                options.format, writerOptions, lameApp, options.metadata,
                options.bitrateKbps, outStream);
        }

        if (writer == nullptr)
        {
            // Clean up the partial stream — createWriterFor only consumes
            // the unique_ptr on success.
            outStream.reset();
            pass1File.deleteFile();
            const auto fmtName = normalizing
                                     ? juce::String("WAV-f32 (pass1)")
                                     : (options.format == MixdownOptions::Format::Flac
                                            ? juce::String("FLAC")
                                            : (options.format == MixdownOptions::Format::Mp3
                                                   ? juce::String("MP3")
                                                   : (options.format == MixdownOptions::Format::Aiff
                                                          ? juce::String("AIFF")
                                                          : juce::String("WAV"))));
            failWith(MixdownFailureCode::Io,
                     "Failed to create " + fmtName + " writer (bitDepth=" +
                         juce::String(pass1BitDepth) + ", sr=" + juce::String(options.outputSampleRate) + ").");
            return;
        }
        // Belt-and-braces self-check: when float WAV was requested,
        // verify the writer actually opened in float mode (catches a
        // silent format-string regression should JUCE change the
        // semantics of withSampleFormat).
        if (pass1WantsFloat && ! writer->isFloatingPoint())
        {
            writer.reset();
            pass1File.deleteFile();
            failWith(MixdownFailureCode::Io,
                     "WAV writer opened in PCM mode when 32-float was requested.");
            return;
        }
        silverdaw::log::info(
            "mixdown",
            juce::String("writer opened format=") +
                (normalizing
                     ? "wav-f32 (pass1)"
                     : (options.format == MixdownOptions::Format::Flac
                            ? "flac"
                            : (options.format == MixdownOptions::Format::Mp3
                                   ? "mp3"
                                   : (options.format == MixdownOptions::Format::Aiff
                                          ? "aiff"
                                          : "wav")))) +
                " bitDepth=" + juce::String(pass1BitDepth) +
                " float=" + (writer->isFloatingPoint() ? "true" : "false") +
                " loudnessMode=" + (analyzing ? (normalizing ? "normalize" : "analyze") : "off"));

        // ── Render pass 1 ──────────────────────────────────────────
        // Build the offline source graph and run the main pump loop
        // (MixdownRenderPass1.cpp). The dither generators are owned here
        // so Normalize pass-2 reuses pristine ones (pass-1 leaves them
        // untouched in Normalize mode, where its intermediate is float).
        juce::Random seedGen;
        Xorshift32 rngL { static_cast<uint32_t>(seedGen.nextInt(juce::Range<int>(1, INT_MAX))) };
        Xorshift32 rngR { static_cast<uint32_t>(seedGen.nextInt(juce::Range<int>(1, INT_MAX))) };

        auto p1 = mixdown_render_pass1::runPass1(
            snapshot, options, formatManager, *writer, analyzer.get(),
            normalizing, analyzing, pass1File, rngL, rngR, bridge, cancelFlag);
        if (! p1.ok)
        {
            failWith(p1.code, p1.message);
            return;
        }
        // The live clip chains are returned for deferred teardown after DONE.
        auto clips = std::move(p1.clips);
        int64_t outputFramesWritten = p1.outputFramesWritten;
        const double effectiveRenderLengthMs = p1.effectiveRenderLengthMs;
        const double preClampPeakAmplitude = p1.preClampPeakAmplitude;
        const int64_t clippedSampleCount = p1.clippedSampleCount;
        // User-requested trailing silence (also applied inside pass 1);
        // recomputed here for the done-log only.
        const double clampedTailSeconds = juce::jlimit(0.0, 60.0, options.tailSeconds);

        // Force a final render-stage broadcast so the bar reaches the
        // top of the render band even if the last in-loop update was
        // throttled out — otherwise we'd visibly jump up at the start
        // of finalize.
        broadcastProgress(bridge, normalizing ? 45.0 : 90.0,
                          normalizing ? "normalize-pass1"
                                      : (analyzing ? "analyze" : "render"));

        // Pad if the resampler under-delivered. With the streaming-correct
        // FinalResampler this should be rare and at most a handful of
        // samples — but we keep the safety net so the WAV duration matches
        // what the dialog said it would.
        const auto finalizeStartMs = juce::Time::getMillisecondCounter();
        const int64_t totalOutputFrames =
            static_cast<int64_t>(std::round(effectiveRenderLengthMs * options.outputSampleRate / 1000.0));
        if (outputFramesWritten < totalOutputFrames)
        {
            const int64_t pad = totalOutputFrames - outputFramesWritten;
            std::vector<float> zeros(static_cast<size_t>(juce::jmin<int64_t>(pad, kBlockFrames)));
            const float* writePtrs[kOutputChannels] = {zeros.data(), zeros.data()};
            int64_t remaining = pad;
            while (remaining > 0)
            {
                const int chunk = static_cast<int>(juce::jmin<int64_t>(remaining, kBlockFrames));
                if (!writer->writeFromFloatArrays(writePtrs, kOutputChannels, chunk)) break;
                remaining -= chunk;
            }
        }
        const auto padEndMs = juce::Time::getMillisecondCounter();
        broadcastProgress(bridge, 92.0, "finalize");

        // writer.reset() rewrites the WAV RIFF/data-size headers and
        // closes the underlying FileOutputStream. After this returns
        // the bytes are on disk; the only thing left before the user's
        // file is "the user's file" is the atomic rename.
        //
        // NOTE: we deliberately do NOT tear down the per-clip JUCE
        // chains before this. They are pure readers with
        // `readAhead=0` (no background buffering threads), so leaving
        // them alive cannot affect the writer's output. Destroying
        // them is, however, surprisingly expensive — closing each
        // AudioFormatReader's underlying FileInputStream on Windows
        // is ~1 s per handle (likely the OS / antivirus flushing the
        // read cache for the decoded-WAV files). With N clips that's
        // an N-second wait the user sees as "progress sat at 99% for
        // ages". We defer it past the DONE broadcast below.
        broadcastProgress(bridge, normalizing ? 45.0 : 95.0, "encode");
        writer.reset();
        const auto writerEndMs = juce::Time::getMillisecondCounter();

        // ── Loudness analysis & optional Normalize pass 2 ──────────
        // Run finalize() unconditionally if analyzing — pass 2 also
        // needs the source measurement to derive the linear gain
        // and the true-peak back-off. For Off mode `sourceLoudness`
        // and `finalLoudness` both stay default-constructed and the
        // DONE message simply omits the `loudness` block.
        LoudnessAnalyzer::Result sourceLoudness{};
        LoudnessAnalyzer::Result finalLoudness{};
        double appliedGainDb = 0.0;
        bool limitedByTruePeak = false;
        int64_t pass2ClippedSamples = 0;
        double pass2PostGainPeakAmp = 0.0;
        if (analyzing && analyzer != nullptr)
        {
            broadcastProgress(bridge, normalizing ? 46.0 : 96.0, "analyze");
            sourceLoudness = analyzer->finalize();
            finalLoudness = sourceLoudness; // overwritten below if normalizing

            // Compute desired linear gain in dB. Silent and
            // unmeasurable both → no gain (DONE will still flag the
            // distinction in the report).
            double desiredGainDb = 0.0;
            if (normalizing)
            {
                if (! sourceLoudness.silent && ! sourceLoudness.unmeasurable
                    && std::isfinite(sourceLoudness.integratedLufs))
                {
                    desiredGainDb = options.targetLufs - sourceLoudness.integratedLufs;
                }
                // True-peak ceiling back-off, with a 0.2 dB safety
                // margin to absorb FIR-vs-true-peak approximation
                // error in the polyphase oversampler.
                if (std::isfinite(sourceLoudness.truePeakDbtp))
                {
                    const double ceil = options.ceilingDbtp - 0.2;
                    const double projected = sourceLoudness.truePeakDbtp + desiredGainDb;
                    if (projected > ceil)
                    {
                        desiredGainDb = ceil - sourceLoudness.truePeakDbtp;
                        limitedByTruePeak = true;
                    }
                }
            }
            appliedGainDb = desiredGainDb;
            silverdaw::log::info(
                "mixdown",
                juce::String("loudness source LUFS=") +
                    (std::isfinite(sourceLoudness.integratedLufs)
                         ? juce::String(sourceLoudness.integratedLufs, 2)
                         : juce::String("-inf")) +
                    " TP=" + juce::String(sourceLoudness.truePeakDbtp, 2) +
                    " silent=" + (sourceLoudness.silent ? "true" : "false") +
                    " unmeasurable=" + (sourceLoudness.unmeasurable ? "true" : "false") +
                    " blocks=" + juce::String((int) sourceLoudness.gatedBlockCount) +
                    " appliedGainDb=" + juce::String(appliedGainDb, 3) +
                    " limited=" + (limitedByTruePeak ? "true" : "false"));
        }

        // ── Normalize pass 2: stream f32 tmp → gain → dither → final writer
        if (normalizing)
        {
            auto p2 = mixdown_normalize::runNormalizePass2(
                f32TmpFile, tmpFile, options, lameApp, chosenBitDepth, wantFloatWav,
                appliedGainDb, *analyzer, rngL, rngR, bridge, cancelFlag);
            if (! p2.ok)
            {
                failWith(p2.code, p2.message);
                return;
            }
            outputFramesWritten = p2.outputFramesWritten;
            pass2ClippedSamples = p2.clippedSamples;
            pass2PostGainPeakAmp = p2.postGainPeakAmp;
            finalLoudness = p2.finalLoudness;
        }
        else
        {
            // Off / AnalyzeOnly: pass-1 already wrote `tmpFile` (the
            // final user-format file). Nothing more to do.
        }

        if (cancelFlag.load())
        {
            tmpFile.deleteFile();
            failWith(MixdownFailureCode::Cancelled, "Cancelled.");
            return;
        }

        if (!atomicReplace(tmpFile, targetFile))
        {
            tmpFile.deleteFile();
            failWith(MixdownFailureCode::Io,
                     "Could not finalise output file (rename failed). Path may be open in another app.");
            return;
        }
        const auto replaceEndMs = juce::Time::getMillisecondCounter();

        // FLAC metadata is not written by JUCE's FlacAudioFormat, so
        // post-process the finalised file to insert a VORBIS_COMMENT
        // block before the audio frames. Best-effort: a failure here
        // does not invalidate the (perfectly valid) FLAC bitstream.
        if (options.format == MixdownOptions::Format::Flac && ! options.metadata.isEmpty())
            writeFlacVorbisComment(targetFile, options.metadata);
        // AIFF: same story — JUCE's AiffAudioFormat ignores the
        // metadata map, so we patch text chunks into the FORM
        // container ourselves.
        if (options.format == MixdownOptions::Format::Aiff && ! options.metadata.isEmpty())
            writeAiffTextChunks(targetFile, options.metadata);

        // From the user's point of view the export is now complete:
        // the file at `targetFile` is the final WAV. Push 100% + DONE
        // immediately so the dialog dismisses without waiting on the
        // slow clip teardown that follows.
        broadcastProgress(bridge, 100.0, "finalize");
        // Actual duration of the file on disk, computed from frames
        // written * output sample period. Includes the user tail and
        // any per-clip processor tail, so the dialog/IPC see the
        // real exported length rather than the nominal timeline ms.
        const double actualDurationMs =
            static_cast<double>(outputFramesWritten) * 1000.0
            / static_cast<double>(options.outputSampleRate);
        silverdaw::log::info("mixdown",
                             "done filePath=" + targetFile.getFullPathName() +
                                 " durationMs=" + juce::String(actualDurationMs, 1) +
                                 " timelineMs=" + juce::String(options.lengthMs, 1) +
                                 " tailSeconds=" + juce::String(clampedTailSeconds, 3) +
                                 " sampleRate=" + juce::String(options.outputSampleRate) +
                                 " bitDepth=" + juce::String(options.bitDepth) +
                                 " peakAmp=" + juce::String(preClampPeakAmplitude, 4) +
                                 " clippedSamples=" + juce::String(clippedSampleCount) +
                                 " outputFrames=" + juce::String(outputFramesWritten));
        broadcastDone(bridge, targetFile, actualDurationMs,
                      analyzing ? &finalLoudness : nullptr,
                      limitedByTruePeak, appliedGainDb,
                      pass2ClippedSamples, pass2PostGainPeakAmp);

        // The file is final and the user-facing dialog is dismissed.
        // Release the busy gate NOW so TRANSPORT_PLAY and the next
        // MIXDOWN_START aren't silently rejected while we tear down
        // the (slow-to-close) per-clip reader chains below. The
        // remaining work is internal bookkeeping with no shared state;
        // BusyGuard's destructor will be a harmless no-op on the
        // already-cleared flag.
        busyFlag.store(false);

        // Now (and only now) drain the per-clip chains. Anything below
        // is invisible to the user — the dialog has already dismissed.
        // Ordered reverse-iteration so each transport stops before its
        // source is destroyed (matches the live engine's teardown
        // ordering for safety even though no readers are background-
        // buffered here).
        const int totalClips = static_cast<int>(clips.size());
        for (auto it = clips.rbegin(); it != clips.rend(); ++it)
        {
            if (auto& cp = *it; cp != nullptr)
            {
                if (cp->transport) cp->transport->stop();
                if (cp->transport) cp->transport->setSource(nullptr);
                if (cp->offsetSource) cp->offsetSource->setWarpProcessor(nullptr);
                cp.reset();
            }
        }
        clips.clear();
        const auto teardownEndMs = juce::Time::getMillisecondCounter();

        silverdaw::log::info(
            "mixdown",
            juce::String("finalize timings padMs=") +
                juce::String(padEndMs       - finalizeStartMs) +
                " writerFlushMs=" + juce::String(writerEndMs   - padEndMs) +
                " atomicReplaceMs=" + juce::String(replaceEndMs - writerEndMs) +
                " visibleFinalizeMs=" + juce::String(replaceEndMs - finalizeStartMs) +
                " backgroundTeardownMs=" + juce::String(teardownEndMs - replaceEndMs) +
                " (clips=" + juce::String(totalClips) + ")");
}

} // namespace silverdaw
