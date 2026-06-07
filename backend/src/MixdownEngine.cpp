#include "MixdownEngine.h"

#include "AudioEngine.h"   // for silverdaw::OffsetSource
#include "AudioConstants.h"
#include "BridgeServer.h"
#include "BusGraph.h"
#include "Log.h"
#include "LoudnessAnalyzer.h"
#include "MixdownExport.h"
#include "MixdownGraph.h"
#include "MixdownTiming.h"
#include "ProjectState.h"
#include "TrackChain.h"
#include "WarpProcessor.h" // for parseWarpMode + WarpProcessor

#include <algorithm>
#include <cmath>
#include <limits>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>

#include <samplerate.h>

#if JUCE_WINDOWS
#include <windows.h>
#endif

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

namespace silverdaw
{

// Output-format / metadata writers now live in MixdownExport.cpp. Hoist them
// in so the render call sites below read unqualified.
using mixdown_export::atomicReplace;
using mixdown_export::buildMp3MetadataMap;
using mixdown_export::buildWavMetadataMap;
using mixdown_export::findLameExecutable;
using mixdown_export::lameQualityIndexForCbr;
using mixdown_export::writeAiffTextChunks;
using mixdown_export::writeFlacVorbisComment;

// Offline source-graph domain now lives in MixdownGraph.{h,cpp}. Hoist the
// pieces the render loop touches so its call sites read unqualified.
using mixdown_graph::buildOfflineClip;
using mixdown_graph::FinalResampler;
using mixdown_graph::kBlockFrames;
using mixdown_graph::kOutputChannels;
using mixdown_graph::OfflineClip;

const char* mixdownFailureCodeToString(MixdownFailureCode code) noexcept
{
    switch (code)
    {
        case MixdownFailureCode::Cancelled: return "cancelled";
        case MixdownFailureCode::Io:        return "io";
        case MixdownFailureCode::Decode:    return "decode";
        case MixdownFailureCode::Encode:    return "encode";
        case MixdownFailureCode::Invalid:   return "invalid";
    }
    return "invalid";
}

namespace
{

// Min spacing between progress envelopes so the bridge isn't flooded.
constexpr int kProgressMinIntervalMs = 50;

void broadcastProgress(BridgeServer& bridge, double percent, const char* stage)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("percent", juce::jlimit(0.0, 100.0, percent));
    obj->setProperty("stage", juce::String(stage));
    bridge.broadcast("MIXDOWN_PROGRESS", juce::var(obj));
}

void broadcastDone(BridgeServer& bridge,
                   const juce::File& outputFile,
                   double durationMs,
                   const LoudnessAnalyzer::Result* loudness,
                   bool limitedByTruePeak,
                   double appliedGainDb,
                   int64_t pass2PostGainClipCount,
                   double pass2PostGainPeakAmp)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("filePath", outputFile.getFullPathName());
    obj->setProperty("durationMs", durationMs);
    if (loudness != nullptr)
    {
        auto* l = new juce::DynamicObject();
        // BS.1770: integrated LUFS may be -Infinity for silent
        // programmes. JSON cannot represent ±Infinity, so emit
        // explicit nulls and let the UI render "—".
        if (loudness->silent || ! std::isfinite(loudness->integratedLufs))
            l->setProperty("integratedLufs", juce::var());
        else
            l->setProperty("integratedLufs", loudness->integratedLufs);
        if (! std::isfinite(loudness->truePeakDbtp))
            l->setProperty("truePeakDbtp", juce::var());
        else
            l->setProperty("truePeakDbtp", loudness->truePeakDbtp);
        l->setProperty("silent", loudness->silent);
        l->setProperty("unmeasurable", loudness->unmeasurable);
        l->setProperty("gatedBlockCount", static_cast<int>(loudness->gatedBlockCount));
        l->setProperty("appliedGainDb", appliedGainDb);
        l->setProperty("limitedByTruePeak", limitedByTruePeak);
        l->setProperty("pass2ClippedSamples", static_cast<int>(juce::jlimit<int64_t>(0,
            std::numeric_limits<int>::max(), pass2PostGainClipCount)));
        l->setProperty("pass2PostGainPeak", pass2PostGainPeakAmp);
        obj->setProperty("loudness", juce::var(l));
    }
    bridge.broadcast("MIXDOWN_DONE", juce::var(obj));
}

