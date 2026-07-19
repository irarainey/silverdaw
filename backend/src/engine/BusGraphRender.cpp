// BusGraph audio callback, lock-free hazard protocol, clip mixing, and
// automation sampling. Message-thread setters live in BusGraph.cpp.

#include "BusGraph.h"

namespace silverdaw
{

// ── TrackRuntime audio-path methods ─────────────────────────────────────

void BusGraph::TrackRuntime::prepareToPlay(int samplesPerBlockExpected, double sampleRate)
{
    preparedBlockSize = juce::jmax(1, samplesPerBlockExpected);
    preparedRate = sampleRate;
    mixScratch.setSize(2, preparedBlockSize, false, true, false);
    mixScratch.clear();
    beatRepeatProcessor.prepare(sampleRate);
    for (auto* source : clips)
        if (source != nullptr) source->prepareToPlay(preparedBlockSize, preparedRate);
    chain.prepare(sampleRate, samplesPerBlockExpected, /*numChannels*/ 2);
}

void BusGraph::TrackRuntime::releaseResources()
{
    for (auto* source : clips)
        if (source != nullptr) source->releaseResources();
    chain.reset();
}

void BusGraph::TrackRuntime::getNextAudioBlock(const juce::AudioSourceChannelInfo& info)
{
    if (info.buffer == nullptr || info.numSamples <= 0)
        return;
    for (int ch = 0; ch < info.buffer->getNumChannels(); ++ch)
        info.buffer->clear(ch, info.startSample, info.numSamples);
    chain.process(*info.buffer, info.startSample, info.numSamples);
}

void BusGraph::TrackRuntime::renderClips(const std::vector<juce::AudioSource*>& sources,
                                         const juce::AudioSourceChannelInfo& info,
                                         juce::int64 timelineStart,
                                         const BeatRepeatSnapshot* beatRepeat)
{
    if (info.buffer == nullptr || info.numSamples <= 0)
        return;

    for (int ch = 0; ch < info.buffer->getNumChannels(); ++ch)
        info.buffer->clear(ch, info.startSample, info.numSamples);

    bool renderedSource = false;
    for (auto* source : sources)
    {
        if (source == nullptr) continue;
        if (! renderedSource)
        {
            source->getNextAudioBlock(info);
            renderedSource = true;
            continue;
        }

        mixScratch.clear(0, info.numSamples);
        juce::AudioSourceChannelInfo mixInfo(&mixScratch, 0, info.numSamples);
        source->getNextAudioBlock(mixInfo);
        const int channels = juce::jmin(info.buffer->getNumChannels(),
                                        mixScratch.getNumChannels());
        for (int ch = 0; ch < channels; ++ch)
            info.buffer->addFrom(ch, info.startSample, mixScratch, ch, 0,
                                 info.numSamples);
    }

    if (beatRepeatResetRequested.exchange(false, std::memory_order_acq_rel))
        beatRepeatProcessor.reset();
    beatRepeatProcessor.process(*info.buffer, info.startSample, info.numSamples, timelineStart, beatRepeat);
    chain.process(*info.buffer, info.startSample, info.numSamples);

    const int numCh = info.buffer->getNumChannels();
    if (numCh > 0)
        atomicMaxFloat(peakL,
                       info.buffer->getMagnitude(0, info.startSample, info.numSamples));
    if (numCh > 1)
        atomicMaxFloat(peakR,
                       info.buffer->getMagnitude(1, info.startSample, info.numSamples));
    else if (numCh > 0)
        atomicMaxFloat(peakR,
                       info.buffer->getMagnitude(0, info.startSample, info.numSamples));

    if (bypassRequested.exchange(false, std::memory_order_acq_rel))
        bypassReady.store(true, std::memory_order_release);
}

// ── RenderReadGuard ─────────────────────────────────────────────────────

BusGraph::RenderReadGuard::RenderReadGuard(BusGraph& owner) noexcept
    : graph(owner), snapshot(owner.pinRenderSnapshot())
{
}

BusGraph::RenderReadGuard::~RenderReadGuard()
{
    graph.renderHazard.store(nullptr, std::memory_order_seq_cst);
}

// ── Snapshot build / publish / pin / hazard ─────────────────────────────

const BusGraph::RenderSnapshot* BusGraph::pinRenderSnapshot() noexcept
{
    const RenderSnapshot* snapshot = nullptr;
    do
    {
        snapshot = publishedRenderSnapshot.load(std::memory_order_seq_cst);
        renderHazard.store(snapshot, std::memory_order_seq_cst);
    }
    while (snapshot != publishedRenderSnapshot.load(std::memory_order_seq_cst));
    return snapshot;
}

std::unique_ptr<BusGraph::RenderSnapshot> BusGraph::buildRenderSnapshot() const
{
    auto snapshot = std::make_unique<RenderSnapshot>();
    snapshot->tracks.reserve(runtimes.size());
    for (const auto& [trackId, runtime] : runtimes)
    {
        if (runtime == nullptr || runtime->clips.empty() || !runtime->renderEnabled) continue;
        snapshot->tracks.push_back(
            {runtime.get(), runtime->clips, runtime->publishedAutomation, runtime->publishedBeatRepeat});
        snapshot->hasAutomation =
            snapshot->hasAutomation || runtime->publishedAutomation != nullptr;
    }
    return snapshot;
}

std::unique_ptr<BusGraph::RenderSnapshot> BusGraph::buildRenderSnapshotExcluding(
    const juce::AudioSource* excluded) const
{
    auto snapshot = std::make_unique<RenderSnapshot>();
    snapshot->tracks.reserve(runtimes.size());
    for (const auto& [trackId, runtime] : runtimes)
    {
        if (runtime == nullptr || !runtime->renderEnabled) continue;

        RenderTrack track;
        track.runtime = runtime.get();
        track.automation = runtime->publishedAutomation;
        track.beatRepeat = runtime->publishedBeatRepeat;
        track.clips.reserve(runtime->clips.size());
        for (auto* source : runtime->clips)
            if (source != excluded) track.clips.push_back(source);
        if (track.clips.empty()) continue;

        snapshot->hasAutomation =
            snapshot->hasAutomation || track.automation != nullptr;
        snapshot->tracks.push_back(std::move(track));
    }
    return snapshot;
}

void BusGraph::publishRenderSnapshot()
{
    publishRenderSnapshot(buildRenderSnapshot());
}

void BusGraph::publishEmptyRenderSnapshot()
{
    publishRenderSnapshot(std::make_unique<RenderSnapshot>());
}

void BusGraph::publishRenderSnapshot(std::unique_ptr<RenderSnapshot> next) noexcept
{
    auto previous = std::move(currentRenderSnapshot);
    currentRenderSnapshot = std::move(next);
    publishedRenderSnapshot.store(currentRenderSnapshot.get(), std::memory_order_seq_cst);

    // A detached source may be destroyed as soon as this returns. The hazard
    // handshake waits only for a callback already using the previous snapshot;
    // new callbacks can pin only the newly published one.
    while (previous != nullptr
           && renderHazard.load(std::memory_order_seq_cst) == previous.get())
    {
        std::this_thread::yield();
    }
}

// ── Audio callback ──────────────────────────────────────────────────────

void BusGraph::getNextAudioBlock(const juce::AudioSourceChannelInfo& info)
{
    if (info.buffer == nullptr || info.numSamples <= 0) return;

    for (int ch = 0; ch < info.buffer->getNumChannels(); ++ch)
        info.buffer->clear(ch, info.startSample, info.numSamples);

    RenderReadGuard renderRead(*this);
    const auto& renderSnapshot = renderRead.get();

    // NOTE: do NOT early-return on empty runtimes; shared FX tails still need pumping.
    if (preparedMax <= 0) return;

    const int outChannels = juce::jmin(scratch.getNumChannels(),
                                       info.buffer->getNumChannels());
    if (outChannels <= 0) return;

    const int sendChannels = juce::jmin(2, outChannels);

    // Block-start transport position for automation sampling (the master clock
    // increments after the child renders, so this is the block's first sample).
    const juce::int64 blockStartSamples =
        timelineSamplesPtr != nullptr ? timelineSamplesPtr->load(std::memory_order_relaxed) : 0;
    const double rate = preparedRate > 0.0 ? preparedRate : 44100.0;

    // When any track is automated, cap the sub-block to a fixed control quantum
    // so the curve is sampled at the same granularity live (small device blocks)
    // and offline (large mixdown blocks) — keeping the two paths in parity. With
    // no automation the chunk stays the full prepared block (zero overhead).
    const int chunk = ! renderSnapshot.hasAutomation
                          ? preparedMax
                          : juce::jmin(preparedMax, kAutomationControlQuantum);

    int remaining = info.numSamples;
    int dst = info.startSample;
    while (remaining > 0)
    {
        const int n = juce::jmin(remaining, chunk);
        const juce::int64 subStartSamples = blockStartSamples + (dst - info.startSample);

        for (int ch = 0; ch < 2; ++ch)
        {
            reverbSendBuf.clear(ch, 0, n);
            delaySendBuf.clear(ch, 0, n);
        }

        for (const auto& track : renderSnapshot.tracks)
        {
            auto& runtime = *track.runtime;
            applyTrackAutomation(runtime, track.automation, subStartSamples, n, rate);

            scratch.clear(0, n);
            juce::AudioSourceChannelInfo sub(&scratch, 0, n);
            runtime.renderClips(track.clips, sub, subStartSamples, track.beatRepeat);

            const float rSend = runtime.reverbSend.load(std::memory_order_relaxed);
            const float dSend = runtime.delaySend.load(std::memory_order_relaxed);
            for (int ch = 0; ch < sendChannels; ++ch)
            {
                if (rSend != 0.0F)
                    reverbSendBuf.addFrom(ch, 0, scratch, ch, 0, n, rSend);
                if (dSend != 0.0F)
                    delaySendBuf.addFrom(ch, 0, scratch, ch, 0, n, dSend);
            }
            if (runtime.pan.load(std::memory_order_relaxed) == 0.0F || outChannels < 2)
            {
                for (int ch = 0; ch < outChannels; ++ch)
                    info.buffer->addFrom(ch, dst, scratch, ch, 0, n);
            }
            else
            {
                info.buffer->addFrom(0, dst, scratch, 0, 0, n,
                                     runtime.panGainL.load(std::memory_order_relaxed));
                info.buffer->addFrom(1, dst, scratch, 1, 0, n,
                                     runtime.panGainR.load(std::memory_order_relaxed));
                for (int ch = 2; ch < outChannels; ++ch)
                    info.buffer->addFrom(ch, dst, scratch, ch, 0, n);
            }
        }

        sharedFx.process(reverbSendBuf, delaySendBuf, *info.buffer, dst, n);

        remaining -= n;
        dst += n;
    }
}

// ── Automation sampling ─────────────────────────────────────────────────

// Cursor state is audio-thread-owned; message-thread changes publish only a
// pointer or reset request.
void BusGraph::applyTrackAutomation(TrackRuntime& rt, const TrackAutomationSnapshot* snap,
                                    juce::int64 subStartSamples, int numSamples,
                                    double rate) noexcept
{
    const bool snapshotChanged = snap != rt.lastAutomationSnapshot;
    const bool resetRequested =
        rt.automationResetRequested.exchange(false, std::memory_order_acquire);
    if (snapshotChanged || resetRequested)
    {
        for (auto& segment : rt.automationSegments) segment = 0;
        rt.automationLastEndSamples = -1;
        rt.lastAutomationSnapshot = snap;
    }
    if (snap == nullptr) return;

    const bool discontinuity = (subStartSamples != rt.automationLastEndSamples);
    const double ms = static_cast<double>(subStartSamples) / rate * 1000.0;

    const auto sample = [&](AutomationParam p) {
        const int pi = static_cast<int>(p);
        return snap->curve(p).valueAtMs(ms, rt.automationSegments[pi]);
    };
    if (snap->hasParam(AutomationParam::filter)) rt.chain.setFilterTarget(sample(AutomationParam::filter), discontinuity);
    if (snap->hasParam(AutomationParam::toneBass)) rt.chain.setBassTarget(sample(AutomationParam::toneBass), discontinuity);
    if (snap->hasParam(AutomationParam::toneMid)) rt.chain.setMidTarget(sample(AutomationParam::toneMid), discontinuity);
    if (snap->hasParam(AutomationParam::toneTreble)) rt.chain.setTrebleTarget(sample(AutomationParam::toneTreble), discontinuity);
    if (snap->hasParam(AutomationParam::leveler)) rt.chain.setLeveler(sample(AutomationParam::leveler), discontinuity);
    if (snap->hasParam(AutomationParam::saturationDrive)) rt.chain.setSaturationDriveTarget(sample(AutomationParam::saturationDrive), discontinuity);
    if (snap->hasParam(AutomationParam::saturationMix)) rt.chain.setSaturationMixTarget(sample(AutomationParam::saturationMix), discontinuity);
    if (snap->hasParam(AutomationParam::bitCrusherRate)) rt.chain.setBitCrusherRateTarget(sample(AutomationParam::bitCrusherRate), discontinuity);
    if (snap->hasParam(AutomationParam::bitCrusherBits)) rt.chain.setBitCrusherBitsTarget(sample(AutomationParam::bitCrusherBits), discontinuity);
    if (snap->hasParam(AutomationParam::bitCrusherBoost)) rt.chain.setBitCrusherBoostTarget(sample(AutomationParam::bitCrusherBoost), discontinuity);
    if (snap->hasParam(AutomationParam::bitCrusherMix)) rt.chain.setBitCrusherMixTarget(sample(AutomationParam::bitCrusherMix), discontinuity);
    if (snap->hasParam(AutomationParam::level)) rt.chain.setLevelTarget(sample(AutomationParam::level), discontinuity);
    if (snap->hasParam(AutomationParam::reverbSend)) rt.reverbSend.store(sample(AutomationParam::reverbSend), std::memory_order_relaxed);
    if (snap->hasParam(AutomationParam::delaySend)) rt.delaySend.store(sample(AutomationParam::delaySend), std::memory_order_relaxed);
    if (snap->hasParam(AutomationParam::pan))
    {
        const float p = sample(AutomationParam::pan);
        float gL = 1.0F, gR = 1.0F;
        equalPowerPanGains(p, gL, gR);
        rt.pan.store(p, std::memory_order_relaxed);
        rt.panGainL.store(gL, std::memory_order_relaxed);
        rt.panGainR.store(gR, std::memory_order_relaxed);
    }

    rt.automationLastEndSamples = subStartSamples + numSamples;
}

} // namespace silverdaw
