// libsamplerate may leave input unconsumed; preserve leftovers to avoid render drift.

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

using mixdown_export::atomicReplace;
using mixdown_export::createOutputWriter;
using mixdown_export::findLameExecutable;
using mixdown_export::writeAiffTextChunks;
using mixdown_export::writeFlacVorbisComment;

using mixdown_graph::kBlockFrames;
using mixdown_graph::kOutputChannels;

using mixdown_bridge::broadcastDone;
using mixdown_bridge::broadcastFailed;
using mixdown_bridge::broadcastProgress;

using mixdown_dither::Xorshift32;

namespace
{

constexpr int kProgressMinIntervalMs = 50;

} // anonymous namespace


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

        // Shared TPDF dither keeps 16-bit output identical across render paths.
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
        // Loudness normalization uses a measured pass before final gain, limiting, dither, and
        // encode.
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

        // Write caches to a sibling temp file so partial entries are never visible.
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
        const auto f32TmpFile = parentDir.getChildFile(targetFile.getFileName() + ".f32.tmp");
        f32TmpFile.deleteFile();

        juce::AudioFormatManager formatManager;
        formatManager.registerBasicFormats();

        // JUCE 8 lacks some tag hooks, so FLAC/AIFF metadata is post-processed after encode.
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
        // Member order preserves JUCE source lifetimes during teardown.
        auto clips = std::move(p1.clips);
        int64_t outputFramesWritten = p1.outputFramesWritten;
        const double effectiveRenderLengthMs = p1.effectiveRenderLengthMs;
        const double preClampPeakAmplitude = p1.preClampPeakAmplitude;
        const int64_t clippedSampleCount = p1.clippedSampleCount;
        const double clampedTailSeconds = juce::jlimit(0.0, 60.0, options.tailSeconds);

        broadcastProgress(bridge, normalizing ? 45.0 : 90.0,
                          normalizing ? "normalize-pass1"
                                      : (analyzing ? "analyze" : "render"));

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
                if (!writer->writeFromFloatArrays(writePtrs, kOutputChannels, chunk))
                {
                    writer.reset();
                    pass1File.deleteFile();
                    failWith(MixdownFailureCode::Io, "Failed while writing final silence.");
                    return;
                }
                remaining -= chunk;
                outputFramesWritten += chunk;
            }
        }
        const auto padEndMs = juce::Time::getMillisecondCounter();
        broadcastProgress(bridge, 92.0, "finalize");

        // Closing the writer finalizes container headers before the atomic replace.
        broadcastProgress(bridge, normalizing ? 45.0 : 95.0, "encode");
        writer.reset();
        const auto writerEndMs = juce::Time::getMillisecondCounter();

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

            double desiredGainDb = 0.0;
            if (normalizing)
            {
                if (! sourceLoudness.silent && ! sourceLoudness.unmeasurable
                    && std::isfinite(sourceLoudness.integratedLufs))
                {
                    desiredGainDb = options.targetLufs - sourceLoudness.integratedLufs;
                }
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
        }

        if (cancelFlag.load())
        {
            tmpFile.deleteFile();
            failWith(MixdownFailureCode::Cancelled, "Cancelled.");
            return;
        }

        juce::String metadataWarning;
        if (options.format == MixdownOptions::Format::Flac && ! options.metadata.isEmpty()
            && !writeFlacVorbisComment(tmpFile, options.metadata))
        {
            metadataWarning = "Metadata could not be applied; the audio was exported without tags.";
        }
        if (options.format == MixdownOptions::Format::Aiff && ! options.metadata.isEmpty()
            && !writeAiffTextChunks(tmpFile, options.metadata))
        {
            metadataWarning = "Metadata could not be applied; the audio was exported without tags.";
        }

        if (!atomicReplace(tmpFile, targetFile))
        {
            tmpFile.deleteFile();
            failWith(MixdownFailureCode::Io,
                     "Could not finalise output file (rename failed). Path may be open in another app.");
            return;
        }
        const auto replaceEndMs = juce::Time::getMillisecondCounter();

        broadcastProgress(bridge, 100.0, "finalize");
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
                      pass2ClippedSamples, pass2PostGainPeakAmp, metadataWarning);

        busyFlag.store(false);

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
