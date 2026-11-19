#include "MixdownRenderPass1.h"

#include "BusGraph.h"
#include "BeatRepeatSnapshot.h"
#include "Log.h"
#include "Leveler.h"
#include "PluginPlayHead.h"
#include "SafetyLimiter.h"
#include "SharedFx.h"  // delayNoteToMs
#include "TrackAutomationSnapshot.h"
#include "TrackPluginRestore.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <climits>
#include <memory>
#include <vector>

#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw::mixdown_render_pass1
{

using mixdown_dither::kLsb16f;
using mixdown_dither::nextUniform;
using mixdown_graph::buildOfflineClip;
using mixdown_graph::FinalResampler;
using mixdown_graph::kBlockFrames;
using mixdown_graph::kFinalResampleHeadroom;
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

double lastTrackInputFrame(const MixdownSnapshot::TrackSnapshot& track, BusGraph& graph, double lastMixFrame)
{
    auto* chain = graph.getTrackPlugins(track.id);
    if (chain == nullptr) return lastMixFrame;
    // The graph delays other tracks separately; only this chain's latency extends its source horizon.
    const auto frame = lastMixFrame + std::min(graph.getLatencyCompensationSamples(), chain->getLatencySamples());
    const auto active = std::any_of(track.plugins.begin(), track.plugins.end(), [&](const auto& descriptor) {
        const auto* slot = chain->findSlot(descriptor.slotId);
        return !descriptor.bypassed && slot != nullptr && !slot->isUnresolved();
    });
    // A hosted processor can inspect its entire final input block.
    return active ? (std::floor(frame / kBlockFrames) + 1.0) * kBlockFrames - 1.0 : frame;
}

bool startsAfterInputFrame(const MixdownSnapshot::ClipSnapshot& clip, double lastFrame, int projectRate)
{
    const double rate = clip.sourceSampleRate > 0 ? clip.sourceSampleRate : projectRate;
    // OffsetSource floors the source-time offset; JUCE interpolates to the next source sample.
    return std::floor(clip.offsetMs * rate / 1000.0) > std::ceil(lastFrame * rate / projectRate);
}
} // anonymous namespace