void broadcastFailed(BridgeServer& bridge, MixdownFailureCode code, const juce::String& error)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("code", juce::String(mixdownFailureCodeToString(code)));
    obj->setProperty("error", error);
    bridge.broadcast("MIXDOWN_FAILED", juce::var(obj));
}
} // anonymous namespace

// ─────────────────────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────────────────────

void renderMixdownAsync(MixdownSnapshot snapshot,
                        MixdownOptions options,
                        juce::ThreadPool& pool,
                        BridgeServer& bridge,
                        std::atomic<bool>& cancelFlag,
                        std::atomic<bool>& busyFlag)
{
    busyFlag.store(true);
    cancelFlag.store(false);

    pool.addJob([snapshot = std::move(snapshot),
                 options = std::move(options),
                 &bridge,
                 &cancelFlag,
                 &busyFlag]() mutable
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
        else if (options.format == MixdownOptions::Format::Wav)
        {
            juce::WavAudioFormat wav;
            auto wavOpts = writerOptions
                               .withMetadataValues(buildWavMetadataMap(options.metadata));
            writer = wav.createWriterFor(outStream, wavOpts);
        }
        else if (options.format == MixdownOptions::Format::Flac)
        {
            // JUCE 8's FLAC writer ignores withMetadataValues; we
            // post-process the file to add a VORBIS_COMMENT block once
            // the encoder has finished (see writeFlacVorbisComment()).
            juce::FlacAudioFormat flac;
            writer = flac.createWriterFor(outStream, writerOptions);
        }
        else if (options.format == MixdownOptions::Format::Aiff)
        {
            // JUCE's AIFF writer also ignores metadata; we patch text
            // chunks into the FORM container post-encode (see
            // writeAiffTextChunks()).
            juce::AiffAudioFormat aiff;
            writer = aiff.createWriterFor(outStream, writerOptions);
        }
        else if (options.format == MixdownOptions::Format::Mp3)
        {
            juce::LAMEEncoderAudioFormat lame(lameApp);
            auto lameOpts = writerOptions
                                .withBitsPerSample(16)
                                .withSampleFormat(
                                    juce::AudioFormatWriterOptions::SampleFormat::integral)
                                .withQualityOptionIndex(lameQualityIndexForCbr(options.bitrateKbps))
                                .withMetadataValues(buildMp3MetadataMap(options.metadata));
            writer = lame.createWriterFor(outStream, lameOpts);
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

        // Build the per-clip offline chains. We pre-build every clip because
        // even large projects have tens of clips, not thousands — keeping
        // their readers open for the duration of the render is well within
        // OS handle limits and avoids stop-the-world reader construction
        // mid-render.
        std::vector<std::unique_ptr<OfflineClip>> clips;
        clips.reserve(snapshot.tracks.size() * 8);
        for (const auto& track : snapshot.tracks)
        {
            for (const auto& clip : track.clips)
            {
                if (cancelFlag.load())
                {
                    failWith(MixdownFailureCode::Cancelled, "Cancelled.");
                    return;
                }
                juce::String err;
                auto built = buildOfflineClip(clip, track.id, track.gain,
                                              snapshot.projectSampleRate,
                                              formatManager, err);
                if (built == nullptr)
                {
                    failWith(MixdownFailureCode::Decode,
                             "Could not open source for clip " + clip.id +
                                 (err.isNotEmpty() ? juce::String(": ") + err : juce::String("")));
                    return;
                }
                clips.push_back(std::move(built));
            }
        }

        // Canonical project bus (Phase 5 step 1d). Mirrors the live
        // engine's topology: one `BusGraph::TrackRuntime` per UI track,
        // each summing its clips through the canonical `TrackChain`
        // before they reach the master bus. Declared AFTER `clips` so
        // destruction order is `busGraph` first → its TrackRuntimes
        // release the `ClipSummingSource` pointers → THEN `clips` (and
        // their owned transports) destruct. Without this ordering the
        // TrackRuntimes' inner mixers would briefly hold dangling
        // pointers during teardown.
        silverdaw::BusGraph busGraph;
        busGraph.prepareToPlay(kBlockFrames, static_cast<double>(snapshot.projectSampleRate));
        for (auto& cp : clips)
        {
            busGraph.attachClip(cp->trackId, cp->id, cp->summingSource.get());
        }

        // Phase 5 — push per-track Tone EQ onto the offline bus. Snapped
        // so the very first rendered block is steady-state (the export
        // must never ramp up from flat). Pushed for every track in the
        // snapshot, including any whose tone is default (identity), which
        // is a cheap no-op in the chain.
        for (const auto& trackSnap : snapshot.tracks)
        {
            busGraph.setTrackTone(trackSnap.id, trackSnap.toneBassDb, trackSnap.toneMidDb,
                                  trackSnap.toneTrebleDb, trackSnap.toneLowCut,
                                  trackSnap.toneHighCut, /*snap*/ true);
            busGraph.setTrackLeveler(trackSnap.id, trackSnap.levelerAmount, /*snap*/ true);
            busGraph.setTrackSends(trackSnap.id, trackSnap.reverbSend, trackSnap.delaySend);
            busGraph.setTrackPan(trackSnap.id, trackSnap.pan);
        }

        // Phase 5 — push the project-shared Reverb / Delay onto the offline
        // bus. Snapped and with the delay time applied immediately so the
        // first rendered block is steady-state. The delay time resolves
        // via the same helper the live engine uses (§7.9.6 parity).
        busGraph.setProjectReverb(snapshot.reverbSize, snapshot.reverbDecay, snapshot.reverbTone,
                                  snapshot.reverbMix, /*snap*/ true);
        busGraph.setProjectDelay(silverdaw::delayNoteToMs(snapshot.delayNoteValue, snapshot.bpm),
                                 snapshot.delayFeedback, snapshot.delayTone, snapshot.delayMix,
                                 /*snap*/ true, /*applyTimeNow*/ true);
        FinalResampler finalResampler(snapshot.projectSampleRate, options.outputSampleRate);
        if (!finalResampler.ok())
        {
            failWith(MixdownFailureCode::Invalid,
                     juce::String("Cannot init output resampler: ") + finalResampler.error());
            return;
        }

        const double projectFramesPerMs = snapshot.projectSampleRate / 1000.0;
        int64_t totalProjectFrames =
            static_cast<int64_t>(std::round(options.lengthMs * projectFramesPerMs));
        // Extend the render window by the worst-case clip tail so any
        // per-clip processor that adds trailing decay (reverb today =
        // 0; reverb later = e.g. 4 s) gets fully drained into the
        // mix. Without this the export would truncate the tail at
        // the timeline length even though we have data still in the
        // processor's internal buffers waiting to come out.
        int64_t maxTailFrames = 0;
        for (const auto& cp : clips)
        {
            maxTailFrames = std::max(maxTailFrames, cp->tailFrames);
        }
        // Project-shared FX tail budget (§7.10 tail-render policy). The
        // shared Reverb + Delay can ring out past the last clip's end, so we
        // extend the render window by their fail-safe cap and break early
        // (below) once both have actually decayed. Per §7.10 the two FX
        // run in PARALLEL, so the absolute ceiling is the MAX of the
        // per-FX caps (Reverb 8 s, Delay 4 s), not their sum. The real
        // cutoff is detector-driven (`busGraph.sharedFxTerminated()`),
        // with this value only as the hard fail-safe.
        const int64_t sharedFxMaxTailFrames = static_cast<int64_t>(
            std::ceil(8.0 * static_cast<double>(snapshot.projectSampleRate)));
        // Additive user-controlled silence tail, clamped sensibly by
        // the dispatch handler (0..60 s). Lets reverb/delay clips
        // ring out past the timeline end even when no processor-
        // declared tail exists yet. We add it on top of the per-
        // clip processor tail because the user is asking for that
        // many extra seconds AFTER all processors have decayed.
        const double clampedTailSeconds = juce::jlimit(0.0, 60.0, options.tailSeconds);
        const int64_t userTailFrames = static_cast<int64_t>(
            std::round(clampedTailSeconds * static_cast<double>(snapshot.projectSampleRate)));
        totalProjectFrames += maxTailFrames + sharedFxMaxTailFrames + userTailFrames;
        // Guaranteed-minimum render length: the timeline, the worst-case
        // per-clip tail and the user-requested trailing silence are always
        // rendered. The shared-FX cap on top is only consumed while the FX
        // is still ringing — once `busGraph.sharedFxTerminated()` and we
        // have passed this minimum, the loop breaks early (so a project
        // with no/inactive shared FX exports at exactly the pre-step-7
        // length, with bit-identical content).
        const int64_t minRenderFrames = totalProjectFrames - sharedFxMaxTailFrames;
        int64_t projectFramesRendered = 0;
        int64_t outputFramesWritten = 0;
        double peakAmplitude = 0.0;
        double preClampPeakAmplitude = 0.0;
        int64_t clippedSampleCount = 0;
        int blockIndex = 0;
        int64_t lastProgressMs = juce::Time::getMillisecondCounter();
        juce::String writerError;

        // Pre-allocated buffers. Reused every block to avoid per-block
        // allocation; sized for kOutputChannels stereo at kBlockFrames.
        juce::AudioBuffer<float> mixBus(kOutputChannels, kBlockFrames);
        std::vector<float> mixInterleaved(static_cast<size_t>(kBlockFrames) * 2);

        // TPDF dither state. Active only when the target file is a
        // 16-bit integer container (WAV-16 or FLAC-16). For 24-bit
        // the noise floor is well below audibility and dither is
        // skipped by default; for 32-float there's no quantisation
        // step at all so dither would be pure added noise.
        //
        // Implementation: per-channel xorshift32 PRNG, two
        // independent uniform draws per sample summed to form a
        // triangular PDF of peak amplitude ±1 LSB at 16-bit
        // (= ±1/32768 in normalised float). Seeded from juce::Random
        // so successive renders aren't bit-identical. Cheap enough
        // (~6 ns/sample) to leave on by default.
        // In Normalize pass-1 we always write a 32-float intermediate
        // (no quantisation) so dither would be pure added noise —
        // gate it off. Pass 2 will dither into the final 16-bit
        // container if appropriate. For Off/AnalyzeOnly we use the
        // existing 16-bit-only TPDF policy.
        const bool ditherActive = ! normalizing
                                  && options.dither
                                  && options.bitDepth == 16
                                  && ! writer->isFloatingPoint();
        constexpr float kLsb16f = 1.0f / 32768.0f;
        struct Xorshift32 { uint32_t state; };
        const auto nextUniform = [](Xorshift32& s) -> float
        {
            uint32_t x = s.state;
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            s.state = x ? x : 1u;
            return static_cast<float>(s.state) * (1.0f / 4294967296.0f);
        };
        juce::Random seedGen;
        Xorshift32 rngL { static_cast<uint32_t>(seedGen.nextInt(juce::Range<int>(1, INT_MAX))) };
        Xorshift32 rngR { static_cast<uint32_t>(seedGen.nextInt(juce::Range<int>(1, INT_MAX))) };

        // Writer-callback used by FinalResampler. Captures `writer`, the
        // total written counter, peakAmplitude, and writerError so we can
        // unwind cleanly on IO failure mid-stream.
        const auto writeStereo = [&](const float* interleaved, int frames) -> bool
        {
            if (frames <= 0) return true;
            // Feed the loudness analyzer with the pre-dither,
            // post-final-resample stereo program. This is the
            // exact audio that will land in the output file (modulo
            // the small dither contribution which we deliberately
            // exclude from the measurement).
            if (analyzer)
            {
                // Deinterleave into temporary channel pointers for
                // the analyzer's planar API. Stack-buffered to stay
                // RT-clean even though we're on a worker.
                std::vector<float> aL(static_cast<size_t>(frames));
                std::vector<float> aR(static_cast<size_t>(frames));
                for (int i = 0; i < frames; ++i)
                {
                    aL[static_cast<size_t>(i)] = interleaved[static_cast<size_t>(i) * 2 + 0];
                    aR[static_cast<size_t>(i)] = interleaved[static_cast<size_t>(i) * 2 + 1];
                }
                const float* ch[2] = { aL.data(), aR.data() };
                analyzer->process(ch, 2, frames);
            }
            // Deinterleave for AudioFormatWriter::writeFromFloatArrays.
            std::vector<float> outL(static_cast<size_t>(frames));
            std::vector<float> outR(static_cast<size_t>(frames));
            if (ditherActive)
            {
                for (int i = 0; i < frames; ++i)
                {
                    // TPDF = (U1 + U2 - 1) * LSB, U1,U2 ∈ [0,1).
                    // Sum of two uniforms gives a triangular PDF.
                    // Independent draws per channel decorrelate the
                    // dither noise between L and R, avoiding a
                    // mid-summed mono image of the dither.
                    const float dL = (nextUniform(rngL) + nextUniform(rngL) - 1.0f) * kLsb16f;
                    const float dR = (nextUniform(rngR) + nextUniform(rngR) - 1.0f) * kLsb16f;
                    outL[static_cast<size_t>(i)] = interleaved[static_cast<size_t>(i) * 2 + 0] + dL;
                    outR[static_cast<size_t>(i)] = interleaved[static_cast<size_t>(i) * 2 + 1] + dR;
                }
            }
            else
            {
                for (int i = 0; i < frames; ++i)
                {
                    outL[static_cast<size_t>(i)] = interleaved[static_cast<size_t>(i) * 2 + 0];
                    outR[static_cast<size_t>(i)] = interleaved[static_cast<size_t>(i) * 2 + 1];
                }
            }
            const float* writePtrs[kOutputChannels] = {outL.data(), outR.data()};
            if (!writer->writeFromFloatArrays(writePtrs, kOutputChannels, frames))
            {
                writerError = "Writer failed mid-stream.";
                return false;
            }
            outputFramesWritten += frames;
            return true;
        };

        // Main pump loop. Each iteration: pull a block from every active
        // clip's transport, sum into the mix bus, clip/peak-meter, then
        // hand off to FinalResampler → writer.
        while (projectFramesRendered < totalProjectFrames)
        {
            // Suppress denormal-float CPU stalls inside this block.
            // Once per-clip reverbs/EQs land downstream they will
            // routinely produce subnormals as they ring down; on
            // x86 those can be 20–100× slower than normal floats
            // and would dominate the offline render time.
            const juce::ScopedNoDenormals scopedNoDenormals;
            if (cancelFlag.load())
            {
                pass1File.deleteFile();
                failWith(MixdownFailureCode::Cancelled, "Cancelled.");
                return;
            }
            const int blockFrames = static_cast<int>(
                std::min<int64_t>(kBlockFrames, totalProjectFrames - projectFramesRendered));

            mixBus.clear(0, blockFrames);
            float* mixL = mixBus.getWritePointer(0);
            float* mixR = mixBus.getWritePointer(1);

            // Clip retirement (Phase 5 step 1d, mirrors the pre-1d
            // skip-pull logic). Walk the flat clip list once per
            // block; for any clip whose timeline window + processor
            // tail has fully elapsed, detach it from the BusGraph so
            // the audio path stops pulling its transport. The flat
            // walk is cheap (project clip counts are O(10²) at the
            // top end) and the per-detach `juce::CriticalSection`
            // acquisition is uncontended (mixdown is single-threaded).
            for (auto& cp : clips)
            {
                if (cp->retired) continue;
                if (projectFramesRendered >= cp->timelineEndFrames + cp->tailFrames)
                {
                    busGraph.detachClip(cp->id, cp->summingSource.get());
                    cp->retired = true;
                }
            }

            // Canonical pump: BusGraph sums every active TrackRuntime
            // (each summing its clips through the TrackChain) directly
            // into the mix bus. Identical pull discipline to the live
            // engine — same `getNextAudioBlock(info)` entry point,
            // same internal block partitioning, same per-track chain
            // invocation order.
            juce::AudioSourceChannelInfo busInfo(&mixBus, 0, blockFrames);
            busGraph.getNextAudioBlock(busInfo);

            // Master volume: applied to the summed mix bus BEFORE peak
            // metering, loudness analysis, dither and the final
            // resample so the rendered file matches what the user
            // hears live (where `AudioEngine::setMasterGain` applies
            // the same scalar through `AudioSourcePlayer::setGain`).
            if (! juce::approximatelyEqual(snapshot.masterGain, 1.0F))
            {
                mixBus.applyGain(0, blockFrames, snapshot.masterGain);
            }

            // Peak-meter without clipping. The live engine has NO
            // master limiter / hard clipper before the device, so
            // applying one here would systematically attenuate
            // exports of dense mixes vs what the user hears live.
            // We still count samples that would have clipped so the
            // diagnostic logs can flag inter-sample / over-0 dB
            // material in the render.
            double blockPeakL = 0.0;
            double blockPeakR = 0.0;
            for (int i = 0; i < blockFrames; ++i)
            {
                const double absL = std::abs(static_cast<double>(mixL[i]));
                const double absR = std::abs(static_cast<double>(mixR[i]));
                blockPeakL = juce::jmax(blockPeakL, absL);
                blockPeakR = juce::jmax(blockPeakR, absR);
                if (absL > 1.0 || absR > 1.0) ++clippedSampleCount;
                mixInterleaved[static_cast<size_t>(i) * 2 + 0] = mixL[i];
                mixInterleaved[static_cast<size_t>(i) * 2 + 1] = mixR[i];
            }
            const double blockPeak = juce::jmax(blockPeakL, blockPeakR);
            preClampPeakAmplitude = juce::jmax(preClampPeakAmplitude, blockPeak);
            peakAmplitude = preClampPeakAmplitude; // same now that we don't clip
            // Sparse per-block peak telemetry: every ~5 s of project
            // time at projectSampleRate. Cheap and gives a good
            // amplitude trace across the render.
            const int peakLogStride = juce::jmax(1,
                static_cast<int>(static_cast<double>(snapshot.projectSampleRate) * 5.0
                                 / static_cast<double>(kBlockFrames)));
            if ((blockIndex % peakLogStride) == 0)
            {
                silverdaw::log::debug(
                    "mixdown",
                    "block=" + juce::String(blockIndex) +
                        " projectFrame=" + juce::String(projectFramesRendered) +
                        " peakL=" + juce::String(blockPeakL, 4) +
                        " peakR=" + juce::String(blockPeakR, 4));
            }
            ++blockIndex;

            // Stream every block as non-final; the resampler is flushed
            // once after the loop (below) so the same drain path serves
            // both the natural end and the early FX-terminated break.
            if (!finalResampler.push(mixInterleaved.data(), blockFrames,
                                     /*endOfInput*/ false, writeStereo))
            {
                pass1File.deleteFile();
                if (writerError.isNotEmpty())
                {
                    failWith(MixdownFailureCode::Io, writerError);
                }
                else
                {
                    failWith(MixdownFailureCode::Invalid,
                             juce::String("Final resample failed: ") +
                                 (finalResampler.error() ? finalResampler.error() : "unknown"));
                }
                return;
            }

            projectFramesRendered += blockFrames;

            // Early termination: once we have rendered the guaranteed
            // minimum (timeline + clip tail + user silence) AND both shared
            // FX tails have decayed, stop — don't burn the full fail-safe
            // cap rendering inaudible decay (or trailing silence for a
            // project with inactive FX).
            if (projectFramesRendered >= minRenderFrames && busGraph.sharedFxTerminated())
            {
                break;
            }

            const auto now = juce::Time::getMillisecondCounter();
            if (now - lastProgressMs >= kProgressMinIntervalMs)
            {
                // Progress budget:
                //   - Off / AnalyzeOnly: render owns 0–90%.
                //   - Normalize:        pass 1 owns 0–45%, pass 2 owns 45–90%.
                // Finalize keeps its 10% headroom in either case.
                const double renderShare = normalizing ? 45.0 : 90.0;
                const double pct = (static_cast<double>(projectFramesRendered)
                                    / static_cast<double>(juce::jmax<int64_t>(1, totalProjectFrames)))
                                   * renderShare;
                broadcastProgress(bridge, pct,
                                  normalizing ? "normalize-pass1"
                                              : (analyzing ? "analyze" : "render"));
                lastProgressMs = now;
            }
        }

        // Flush the final resampler exactly once (0-frame, end-of-input)
        // so any samples buffered inside libsamplerate are drained for
        // both the natural-end and early-break exit paths. Pass-through
        // (no resample) treats this as a harmless 0-frame write.
        if (!finalResampler.push(mixInterleaved.data(), 0, /*endOfInput*/ true, writeStereo))
        {
            pass1File.deleteFile();
            if (writerError.isNotEmpty())
            {
                failWith(MixdownFailureCode::Io, writerError);
            }
            else
            {
                failWith(MixdownFailureCode::Invalid,
                         juce::String("Final resample flush failed: ") +
                             (finalResampler.error() ? finalResampler.error() : "unknown"));
            }
            return;
        }

        // Actual rendered length (ms) — computed from the frames we really
        // rendered, which may be shorter than the upper-bound
        // `totalProjectFrames` when the FX-terminated early break fired.
        // Drives the pad-to-length safety net and (via outputFramesWritten)
        // the reported duration.
        const double effectiveRenderLengthMs =
            static_cast<double>(projectFramesRendered) / projectFramesPerMs;

        // Tear down the BusGraph BEFORE we start padding / finalizing
        // so any per-runtime release of DSP state happens while the
        // clip transports it still references are still alive. This
        // mirrors `AudioEngine::shutdown` discipline (`topMixer
        // .removeAllInputs(); busGraph.clear(); tracks.clear();`).
        // Stack unwind would also do this safely, but doing it
        // explicitly avoids holding inputs across the pad/finalize
        // path and makes the lifetime contract obvious to the next
        // reader.
        busGraph.clear();

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
            // Open a reader on the f32 intermediate. Bytes are
            // already on disk after the pass-1 writer.reset().
            juce::AudioFormatManager fmtMgr;
            fmtMgr.registerBasicFormats();
            std::unique_ptr<juce::AudioFormatReader> p2Reader(
                fmtMgr.createReaderFor(f32TmpFile));
            if (p2Reader == nullptr)
            {
                f32TmpFile.deleteFile();
                failWith(MixdownFailureCode::Io,
                         "Pass 2: could not open intermediate file for read-back.");
                return;
            }

            // Open the user-chosen final writer on `tmpFile`.
            std::unique_ptr<juce::OutputStream> p2Stream =
                std::make_unique<juce::FileOutputStream>(tmpFile);
            if (! static_cast<juce::FileOutputStream*>(p2Stream.get())->openedOk())
            {
                p2Reader.reset();
                f32TmpFile.deleteFile();
                failWith(MixdownFailureCode::Io,
                         "Pass 2: cannot open output for writing: " + tmpFile.getFullPathName());
                return;
            }
            auto p2Opts = juce::AudioFormatWriterOptions{}
                              .withSampleRate(static_cast<double>(options.outputSampleRate))
                              .withNumChannels(kOutputChannels)
                              .withBitsPerSample(chosenBitDepth)
                              .withSampleFormat(wantFloatWav
                                                    ? juce::AudioFormatWriterOptions::SampleFormat::floatingPoint
                                                    : juce::AudioFormatWriterOptions::SampleFormat::integral);
            std::unique_ptr<juce::AudioFormatWriter> p2Writer;
            if (options.format == MixdownOptions::Format::Wav)
            {
                juce::WavAudioFormat wav;
                auto wavOpts = p2Opts.withMetadataValues(buildWavMetadataMap(options.metadata));
                p2Writer = wav.createWriterFor(p2Stream, wavOpts);
            }
            else if (options.format == MixdownOptions::Format::Flac)
            {
                // FLAC tags injected post-encode via writeFlacVorbisComment().
                juce::FlacAudioFormat flac;
                p2Writer = flac.createWriterFor(p2Stream, p2Opts);
            }
            else if (options.format == MixdownOptions::Format::Aiff)
            {
                // AIFF tags injected post-encode via writeAiffTextChunks().
                juce::AiffAudioFormat aiff;
                p2Writer = aiff.createWriterFor(p2Stream, p2Opts);
            }
            else if (options.format == MixdownOptions::Format::Mp3)
            {
                juce::LAMEEncoderAudioFormat lame(lameApp);
                auto lameOpts = p2Opts
                                    .withBitsPerSample(16)
                                    .withSampleFormat(
                                        juce::AudioFormatWriterOptions::SampleFormat::integral)
                                    .withQualityOptionIndex(
                                        lameQualityIndexForCbr(options.bitrateKbps))
                                    .withMetadataValues(
                                        buildMp3MetadataMap(options.metadata));
                p2Writer = lame.createWriterFor(p2Stream, lameOpts);
            }
            if (p2Writer == nullptr)
            {
                p2Stream.reset();
                tmpFile.deleteFile();
                f32TmpFile.deleteFile();
                failWith(MixdownFailureCode::Io,
                         juce::String("Pass 2: failed to create final writer (bitDepth=")
                             + juce::String(chosenBitDepth) + ").");
                return;
            }
            const bool p2DitherActive = options.dither
                                        && chosenBitDepth == 16
                                        && ! p2Writer->isFloatingPoint();

            // Linear gain factor for pass 2's per-sample multiply.
            const float linGain = static_cast<float>(std::pow(10.0, appliedGainDb / 20.0));

            // Stream the intermediate in kBlockFrames chunks.
            juce::AudioBuffer<float> p2Buf(kOutputChannels, kBlockFrames);
            const juce::int64 totalP2Frames = p2Reader->lengthInSamples;
            juce::int64 p2Pos = 0;
            int64_t p2OutputFramesWritten = 0;
            int64_t p2LastProgressMs = juce::Time::getMillisecondCounter();
            while (p2Pos < totalP2Frames)
            {
                if (cancelFlag.load())
                {
                    p2Writer.reset();
                    tmpFile.deleteFile();
                    f32TmpFile.deleteFile();
                    failWith(MixdownFailureCode::Cancelled, "Cancelled.");
                    return;
                }
                const int chunk = static_cast<int>(
                    std::min<juce::int64>(kBlockFrames, totalP2Frames - p2Pos));
                p2Buf.clear(0, chunk);
                if (! p2Reader->read(&p2Buf, 0, chunk, p2Pos, true, true))
                {
                    p2Writer.reset();
                    tmpFile.deleteFile();
                    f32TmpFile.deleteFile();
                    failWith(MixdownFailureCode::Io, "Pass 2: read failure.");
                    return;
                }

                // Apply gain + track post-gain peak and clip count.
                // Clip count vs the integer ceiling matters when the
                // analytical TP_final exceeds 0 dBFS; we surface it
                // as a separate metric in the loudness report.
                float* pL = p2Buf.getWritePointer(0);
                float* pR = p2Buf.getWritePointer(1);
                for (int i = 0; i < chunk; ++i)
                {
                    pL[i] *= linGain;
                    pR[i] *= linGain;
                    const float aL = std::abs(pL[i]);
                    const float aR = std::abs(pR[i]);
                    const float maxA = juce::jmax(aL, aR);
                    if (maxA > pass2PostGainPeakAmp)
                        pass2PostGainPeakAmp = maxA;
                    if (aL > 1.0F || aR > 1.0F) ++pass2ClippedSamples;
                }

                if (p2DitherActive)
                {
                    for (int i = 0; i < chunk; ++i)
                    {
                        const float dL = (nextUniform(rngL) + nextUniform(rngL) - 1.0f) * kLsb16f;
                        const float dR = (nextUniform(rngR) + nextUniform(rngR) - 1.0f) * kLsb16f;
                        pL[i] += dL;
                        pR[i] += dR;
                    }
                }
                const float* writePtrs[kOutputChannels] = { pL, pR };
                if (! p2Writer->writeFromFloatArrays(writePtrs, kOutputChannels, chunk))
                {
                    p2Writer.reset();
                    tmpFile.deleteFile();
                    f32TmpFile.deleteFile();
                    failWith(MixdownFailureCode::Io, "Pass 2: writer failed mid-stream.");
                    return;
                }
                p2Pos += chunk;
                p2OutputFramesWritten += chunk;

                const auto now = juce::Time::getMillisecondCounter();
                if (now - p2LastProgressMs >= kProgressMinIntervalMs)
                {
                    const double pct = 46.0 + (static_cast<double>(p2Pos)
                                               / static_cast<double>(juce::jmax<juce::int64>(1, totalP2Frames)))
                                               * 44.0;
                    broadcastProgress(bridge, pct, "normalize-pass2");
                    p2LastProgressMs = now;
                }
            }
            broadcastProgress(bridge, 90.0, "normalize-pass2");
            p2Writer.reset();
            // The final on-disk file length is what pass 2 wrote.
            outputFramesWritten = p2OutputFramesWritten;
            // Recompute the analytical final loudness with the gain
            // that was actually applied.
            finalLoudness = analyzer->computeForLinearGainDb(appliedGainDb);

            // Intermediate is consumed; drop it before the user's
            // file is committed so a crash after this point doesn't
            // leak the sidecar.
            f32TmpFile.deleteFile();
            broadcastProgress(bridge, 92.0, "finalize");
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
    });
}

} // namespace silverdaw
