#include "MixdownRenderPass1.h"

#include "BusGraph.h"
#include "Log.h"
#include "MixdownBroadcast.h"
#include "SharedFx.h"  // delayNoteToMs

#include <algorithm>
#include <cmath>
#include <climits>
#include <vector>

#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw::mixdown_render_pass1
{

using mixdown_bridge::broadcastProgress;
using mixdown_dither::kLsb16f;
using mixdown_dither::nextUniform;
using mixdown_graph::buildOfflineClip;
using mixdown_graph::FinalResampler;
using mixdown_graph::kBlockFrames;
using mixdown_graph::kOutputChannels;
using mixdown_graph::OfflineClip;

namespace
{
constexpr int kProgressMinIntervalMs = 50;

Pass1Result fail(MixdownFailureCode code, const juce::String& message)
{
    Pass1Result r;
    r.ok = false;
    r.code = code;
    r.message = message;
    return r;
}
} // anonymous namespace

Pass1Result runPass1(const MixdownSnapshot& snapshot,
                     const MixdownOptions& options,
                     juce::AudioFormatManager& formatManager,
                     juce::AudioFormatWriter& writer,
                     LoudnessAnalyzer* analyzer,
                     bool normalizing,
                     bool analyzing,
                     const juce::File& pass1File,
                     mixdown_dither::Xorshift32& rngL,
                     mixdown_dither::Xorshift32& rngR,
                     BridgeServer& bridge,
                     std::atomic<bool>& cancelFlag)
{
    std::vector<std::unique_ptr<OfflineClip>> clips;
    clips.reserve(snapshot.tracks.size() * 8);
    for (const auto& track : snapshot.tracks)
    {
        for (const auto& clip : track.clips)
        {
            if (cancelFlag.load())
                return fail(MixdownFailureCode::Cancelled, "Cancelled.");
            juce::String err;
            auto built = buildOfflineClip(clip, track.id, track.gain,
                                          snapshot.projectSampleRate,
                                          formatManager, err);
            if (built == nullptr)
                return fail(MixdownFailureCode::Decode,
                            "Could not open source for clip " + clip.id +
                                (err.isNotEmpty() ? juce::String(": ") + err : juce::String("")));
            clips.push_back(std::move(built));
        }
    }

    // Snapshot live per-track parameters so offline render stays in parity with playback.
    silverdaw::BusGraph busGraph;
    busGraph.prepareToPlay(kBlockFrames, static_cast<double>(snapshot.projectSampleRate));
    for (auto& cp : clips)
    {
        busGraph.attachClip(cp->trackId, cp->id, cp->summingSource.get());
    }

    for (const auto& trackSnap : snapshot.tracks)
    {
        busGraph.setTrackTone(trackSnap.id, trackSnap.toneBassDb, trackSnap.toneMidDb,
                              trackSnap.toneTrebleDb, trackSnap.toneLowCut,
                              trackSnap.toneHighCut, /*snap*/ true);
        busGraph.setTrackLeveler(trackSnap.id, trackSnap.levelerAmount, /*snap*/ true);
        busGraph.setTrackSends(trackSnap.id, trackSnap.reverbSend, trackSnap.delaySend);
        busGraph.setTrackPan(trackSnap.id, trackSnap.pan);
    }

    busGraph.setProjectReverb(snapshot.reverbSize, snapshot.reverbDecay, snapshot.reverbTone,
                              snapshot.reverbMix, /*snap*/ true);
    busGraph.setProjectDelay(silverdaw::delayNoteToMs(snapshot.delayNoteValue, snapshot.bpm),
                             snapshot.delayFeedback, snapshot.delayTone, snapshot.delayMix,
                             /*snap*/ true, /*applyTimeNow*/ true);
    FinalResampler finalResampler(snapshot.projectSampleRate, options.outputSampleRate);
    if (!finalResampler.ok())
        return fail(MixdownFailureCode::Invalid,
                    juce::String("Cannot init output resampler: ") + finalResampler.error());

    const double projectFramesPerMs = snapshot.projectSampleRate / 1000.0;
    int64_t totalProjectFrames =
        static_cast<int64_t>(std::round(options.lengthMs * projectFramesPerMs));
    int64_t maxTailFrames = 0;
    for (const auto& cp : clips)
    {
        maxTailFrames = std::max(maxTailFrames, cp->tailFrames);
    }
    const int64_t sharedFxMaxTailFrames = static_cast<int64_t>(
        std::ceil(8.0 * static_cast<double>(snapshot.projectSampleRate)));
    const double clampedTailSeconds = juce::jlimit(0.0, 60.0, options.tailSeconds);
    const int64_t userTailFrames = static_cast<int64_t>(
        std::round(clampedTailSeconds * static_cast<double>(snapshot.projectSampleRate)));
    totalProjectFrames += maxTailFrames + sharedFxMaxTailFrames + userTailFrames;
    const int64_t minRenderFrames = totalProjectFrames - sharedFxMaxTailFrames;
    int64_t projectFramesRendered = 0;
    int64_t outputFramesWritten = 0;
    double peakAmplitude = 0.0;
    double preClampPeakAmplitude = 0.0;
    int64_t clippedSampleCount = 0;
    int blockIndex = 0;
    int64_t lastProgressMs = juce::Time::getMillisecondCounter();
    juce::String writerError;

    juce::AudioBuffer<float> mixBus(kOutputChannels, kBlockFrames);
    std::vector<float> mixInterleaved(static_cast<size_t>(kBlockFrames) * 2);

    // Shared TPDF dither keeps 16-bit output identical across render paths.
    const bool ditherActive = ! normalizing
                              && options.dither
                              && options.bitDepth == 16
                              && ! writer.isFloatingPoint();

    const auto writeStereo = [&](const float* interleaved, int frames) -> bool
    {
        if (frames <= 0) return true;
        // Loudness normalization uses a measured pass before final gain, limiting, dither, and
        // encode.
        if (analyzer)
        {
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
        std::vector<float> outL(static_cast<size_t>(frames));
        std::vector<float> outR(static_cast<size_t>(frames));
        if (ditherActive)
        {
            for (int i = 0; i < frames; ++i)
            {
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
        if (!writer.writeFromFloatArrays(writePtrs, kOutputChannels, frames))
        {
            writerError = "Writer failed mid-stream.";
            return false;
        }
        outputFramesWritten += frames;
        return true;
    };

    while (projectFramesRendered < totalProjectFrames)
    {
        // ScopedNoDenormals protects realtime DSP from denormal CPU spikes.
        const juce::ScopedNoDenormals scopedNoDenormals;
        if (cancelFlag.load())
        {
            pass1File.deleteFile();
            return fail(MixdownFailureCode::Cancelled, "Cancelled.");
        }
        const int blockFrames = static_cast<int>(
            std::min<int64_t>(kBlockFrames, totalProjectFrames - projectFramesRendered));

        mixBus.clear(0, blockFrames);
        float* mixL = mixBus.getWritePointer(0);
        float* mixR = mixBus.getWritePointer(1);

        for (auto& cp : clips)
        {
            if (cp->retired) continue;
            if (projectFramesRendered >= cp->timelineEndFrames + cp->tailFrames)
            {
                busGraph.detachClip(cp->id, cp->summingSource.get());
                cp->retired = true;
            }
        }

        juce::AudioSourceChannelInfo busInfo(&mixBus, 0, blockFrames);
        busGraph.getNextAudioBlock(busInfo);

        if (! juce::approximatelyEqual(snapshot.masterGain, 1.0F))
        {
            mixBus.applyGain(0, blockFrames, snapshot.masterGain);
        }

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

        if (!finalResampler.push(mixInterleaved.data(), blockFrames,
                                 /*endOfInput*/ false, writeStereo))
        {
            pass1File.deleteFile();
            if (writerError.isNotEmpty())
                return fail(MixdownFailureCode::Io, writerError);
            return fail(MixdownFailureCode::Invalid,
                        juce::String("Final resample failed: ") +
                            (finalResampler.error() ? finalResampler.error() : "unknown"));
        }

        projectFramesRendered += blockFrames;

        if (projectFramesRendered >= minRenderFrames && busGraph.sharedFxTerminated())
        {
            break;
        }

        const auto now = juce::Time::getMillisecondCounter();
        if (now - lastProgressMs >= kProgressMinIntervalMs)
        {
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

    // libsamplerate may leave input unconsumed; preserve leftovers to avoid render drift.
    if (!finalResampler.push(mixInterleaved.data(), 0, /*endOfInput*/ true, writeStereo))
    {
        pass1File.deleteFile();
        if (writerError.isNotEmpty())
            return fail(MixdownFailureCode::Io, writerError);
        return fail(MixdownFailureCode::Invalid,
                    juce::String("Final resample flush failed: ") +
                        (finalResampler.error() ? finalResampler.error() : "unknown"));
    }

    const double effectiveRenderLengthMs =
        static_cast<double>(projectFramesRendered) / projectFramesPerMs;

    busGraph.clear();

    (void) peakAmplitude;

    Pass1Result result;
    result.ok = true;
    result.clips = std::move(clips);
    result.outputFramesWritten = outputFramesWritten;
    result.effectiveRenderLengthMs = effectiveRenderLengthMs;
    result.preClampPeakAmplitude = preClampPeakAmplitude;
    result.clippedSampleCount = clippedSampleCount;
    return result;
}

} // namespace silverdaw::mixdown_render_pass1