Pass1Result runPass1(const MixdownSnapshot& snapshot,
                     const MixdownOptions& options,
                     juce::AudioFormatManager& formatManager,
                     juce::AudioFormatWriter& writer,
                     LoudnessAnalyzer* analyzer,
                     bool normalizing,
                     bool analyzing,
                     mixdown_dither::Xorshift32& rngL,
                     mixdown_dither::Xorshift32& rngR,
                     const RenderProgress& progress,
                     std::atomic<bool>& cancelFlag)
{
    std::vector<std::unique_ptr<OfflineClip>> clips;
    clips.reserve(snapshot.tracks.size() * 8);

    // Snapshot live per-track parameters so offline render stays in parity with playback.
    // Declaration order is deliberate: everything the graph's plugin chains point at — the
    // catalogue their instances came from, and the transport the play head reads — is
    // declared *before* the graph, so an early `return fail(...)` destroys the graph first
    // and no chain is torn down while its dependencies are already gone.
    std::unique_ptr<silverdaw::plugins::PluginCatalogue> offlinePluginCatalogue;
    std::atomic<juce::int64> mixdownPos{0};
    const std::atomic<double> offlineRate{static_cast<double>(snapshot.projectSampleRate)};
    const std::atomic<bool> offlinePlaying{true};
    silverdaw::plugins::PluginPlayHead offlinePlayHead;
    juce::MixerAudioSource silentSource;
    silverdaw::BusGraph busGraph;

    offlinePlayHead.setTransportSources(&mixdownPos, &offlineRate, &offlinePlaying);
    offlinePlayHead.setBpm(snapshot.bpm);
    busGraph.setPluginPlayHead(&offlinePlayHead);
    busGraph.prepareToPlay(kBlockFrames, static_cast<double>(snapshot.projectSampleRate));
    for (const auto& trackSnap : snapshot.tracks)
    {
        busGraph.setTrackTone(trackSnap.id, trackSnap.toneBassDb, trackSnap.toneMidDb,
                              trackSnap.toneTrebleDb, trackSnap.toneFilter, /*snap*/ true);
        busGraph.setTrackLeveler(trackSnap.id, trackSnap.levelerAmount, /*snap*/ true);
        busGraph.setTrackPunch(trackSnap.id, trackSnap.punchAmount, /*snap*/ true);
        busGraph.setTrackSaturation(trackSnap.id, trackSnap.saturationDrive,
                                    trackSnap.saturationMix, /*snap*/ true);
        busGraph.setTrackBitCrusher(trackSnap.id, trackSnap.bitCrusherRate,
                                    trackSnap.bitCrusherBits, trackSnap.bitCrusherBoost,
                                    trackSnap.bitCrusherMix, /*snap*/ true);
        busGraph.setTrackSends(trackSnap.id, trackSnap.reverbSend, trackSnap.delaySend);
        busGraph.setTrackPan(trackSnap.id, trackSnap.pan);
        if (!trackSnap.plugins.empty())
        {
            // The export instantiates its own plugin copies from the same saved state, so a
            // render can never diverge from playback (ADR 0022).
            if (offlinePluginCatalogue == nullptr)
                offlinePluginCatalogue = std::make_unique<silverdaw::plugins::PluginCatalogue>();

            silverdaw::restoreTrackPlugins(busGraph, *offlinePluginCatalogue, trackSnap.id,
                                           trackSnap.plugins,
                                           static_cast<double>(snapshot.projectSampleRate),
                                           kBlockFrames);
        }
    }

    // Per-track automation: build immutable snapshots (owned here for the render's
    // lifetime) and publish to the offline bus graph. The graph samples them against
    // `mixdownPos`, updated to the project frame before each block, so the export
    // tracks the curves identically to live playback (same control quantum).
    std::vector<std::unique_ptr<silverdaw::TrackAutomationSnapshot>> automationSnaps;
    std::vector<std::unique_ptr<silverdaw::BeatRepeatSnapshot>> beatRepeatSnaps;
    busGraph.setTimelineSamplesSource(&mixdownPos);
    for (const auto& trackSnap : snapshot.tracks)
    {
        if (trackSnap.automation.empty()) continue;
        auto snap = std::make_unique<silverdaw::TrackAutomationSnapshot>();
        for (const auto& lane : trackSnap.automation)
        {
            silverdaw::AutomationParam param{};
            if (!silverdaw::automationParamFromString(lane.paramId, param)) continue;
            silverdaw::BreakpointCurve curve(silverdaw::InterpDomain::linear);
            curve.reserve(lane.points.size());
            for (const auto& pt : lane.points) curve.addPoint(pt.first, pt.second);
            curve.finalise();
            if (!curve.isEmpty())
            {
                const int pi = static_cast<int>(param);
                snap->has[pi] = true;
                snap->curves[pi] = std::move(curve);
            }

        }
        if (snap->hasAny())
        {
            busGraph.setTrackAutomationPtr(trackSnap.id, snap.get());
            automationSnaps.push_back(std::move(snap));
        }
    }

    for (const auto& trackSnap : snapshot.tracks)
    {
        if (trackSnap.beatRepeats.empty()) continue;
        auto snap = silverdaw::makeBeatRepeatSnapshot(
            trackSnap.beatRepeats, static_cast<double>(snapshot.projectSampleRate), snapshot.bpm);
        if (!snap->regions.empty())
        {
            busGraph.setTrackBeatRepeatPtr(trackSnap.id, snap.get());
            beatRepeatSnaps.push_back(std::move(snap));
        }
    }

    busGraph.setProjectReverb(snapshot.reverbSize, snapshot.reverbDecay, snapshot.reverbTone,
                              snapshot.reverbMix, /*snap*/ true);
    const double delayMs = silverdaw::delayNoteToMs(snapshot.delayNoteValue, snapshot.bpm);
    busGraph.setProjectDelay(delayMs,
                             snapshot.delayFeedback, snapshot.delayTone, snapshot.delayMix,
                             /*snap*/ true, /*applyTimeNow*/ true);
    FinalResampler finalResampler(snapshot.projectSampleRate, options.outputSampleRate);
    if (!finalResampler.ok())
        return fail(MixdownFailureCode::Invalid,
                    juce::String("Cannot init output resampler: ") + finalResampler.error());

    const auto window = options.exactOutputWindow();
    const int64_t alignmentFrames = busGraph.getLatencyCompensationSamples();
    for (const auto& track : snapshot.tracks)
    {
        const auto firstClip = clips.size();
        const auto lastInputFrame = options.outputFrameRange
            ? std::optional{lastTrackInputFrame(track, busGraph, finalResampler.lastInputFrameForOutput(window->getEnd() - 1))}
            : std::nullopt;
        for (const auto& clip : track.clips)
        {
            if (cancelFlag.load())
                return fail(MixdownFailureCode::Cancelled, "Cancelled.");
            if (lastInputFrame && startsAfterInputFrame(clip, *lastInputFrame, snapshot.projectSampleRate)) continue;
            juce::String err;
            auto built = buildOfflineClip(clip, track.id, track.gain, snapshot.projectSampleRate, formatManager, err);
            if (built == nullptr)
                return fail(MixdownFailureCode::Decode, "Could not open source for clip " + clip.id + ": " + err);
            clips.push_back(std::move(built));
            const auto& cp = clips.back();
            busGraph.attachClip(cp->trackId, cp->id, cp->summingSource.get());
        }
        // Keep the track's inserts running on silence, even if its only clip is in the future.
        if (clips.size() > firstClip) clips.back()->keepTrackAlive = window.has_value();
        else if (!track.clips.empty())
            busGraph.attachClip(track.id, track.clips.front().id, &silentSource);
    }

    const double projectFramesPerMs = snapshot.projectSampleRate / 1000.0;
    int64_t totalProjectFrames =
        static_cast<int64_t>(std::round(options.lengthMs * projectFramesPerMs));
    int64_t maxTailFrames = 0;
    for (const auto& cp : clips)
    {
        maxTailFrames = std::max(maxTailFrames, cp->tailFrames);
    }
    const double audibleDelayTailSeconds = snapshot.delayMix > 1.0e-7F
        ? silverdaw::SharedFx::minimumEchoTailSeconds(delayMs, snapshot.delayFeedback)
        : 0.0;
    const double sharedFxTailSeconds = juce::jmax(8.0, audibleDelayTailSeconds);
    const int64_t sharedFxMaxTailFrames = static_cast<int64_t>(
        std::ceil(sharedFxTailSeconds * static_cast<double>(snapshot.projectSampleRate)));
    const double clampedTailSeconds = juce::jlimit(0.0, 60.0, options.tailSeconds);
    const int64_t userTailFrames = static_cast<int64_t>(
        std::round(clampedTailSeconds * static_cast<double>(snapshot.projectSampleRate)));
    totalProjectFrames += maxTailFrames + sharedFxMaxTailFrames + userTailFrames;
    // Every track leaves the graph aligned by this much, so shift the whole render window to
    // match: the extra head is discarded and the extra tail keeps the true end audible (ADR 0026).
    totalProjectFrames += alignmentFrames;
    if (window)
        totalProjectFrames = alignmentFrames + static_cast<int64_t>(std::ceil(
            static_cast<double>(window->getEnd()) * snapshot.projectSampleRate / options.outputSampleRate));
    const int64_t minRenderFrames = totalProjectFrames - sharedFxMaxTailFrames;
    // Render from frame 0 so clip positions and FX tails advance correctly, but only
    // push frames at/after the start offset into the output (earlier audio discarded).
    const int64_t startFrames = juce::jlimit<int64_t>(
        0, juce::jmax<int64_t>(0, totalProjectFrames),
        static_cast<int64_t>(std::round(options.startMs * projectFramesPerMs)) + alignmentFrames);
    int64_t projectFramesRendered = 0;
    int64_t outputFramesWritten = 0;
    int64_t skipOutputFrames = window ? window->getStart() : 0;
    double peakAmplitude = 0.0;
    double preClampPeakAmplitude = 0.0;
    int64_t clippedSampleCount = 0;
    int blockIndex = 0;
    int64_t lastProgressMs = juce::Time::getMillisecondCounter();
    juce::String writerError;
    std::vector<silverdaw::BusGraph::ClipDetachment> completedClips;
    completedClips.reserve(clips.size());

    juce::AudioBuffer<float> mixBus(kOutputChannels, kBlockFrames);
    silverdaw::Leveler mixGlue{silverdaw::Leveler::kProjectMixGlueMaximumMakeupDb};
    mixGlue.prepare(static_cast<double>(snapshot.projectSampleRate), kOutputChannels);
    mixGlue.setParams(snapshot.mixGlueAmount, /*snap*/ true);
    silverdaw::SafetyLimiter safetyLimiter;
    safetyLimiter.prepare(static_cast<double>(snapshot.projectSampleRate));
    safetyLimiter.setEnabled(snapshot.safetyLimiterEnabled, /*snap*/ true);
    std::vector<float> mixInterleaved(static_cast<size_t>(kBlockFrames) * 2);
    const double outputRatio = static_cast<double>(options.outputSampleRate)
                               / static_cast<double>(snapshot.projectSampleRate);
    const int maxWriteFrames = static_cast<int>(std::ceil(
        static_cast<double>(kBlockFrames) * juce::jmax(1.0, outputRatio)))
        + kFinalResampleHeadroom;
    std::vector<float> writeL(static_cast<size_t>(maxWriteFrames));
    std::vector<float> writeR(static_cast<size_t>(maxWriteFrames));

    // Shared TPDF dither keeps 16-bit output identical across render paths.
    const bool ditherActive = ! normalizing
                              && options.dither
                              && options.bitDepth == 16
                              && ! writer.isFloatingPoint();

    const auto writeStereo = [&](const float* interleaved, int frames) -> bool
    {
        if (window)
        {
            const auto skip = static_cast<int>(std::min<int64_t>(skipOutputFrames, frames));
            skipOutputFrames -= skip;
            interleaved += static_cast<std::ptrdiff_t>(skip) * kOutputChannels;
            frames = static_cast<int>(std::min<int64_t>(frames - skip, window->getLength() - outputFramesWritten));
        }
        if (frames <= 0) return true;
        if (frames > maxWriteFrames)
        {
            writerError = "Resampler produced an oversized output block.";
            return false;
        }
        // Loudness normalization uses a measured pass before final gain, limiting, dither, and
        // encode.
        for (int i = 0; i < frames; ++i)
        {
            writeL[static_cast<size_t>(i)] = interleaved[static_cast<size_t>(i) * 2 + 0];
            writeR[static_cast<size_t>(i)] = interleaved[static_cast<size_t>(i) * 2 + 1];
        }
        if (analyzer)
        {
            const float* ch[2] = {writeL.data(), writeR.data()};
            analyzer->process(ch, 2, frames);
        }
        if (ditherActive)
        {
            for (int i = 0; i < frames; ++i)
            {
                const float dL = (nextUniform(rngL) + nextUniform(rngL) - 1.0f) * kLsb16f;
                const float dR = (nextUniform(rngR) + nextUniform(rngR) - 1.0f) * kLsb16f;
                writeL[static_cast<size_t>(i)] += dL;
                writeR[static_cast<size_t>(i)] += dR;
            }
        }
        const float* writePtrs[kOutputChannels] = {writeL.data(), writeR.data()};
        if (!writer.writeFromFloatArrays(writePtrs, kOutputChannels, frames))
        {
            writerError = "Writer failed mid-stream.";
            return false;
        }
        outputFramesWritten += frames;
        return true;
    };

    // For an exact output window, advance the full chain (including the resampler's
    // lookahead) until it has actually delivered the final requested sample.
    while (window ? outputFramesWritten < window->getLength() : projectFramesRendered < totalProjectFrames)
    {
        // ScopedNoDenormals protects realtime DSP from denormal CPU spikes.
        const juce::ScopedNoDenormals scopedNoDenormals;
        if (cancelFlag.load())
        {
            return fail(MixdownFailureCode::Cancelled, "Cancelled.");
        }
        const int blockFrames = window ? kBlockFrames : static_cast<int>(
            std::min<int64_t>(kBlockFrames, totalProjectFrames - projectFramesRendered));

        mixBus.clear(0, blockFrames);
        float* mixL = mixBus.getWritePointer(0);
        float* mixR = mixBus.getWritePointer(1);

        completedClips.clear();
        for (auto& cp : clips)
        {
            if (cp->retired || cp->keepTrackAlive) continue;
            if (projectFramesRendered >= cp->timelineEndFrames + cp->tailFrames)
            {
                completedClips.push_back({cp->id, cp->summingSource.get()});
                cp->retired = true;
            }
        }
        busGraph.detachClips(completedClips);

        juce::AudioSourceChannelInfo busInfo(&mixBus, 0, blockFrames);
        mixdownPos.store(projectFramesRendered, std::memory_order_relaxed);
        busGraph.getNextAudioBlock(busInfo);

        mixGlue.process(mixBus, 0, blockFrames);
        if (! juce::approximatelyEqual(snapshot.masterGain, 1.0F))
        {
            mixBus.applyGain(0, blockFrames, snapshot.masterGain);
        }
        safetyLimiter.process(mixBus, 0, blockFrames);

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

        // Push only frames at/after the start offset; earlier audio advances state then drops.
        const int64_t blockStart = projectFramesRendered;
        projectFramesRendered += blockFrames;
        const bool lastBlock = !window && (projectFramesRendered >= totalProjectFrames
            || (projectFramesRendered >= minRenderFrames && busGraph.sharedFxTerminated()));
        const int64_t keepOffset64 = juce::jmax<int64_t>(0, startFrames - blockStart);
        if (keepOffset64 < blockFrames)
        {
            const int keepOffset = static_cast<int>(keepOffset64);
            const int keepFrames = blockFrames - keepOffset;
            if (!finalResampler.push(mixInterleaved.data() + static_cast<size_t>(keepOffset) * 2,
                                     keepFrames, lastBlock, writeStereo))
            {
                if (writerError.isNotEmpty())
                    return fail(MixdownFailureCode::Io, writerError);
                return fail(MixdownFailureCode::Invalid,
                            juce::String("Final resample failed: ") +
                                (finalResampler.error() ? finalResampler.error() : "unknown"));
            }
        }

        if (lastBlock) break;

        const auto now = juce::Time::getMillisecondCounter();
        if (now - lastProgressMs >= kProgressMinIntervalMs)
        {
            const double renderShare = normalizing ? 45.0 : 90.0;
            const double pct = (static_cast<double>(std::min(projectFramesRendered, totalProjectFrames))
                                / static_cast<double>(juce::jmax<int64_t>(1, totalProjectFrames)))
                               * renderShare;
            progress(pct,
                              normalizing ? "normalize-pass1"
                                          : (analyzing ? "analyze" : "render"));
            lastProgressMs = now;
        }
    }

    const double effectiveRenderLengthMs =
        static_cast<double>(juce::jmax<int64_t>(0, projectFramesRendered - startFrames))
        / projectFramesPerMs;

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
