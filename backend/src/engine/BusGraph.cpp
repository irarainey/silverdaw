// BusGraph lifecycle and message-thread setters.
// Audio-callback and hazard-protocol helpers live in BusGraphRender.cpp.

#include "BusGraph.h"

namespace silverdaw
{

BusGraph::BusGraph()
    : currentRenderSnapshot(std::make_unique<RenderSnapshot>())
{
    publishedRenderSnapshot.store(currentRenderSnapshot.get(), std::memory_order_relaxed);
}

void BusGraph::prepareToPlay(int samplesPerBlockExpected, double sampleRate)
{
    const juce::ScopedLock sl(lock);
    preparedMax = juce::jmax(1, samplesPerBlockExpected);
    preparedRate = sampleRate;
    scratch.setSize(/*numChannels*/ 2, preparedMax, /*keepExisting*/ false,
                    /*clearExtra*/ true, /*avoidReallocating*/ false);
    scratch.clear();
    reverbSendBuf.setSize(2, preparedMax, false, true, false);
    delaySendBuf.setSize(2, preparedMax, false, true, false);
    reverbSendBuf.clear();
    delaySendBuf.clear();
    sharedFx.prepare(preparedRate, preparedMax);
    for (auto& kv : runtimes)
        kv.second->prepareToPlay(preparedMax, preparedRate);
}

void BusGraph::releaseResources()
{
    const juce::ScopedLock sl(lock);
    for (auto& kv : runtimes)
        kv.second->releaseResources();
}

void BusGraph::attachClip(const juce::String& trackId,
                          const juce::String& clipId,
                          juce::AudioSource* clipTransport,
                          bool trackRenderingEnabled,
                          bool prepareSource)
{
    if (clipTransport == nullptr || trackId.isEmpty() || clipId.isEmpty()) return;
    const juce::ScopedLock sl(lock);

    auto rIt = runtimes.find(trackId);
    bool createdRuntime = false;
    if (rIt == runtimes.end())
    {
        auto rt = std::make_unique<TrackRuntime>();
        rt->trackId = trackId;
        if (preparedMax > 0)
            rt->prepareToPlay(preparedMax, preparedRate);
        rIt = runtimes.emplace(trackId, std::move(rt)).first;
        createdRuntime = true;
    }
    auto* rt = rIt->second.get();
    if (createdRuntime)
    {
        rt->renderEnabled = trackRenderingEnabled;
        rt->bypassRequested.store(false, std::memory_order_release);
        rt->bypassReady.store(false, std::memory_order_release);
    }
    bool sourcePrepared = false;
    bool clipAdded = false;
    try
    {
        if (prepareSource && preparedMax > 0)
        {
            clipTransport->prepareToPlay(preparedMax, preparedRate);
            sourcePrepared = true;
        }
        rt->clips.push_back(clipTransport);
        clipAdded = true;
        clipToTrack[clipId] = rt;

        auto automationIt = pendingAutomation.find(trackId);
        if (createdRuntime && automationIt != pendingAutomation.end())
            rt->publishedAutomation = automationIt->second;

        auto toneIt = pendingTone.find(trackId);
        if (toneIt != pendingTone.end())
        {
            const auto& t = toneIt->second;
            rt->chain.setTone(t.bassDb, t.midDb, t.trebleDb, t.filter, /*snap*/ true);
        }

        auto levelerIt = pendingLeveler.find(trackId);
        if (levelerIt != pendingLeveler.end())
            rt->chain.setLeveler(levelerIt->second, /*snap*/ true);

        auto saturationIt = pendingSaturation.find(trackId);
        if (saturationIt != pendingSaturation.end())
            rt->chain.setSaturation(saturationIt->second.drive, saturationIt->second.mix,
                                    /*snap*/ true);

        auto bitCrusherIt = pendingBitCrusher.find(trackId);
        if (bitCrusherIt != pendingBitCrusher.end())
            rt->chain.setBitCrusher(bitCrusherIt->second.rate, bitCrusherIt->second.bits,
                                    bitCrusherIt->second.boost, bitCrusherIt->second.mix,
                                    /*snap*/ true);

        auto sendIt = pendingSends.find(trackId);
        if (sendIt != pendingSends.end())
        {
            rt->reverbSend.store(sendIt->second.reverbSend, std::memory_order_relaxed);
            rt->delaySend.store(sendIt->second.delaySend, std::memory_order_relaxed);
        }

        auto panIt = pendingPans.find(trackId);
        if (panIt != pendingPans.end())
        {
            float gL = 1.0F;
            float gR = 1.0F;
            equalPowerPanGains(panIt->second, gL, gR);
            rt->pan.store(panIt->second, std::memory_order_relaxed);
            rt->panGainL.store(gL, std::memory_order_relaxed);
            rt->panGainR.store(gR, std::memory_order_relaxed);
        }

        publishRenderSnapshot();
    }
    catch (...)
    {
        clipToTrack.erase(clipId);
        if (clipAdded)
        {
            rt->clips.erase(std::remove(rt->clips.begin(), rt->clips.end(), clipTransport),
                            rt->clips.end());
        }
        if (sourcePrepared) clipTransport->releaseResources();
        if (createdRuntime) runtimes.erase(trackId);
        throw;
    }
}

void BusGraph::detachClip(const juce::String& clipId,
                          juce::AudioSource* clipTransport,
                          bool releaseSource)
{
    if (clipTransport == nullptr || clipId.isEmpty()) return;
    const juce::ScopedLock sl(lock);
    auto it = clipToTrack.find(clipId);
    if (it == clipToTrack.end() || it->second == nullptr) return;
    auto* rt = it->second;
    const bool removeRuntime =
        rt->clips.size() == 1 && rt->clips.front() == clipTransport;
    auto nextRenderSnapshot = buildRenderSnapshotExcluding(clipTransport);

    // Publish before mutating bookkeeping. If snapshot construction throws,
    // the existing graph and clip lookup remain intact for a safe retry.
    publishRenderSnapshot(std::move(nextRenderSnapshot));
    rt->clips.erase(std::remove(rt->clips.begin(), rt->clips.end(), clipTransport),
                    rt->clips.end());
    clipToTrack.erase(it);

    if (releaseSource)
        clipTransport->releaseResources();

    if (removeRuntime || rt->clips.empty())
    {
        rt->chain.reset();
        runtimes.erase(rt->trackId);
    }
}

bool BusGraph::consumeTrackPeaks(const juce::String& trackId,
                                 float& outL, float& outR) noexcept
{
    // Lock-free: the map is only ever mutated on this (message) thread, and
    // peaks are atomic, so this read cannot race the audio thread.
    auto it = runtimes.find(trackId);
    if (it == runtimes.end())
    {
        outL = 0.0F;
        outR = 0.0F;
        return false;
    }
    it->second->consumePeaks(outL, outR);
    return true;
}

void BusGraph::requestTrackBypass(const juce::String& trackId)
{
    const juce::ScopedLock sl(lock);
    auto it = runtimes.find(trackId);
    if (it == runtimes.end() || !it->second->renderEnabled) return;
    it->second->bypassReady.store(false, std::memory_order_relaxed);
    it->second->bypassRequested.store(true, std::memory_order_release);
}

bool BusGraph::finalizeTrackBypass(const juce::String& trackId)
{
    const juce::ScopedLock sl(lock);
    auto it = runtimes.find(trackId);
    if (it == runtimes.end() || !it->second->renderEnabled) return true;
    if (!it->second->bypassReady.load(std::memory_order_acquire)) return false;

    it->second->renderEnabled = false;
    publishRenderSnapshot();
    it->second->chain.reset();
    it->second->peakL.store(0.0F, std::memory_order_relaxed);
    it->second->peakR.store(0.0F, std::memory_order_relaxed);
    it->second->bypassReady.store(false, std::memory_order_relaxed);
    return true;
}

void BusGraph::setTrackRenderingEnabled(const juce::String& trackId, bool enabled)
{
    const juce::ScopedLock sl(lock);
    auto it = runtimes.find(trackId);
    if (it == runtimes.end()) return;
    auto& runtime = *it->second;
    runtime.bypassRequested.store(false, std::memory_order_release);
    runtime.bypassReady.store(false, std::memory_order_relaxed);
    if (runtime.renderEnabled == enabled) return;

    runtime.renderEnabled = enabled;
    publishRenderSnapshot();
    if (!enabled)
    {
        runtime.chain.reset();
        runtime.peakL.store(0.0F, std::memory_order_relaxed);
        runtime.peakR.store(0.0F, std::memory_order_relaxed);
    }
}

void BusGraph::setTrackTone(const juce::String& trackId,
                            float bassDb, float midDb, float trebleDb, float filter,
                            bool snap)
{
    if (trackId.isEmpty()) return;
    // Lock-free: `pendingTone` and the runtime map are message-thread-only (serialised vs
    // attach/detach/clear), and `ToneEq` publishes its params atomically, so the audio
    // thread's read-only map iteration is never raced.
    pendingTone[trackId] = {bassDb, midDb, trebleDb, filter};
    auto it = runtimes.find(trackId);
    if (it != runtimes.end())
        it->second->chain.setTone(bassDb, midDb, trebleDb, filter, snap);
}

void BusGraph::setTrackLeveler(const juce::String& trackId, float amount, bool snap)
{
    if (trackId.isEmpty()) return;
    const float a = juce::jlimit(0.0F, 1.0F, std::isfinite(amount) ? amount : 0.0F);
    // Lock-free: see `setTrackTone`; `Leveler` publishes its param atomically.
    pendingLeveler[trackId] = a;
    auto it = runtimes.find(trackId);
    if (it != runtimes.end())
        it->second->chain.setLeveler(a, snap);
}

void BusGraph::setTrackSaturation(const juce::String& trackId, float drive, float mix, bool snap)
{
    if (trackId.isEmpty()) return;
    const float d = juce::jlimit(0.0F, 1.0F, std::isfinite(drive) ? drive : 0.0F);
    const float m = juce::jlimit(0.0F, 1.0F, std::isfinite(mix) ? mix : 1.0F);
    pendingSaturation[trackId] = {d, m};
    auto it = runtimes.find(trackId);
    if (it != runtimes.end())
        it->second->chain.setSaturation(d, m, snap);
}

void BusGraph::setTrackBitCrusher(const juce::String& trackId, float rate, int bits,
                                  float boost, float mix, bool snap)
{
    if (trackId.isEmpty()) return;
    BitCrusherParams params;
    params.rate = juce::jlimit(0.01F, 1.0F, std::isfinite(rate) ? rate : 1.0F);
    params.bits = juce::jlimit(1, 16, bits);
    params.boost = juce::jlimit(0.0F, 1.0F, std::isfinite(boost) ? boost : 0.0F);
    params.mix = juce::jlimit(0.0F, 1.0F, std::isfinite(mix) ? mix : 0.0F);
    pendingBitCrusher[trackId] = params;
    auto it = runtimes.find(trackId);
    if (it != runtimes.end())
        it->second->chain.setBitCrusher(params.rate, params.bits, params.boost, params.mix, snap);
}

void BusGraph::setTrackSends(const juce::String& trackId, float reverbSend, float delaySend)
{
    if (trackId.isEmpty()) return;
    const float r = juce::jlimit(0.0F, 1.0F, std::isfinite(reverbSend) ? reverbSend : 0.0F);
    const float d = juce::jlimit(0.0F, 1.0F, std::isfinite(delaySend) ? delaySend : 0.0F);
    // Lock-free: publishes atomic scalars; pending* and the map are
    // message-thread-only, so this never contends the audio callback.
    pendingSends[trackId] = {r, d};
    auto it = runtimes.find(trackId);
    if (it != runtimes.end())
    {
        it->second->reverbSend.store(r, std::memory_order_relaxed);
        it->second->delaySend.store(d, std::memory_order_relaxed);
    }
}

void BusGraph::setTrackPan(const juce::String& trackId, float pan)
{
    if (trackId.isEmpty()) return;
    const float p = juce::jlimit(-1.0F, 1.0F, std::isfinite(pan) ? pan : 0.0F);
    float gL = 1.0F;
    float gR = 1.0F;
    equalPowerPanGains(p, gL, gR);
    // Lock-free: publishes atomic scalars. Map/pending* are message-thread-only.
    // A concurrent audio read may briefly see a mismatched pan/gain pair; each
    // value is individually valid so the worst case is a one-block transient.
    pendingPans[trackId] = p;
    auto it = runtimes.find(trackId);
    if (it != runtimes.end())
    {
        it->second->panGainL.store(gL, std::memory_order_relaxed);
        it->second->panGainR.store(gR, std::memory_order_relaxed);
        it->second->pan.store(p, std::memory_order_relaxed);
    }
}

void BusGraph::setProjectReverb(float size, float decay, float tone, float mix, bool snap)
{
    // Lock-free: `SharedFx` publishes targets + a deferred snap flag atomically; the
    // persistent target atomics are re-snapped by `sharedFx.prepare` after device changes.
    sharedFx.setReverbParams(size, decay, tone, mix, snap);
}

void BusGraph::setProjectDelay(double delayMs, float feedback, float tone, float mix, bool snap,
                               bool applyTimeNow)
{
    // Lock-free: see `setProjectReverb`.
    sharedFx.setDelayParams(delayMs, feedback, tone, mix, snap, applyTimeNow);
}

void BusGraph::resetSharedFx()
{
    // Lock-free: schedules the reset for the next audio block instead of mutating
    // decay state from the message thread.
    sharedFx.requestReset();
}

void BusGraph::snapAutomationCursors() noexcept
{
    const juce::ScopedLock sl(lock);
    for (auto& kv : runtimes)
        kv.second->automationResetRequested.store(true, std::memory_order_release);
}

void BusGraph::snapParamToDefault(const juce::String& trackId, AutomationParam p) noexcept
{
    const juce::ScopedLock sl(lock);
    auto it = runtimes.find(trackId);
    if (it == runtimes.end()) return;
    auto& rt = *it->second;
    switch (p)
    {
        case AutomationParam::filter: rt.chain.setFilterTarget(0.0F, true); break;
        case AutomationParam::toneBass: rt.chain.setBassTarget(0.0F, true); break;
        case AutomationParam::toneMid: rt.chain.setMidTarget(0.0F, true); break;
        case AutomationParam::toneTreble: rt.chain.setTrebleTarget(0.0F, true); break;
        case AutomationParam::leveler: rt.chain.setLeveler(0.0F, true); break;
        case AutomationParam::saturationDrive:
        {
            const auto saturation = pendingSaturation.find(trackId);
            rt.chain.setSaturationDriveTarget(
                saturation != pendingSaturation.end() ? saturation->second.drive : 0.0F, true);
            break;
        }
        case AutomationParam::saturationMix:
        {
            const auto saturation = pendingSaturation.find(trackId);
            rt.chain.setSaturationMixTarget(
                saturation != pendingSaturation.end() ? saturation->second.mix : 1.0F, true);
            break;
        }
        case AutomationParam::bitCrusherRate:
        {
            const auto crusher = pendingBitCrusher.find(trackId);
            rt.chain.setBitCrusherRateTarget(
                crusher != pendingBitCrusher.end() ? crusher->second.rate : 1.0F, true);
            break;
        }
        case AutomationParam::bitCrusherBits:
        {
            const auto crusher = pendingBitCrusher.find(trackId);
            rt.chain.setBitCrusherBitsTarget(
                crusher != pendingBitCrusher.end() ? static_cast<float>(crusher->second.bits) : 16.0F,
                true);
            break;
        }
        case AutomationParam::bitCrusherBoost:
        {
            const auto crusher = pendingBitCrusher.find(trackId);
            rt.chain.setBitCrusherBoostTarget(
                crusher != pendingBitCrusher.end() ? crusher->second.boost : 0.0F, true);
            break;
        }
        case AutomationParam::bitCrusherMix:
        {
            const auto crusher = pendingBitCrusher.find(trackId);
            rt.chain.setBitCrusherMixTarget(
                crusher != pendingBitCrusher.end() ? crusher->second.mix : 0.0F, true);
            break;
        }
        case AutomationParam::level: rt.chain.setLevelTarget(0.0F, true); break;
        case AutomationParam::reverbSend: rt.reverbSend.store(0.0F, std::memory_order_relaxed); break;
        case AutomationParam::delaySend: rt.delaySend.store(0.0F, std::memory_order_relaxed); break;
        case AutomationParam::pan:
            rt.pan.store(0.0F, std::memory_order_relaxed);
            rt.panGainL.store(1.0F, std::memory_order_relaxed);
            rt.panGainR.store(1.0F, std::memory_order_relaxed);
            break;
        case AutomationParam::count_: break;
    }
}

void BusGraph::setTrackAutomationPtr(const juce::String& trackId,
                                     const TrackAutomationSnapshot* snap)
{
    if (trackId.isEmpty()) return;
    const juce::ScopedLock sl(lock);
    if (snap == nullptr)
    {
        pendingAutomation.erase(trackId);
    }
    else
    {
        pendingAutomation[trackId] = snap;
    }

    auto it = runtimes.find(trackId);
    if (it != runtimes.end())
    {
        it->second->publishedAutomation = snap;
        // Automation lifetime follows the same hazard handshake as clip/runtime
        // pointers, so the caller may retire the old snapshot when this returns.
        publishRenderSnapshot();
    }
}

void BusGraph::synchronizeRenderThread()
{
    const juce::ScopedLock sl(lock);
    publishRenderSnapshot();
}

void BusGraph::drainAllTrackPeaks(std::vector<TrackPeakSnapshot>& out)
{
    // Lock-free: message-thread-only map iteration; peaks are atomic.
    out.clear();
    out.reserve(runtimes.size());
    for (auto& kv : runtimes)
    {
        float l = 0.0F;
        float r = 0.0F;
        kv.second->consumePeaks(l, r);
        out.push_back({kv.first, l, r});
    }
}

void BusGraph::clear()
{
    const juce::ScopedLock sl(lock);
    publishEmptyRenderSnapshot();
    for (auto& kv : runtimes)
        kv.second->releaseResources();
    runtimes.clear();
    clipToTrack.clear();
    pendingTone.clear();
    pendingLeveler.clear();
    pendingSaturation.clear();
    pendingBitCrusher.clear();
    pendingSends.clear();
    pendingPans.clear();
    pendingAutomation.clear();
    sharedFx.reset();
}

} // namespace silverdaw
