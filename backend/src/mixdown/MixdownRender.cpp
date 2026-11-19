// libsamplerate may leave input unconsumed; preserve leftovers to avoid render drift.

#include "MixdownRender.h"

#include "AudioEngine.h"   // for silverdaw::OffsetSource
#include "AudioConstants.h"
#include "BridgeServer.h"
#include "Log.h"
#include "LoudnessAnalyzer.h"
#include "LamePath.h"
#include "MixdownBroadcast.h"
#include "MixdownDither.h"
#include "MixdownEngine.h"
#include "MixdownExport.h"
#include "MixdownGraph.h"
#include "MixdownNormalize.h"
#include "MixdownRenderPass1.h"
#include "Mp3Export.h"
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

OfflineFileResult renderOfflineFile(const MixdownSnapshot& snapshot, MixdownOptions options,
                                    const RenderProgress& progress, std::atomic<bool>& cancelFlag)
{
        const auto failWith = [](MixdownFailureCode code, const juce::String& message)
        {
            silverdaw::log::warn("mixdown", "fail code=" + juce::String(mixdownFailureCodeToString(code)) +
                                                 " msg=" + message);
            return OfflineFileResult{code, message};
        };

        if (snapshot.tracks.empty())
        {
            return failWith(MixdownFailureCode::Invalid, "No clips to render.");
        }
        if (options.lengthMs <= 0.0)
        {
            return failWith(MixdownFailureCode::Invalid, "Mixdown length must be positive.");
        }
        if (options.outputSampleRate != 44100 && options.outputSampleRate != 48000)
        {
            return failWith(MixdownFailureCode::Invalid,
                     "Unsupported output sample rate " + juce::String(options.outputSampleRate));
        }

        // Shared TPDF dither keeps 16-bit output identical across render paths.
        const bool mp3 = options.format == MixdownOptions::Format::Mp3;
        juce::File lameApp;
        if (mp3)
        {
            lameApp = findLameExecutable();
            if (! lameApp.existsAsFile())
            {
                return failWith(MixdownFailureCode::Invalid,
                         "MP3 encoder (lame.exe) is not bundled with this build. "
                         "See backend/third_party/lame/README.md.");
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
            return failWith(MixdownFailureCode::Invalid,
                     "Loudness analysis requires 44.1 or 48 kHz output.");
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
                return failWith(MixdownFailureCode::Invalid,
                         "Could not start loudness analyzer: " + e);
            }
        }

        progress(0.0, "prepare");

        // Write caches to a sibling temp file so partial entries are never visible.
        const auto targetFile = options.outputFile;
        const auto parentDir = targetFile.getParentDirectory();
        if (!parentDir.exists() && !parentDir.createDirectory())
        {
            return failWith(MixdownFailureCode::Io,
                     "Cannot create output folder: " + parentDir.getFullPathName());
        }
        const auto tmpFile = parentDir.getChildFile(targetFile.getFileName() + ".tmp");
        tmpFile.deleteFile();
        const auto f32TmpFile = parentDir.getChildFile(targetFile.getFileName() + ".f32.tmp");
        f32TmpFile.deleteFile();
        juce::ScopeGuard cleanupFloatStage{[&] { if (normalizing) f32TmpFile.deleteFile(); }};
        std::optional<juce::TemporaryFile> mp3Pcm;
        if (mp3) mp3Pcm.emplace(targetFile.withFileExtension(".wav"));
        const auto& renderedFile = mp3 ? mp3Pcm->getFile() : tmpFile;

        juce::AudioFormatManager formatManager;
        formatManager.registerBasicFormats();

        // JUCE 8 lacks some tag hooks, so FLAC/AIFF metadata is post-processed after encode.
        const juce::File& pass1File = normalizing ? f32TmpFile : renderedFile;
        std::unique_ptr<juce::OutputStream> outStream = std::make_unique<juce::FileOutputStream>(pass1File);
        if (! static_cast<juce::FileOutputStream*>(outStream.get())->openedOk())
        {
            return failWith(MixdownFailureCode::Io,
                     "Cannot open output file for writing: " + pass1File.getFullPathName());
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
                options.format, writerOptions, options.metadata, outStream);
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
            return failWith(MixdownFailureCode::Io,
                     "Failed to create " + fmtName + " writer (bitDepth=" +
                         juce::String(pass1BitDepth) + ", sr=" + juce::String(options.outputSampleRate) + ").");
        }
        if (pass1WantsFloat && ! writer->isFloatingPoint())
        {
            writer.reset();
            pass1File.deleteFile();
            return failWith(MixdownFailureCode::Io,
                     "WAV writer opened in PCM mode when 32-float was requested.");
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
            normalizing, analyzing, rngL, rngR, progress, cancelFlag);
        if (! p1.ok)
        {
            writer.reset();
            pass1File.deleteFile();
            return failWith(p1.code, p1.message);
        }
        // Member order preserves JUCE source lifetimes during teardown.
        auto clips = std::move(p1.clips);
        int64_t outputFramesWritten = p1.outputFramesWritten;
        const double effectiveRenderLengthMs = p1.effectiveRenderLengthMs;
        const double preClampPeakAmplitude = p1.preClampPeakAmplitude;
        const int64_t clippedSampleCount = p1.clippedSampleCount;
        const double clampedTailSeconds = juce::jlimit(0.0, 60.0, options.tailSeconds);

        progress(normalizing ? 45.0 : 90.0,
                          normalizing ? "normalize-pass1"
                                      : (analyzing ? "analyze" : "render"));

        const auto finalizeStartMs = juce::Time::getMillisecondCounter();
        const int64_t totalOutputFrames =
            options.fixedOutputFrames.value_or(static_cast<int64_t>(
                std::round(effectiveRenderLengthMs * options.outputSampleRate / 1000.0)));
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
                    return failWith(MixdownFailureCode::Io, "Failed while writing final silence.");
                }
                remaining -= chunk;
                outputFramesWritten += chunk;
            }
        }
        const auto padEndMs = juce::Time::getMillisecondCounter();
        progress(92.0, "finalize");

        // Closing the writer finalizes container headers before the atomic replace.
        if (!mp3) progress(normalizing ? 45.0 : 95.0, "encode");
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
            progress(normalizing ? 46.0 : 96.0, "analyze");
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
            silverdaw::log::info("mixdown", juce::String("loudness source LUFS=") +
                                                (std::isfinite(sourceLoudness.integratedLufs)
                                                     ? juce::String(sourceLoudness.integratedLufs, 2)
                                                     : juce::String("-inf")) +
                                                " TP=" + juce::String(sourceLoudness.truePeakDbtp, 2) +
                                                " silent=" + (sourceLoudness.silent ? "true" : "false") +
                                                " unmeasurable=" + (sourceLoudness.unmeasurable ? "true" : "false") +
                                                " blocks=" + juce::String(sourceLoudness.gatedBlockCount) +
                                                " appliedGainDb=" + juce::String(appliedGainDb, 3) +
                                                " limited=" + (limitedByTruePeak ? "true" : "false"));
        }

        if (normalizing)
        {
            auto p2 = mixdown_normalize::runNormalizePass2(
                f32TmpFile, renderedFile, options, chosenBitDepth, wantFloatWav,
                appliedGainDb, *analyzer, rngL, rngR, progress, cancelFlag);
            if (! p2.ok)
            {
                return failWith(p2.code, p2.message);
            }
            outputFramesWritten = p2.outputFramesWritten;
            pass2ClippedSamples = p2.clippedSamples;
            pass2PostGainPeakAmp = p2.postGainPeakAmp;
            finalLoudness = p2.finalLoudness;
        }
        if (mp3)
        {
            progress(analyzing && !normalizing ? 96.0 : 95.0, "encode");
            const auto encoded = mixdown_export::encodeMp3(lameApp, renderedFile, tmpFile, options,
                                                            outputFramesWritten, cancelFlag);
            if (encoded.failed())
            {
                tmpFile.deleteFile();
                return failWith(cancelFlag.load() ? MixdownFailureCode::Cancelled : MixdownFailureCode::Encode,
                                encoded.getErrorMessage());
            }
        }

        if (cancelFlag.load())
        {
            tmpFile.deleteFile();
            return failWith(MixdownFailureCode::Cancelled, "Cancelled.");
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
            return failWith(MixdownFailureCode::Io,
                     "Could not finalise output file (rename failed). Path may be open in another app.");
        }
        const auto replaceEndMs = juce::Time::getMillisecondCounter();

        progress(100.0, "finalize");
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
        const int totalClips = static_cast<int>(clips.size());
        // Counted before teardown: the offline render pulls the same WarpProcessor the
        // transport does, but with no deadline, so this is the control for a starvation
        // report from playback. It should stay at zero.
        juce::uint32 warpShortfalls = 0;
        double worstFactor = 0.0;
        int warpedClips = 0;
        for (const auto& cp : clips)
        {
            if (cp == nullptr || cp->warp == nullptr) continue;
            ++warpedClips;
            warpShortfalls += cp->warp->getShortfallCount();
            if (const double factor = cp->warp->getRealtimeFactor(); factor > 0.0)
            {
                if (worstFactor <= 0.0 || factor < worstFactor) worstFactor = factor;
            }
        }
        if (warpedClips > 0 && warpShortfalls > 0)
        {
            // The offline pull has no deadline, so this should never fire. If it does, the
            // shortfall is in the stretcher itself rather than in delivery.
            silverdaw::log::warn("mixdown",
                                 "warp starved offline: clips=" + juce::String(warpedClips)
                                     + " unfilledBlocks="
                                     + juce::String(static_cast<int>(warpShortfalls))
                                     + " slowestRealtimeFactor="
                                     + juce::String(worstFactor, 2));
        }
        for (auto it = clips.rbegin(); it != clips.rend(); ++it)
        {
            if (auto& cp = *it; cp != nullptr)
            {
                // There is no live callback to acknowledge stop(); detach the offline source directly.
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
        return {std::nullopt, metadataWarning, actualDurationMs,
                analyzing ? std::optional{finalLoudness} : std::nullopt, limitedByTruePeak,
                appliedGainDb, pass2ClippedSamples, pass2PostGainPeakAmp};
}

void runMixdownJob(const MixdownSnapshot& snapshot, MixdownOptions options, BridgeServer& bridge,
                   std::atomic<bool>& cancelFlag, std::atomic<bool>& busyFlag)
{
    const auto file = options.outputFile;
    juce::ErasedScopeGuard releaseSlot{[&busyFlag] { busyFlag.store(false); }};
    const auto result = renderOfflineFile(snapshot, std::move(options), [&](double pct, const char* stage) {
        broadcastProgress(bridge, pct, stage);
    }, cancelFlag);
    releaseSlot.reset();
    if (result.failure)
        broadcastFailed(bridge, *result.failure, result.message);
    else
        broadcastDone(bridge, file, result.durationMs, result.loudness ? &*result.loudness : nullptr,
                      result.limitedByTruePeak, result.appliedGainDb, result.postGainClips,
                      result.postGainPeak, result.message);
}

} // namespace silverdaw
