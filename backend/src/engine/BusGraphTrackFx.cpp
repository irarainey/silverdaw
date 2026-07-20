// Track FX target caching and lock-free parameter publication.

#include "BusGraph.h"

namespace silverdaw
{

void BusGraph::applyPendingTrackFx(TrackRuntime& runtime)
{
    const auto& trackId = runtime.trackId;
    if (const auto tone = pendingTone.find(trackId); tone != pendingTone.end())
    {
        const auto& params = tone->second;
        runtime.chain.setTone(params.bassDb, params.midDb, params.trebleDb, params.filter,
                              /*snap*/ true);
    }

    if (const auto leveler = pendingLeveler.find(trackId); leveler != pendingLeveler.end())
        runtime.chain.setLeveler(leveler->second, /*snap*/ true);
    if (const auto punch = pendingPunch.find(trackId); punch != pendingPunch.end())
        runtime.chain.setPunch(punch->second, /*snap*/ true);

    if (const auto saturation = pendingSaturation.find(trackId);
        saturation != pendingSaturation.end())
        runtime.chain.setSaturation(saturation->second.drive, saturation->second.mix,
                                    /*snap*/ true);

    if (const auto crusher = pendingBitCrusher.find(trackId);
        crusher != pendingBitCrusher.end())
        runtime.chain.setBitCrusher(crusher->second.rate, crusher->second.bits,
                                    crusher->second.boost, crusher->second.mix,
                                    /*snap*/ true);

    if (const auto sends = pendingSends.find(trackId); sends != pendingSends.end())
    {
        runtime.reverbSend.store(sends->second.reverbSend, std::memory_order_relaxed);
        runtime.delaySend.store(sends->second.delaySend, std::memory_order_relaxed);
    }

    if (const auto pan = pendingPans.find(trackId); pan != pendingPans.end())
    {
        float gainL = 1.0F;
        float gainR = 1.0F;
        equalPowerPanGains(pan->second, gainL, gainR);
        runtime.pan.store(pan->second, std::memory_order_relaxed);
        runtime.panGainL.store(gainL, std::memory_order_relaxed);
        runtime.panGainR.store(gainR, std::memory_order_relaxed);
    }
}

void BusGraph::setTrackTone(const juce::String& trackId,
                            float bassDb, float midDb, float trebleDb, float filter,
                            bool snap)
{
    if (trackId.isEmpty()) return;
    pendingTone[trackId] = {bassDb, midDb, trebleDb, filter};
    if (const auto runtime = runtimes.find(trackId); runtime != runtimes.end())
        runtime->second->chain.setTone(bassDb, midDb, trebleDb, filter, snap);
}

void BusGraph::setTrackLeveler(const juce::String& trackId, float amount, bool snap)
{
    if (trackId.isEmpty()) return;
    const float clamped = juce::jlimit(0.0F, 1.0F, std::isfinite(amount) ? amount : 0.0F);
    pendingLeveler[trackId] = clamped;
    if (const auto runtime = runtimes.find(trackId); runtime != runtimes.end())
        runtime->second->chain.setLeveler(clamped, snap);
}

void BusGraph::setTrackPunch(const juce::String& trackId, float amount, bool snap)
{
    if (trackId.isEmpty()) return;
    const float clamped = juce::jlimit(0.0F, 1.0F, std::isfinite(amount) ? amount : 0.0F);
    pendingPunch[trackId] = clamped;
    if (const auto runtime = runtimes.find(trackId); runtime != runtimes.end())
        runtime->second->chain.setPunch(clamped, snap);
}

void BusGraph::setTrackSaturation(const juce::String& trackId, float drive, float mix, bool snap)
{
    if (trackId.isEmpty()) return;
    const SaturationParams params{
        juce::jlimit(0.0F, 1.0F, std::isfinite(drive) ? drive : 0.0F),
        juce::jlimit(0.0F, 1.0F, std::isfinite(mix) ? mix : 1.0F),
    };
    pendingSaturation[trackId] = params;
    if (const auto runtime = runtimes.find(trackId); runtime != runtimes.end())
        runtime->second->chain.setSaturation(params.drive, params.mix, snap);
}

void BusGraph::setTrackBitCrusher(const juce::String& trackId, float rate, int bits,
                                  float boost, float mix, bool snap)
{
    if (trackId.isEmpty()) return;
    const BitCrusherParams params{
        juce::jlimit(0.01F, 1.0F, std::isfinite(rate) ? rate : 1.0F),
        juce::jlimit(1, 16, bits),
        juce::jlimit(0.0F, 1.0F, std::isfinite(boost) ? boost : 0.0F),
        juce::jlimit(0.0F, 1.0F, std::isfinite(mix) ? mix : 0.0F),
    };
    pendingBitCrusher[trackId] = params;
    if (const auto runtime = runtimes.find(trackId); runtime != runtimes.end())
        runtime->second->chain.setBitCrusher(params.rate, params.bits, params.boost, params.mix,
                                             snap);
}

void BusGraph::setTrackSends(const juce::String& trackId, float reverbSend, float delaySend)
{
    if (trackId.isEmpty()) return;
    const SendParams params{
        juce::jlimit(0.0F, 1.0F, std::isfinite(reverbSend) ? reverbSend : 0.0F),
        juce::jlimit(0.0F, 1.0F, std::isfinite(delaySend) ? delaySend : 0.0F),
    };
    pendingSends[trackId] = params;
    if (const auto runtime = runtimes.find(trackId); runtime != runtimes.end())
    {
        runtime->second->reverbSend.store(params.reverbSend, std::memory_order_relaxed);
        runtime->second->delaySend.store(params.delaySend, std::memory_order_relaxed);
    }
}

void BusGraph::setTrackPan(const juce::String& trackId, float pan)
{
    if (trackId.isEmpty()) return;
    const float clamped = juce::jlimit(-1.0F, 1.0F, std::isfinite(pan) ? pan : 0.0F);
    float gainL = 1.0F;
    float gainR = 1.0F;
    equalPowerPanGains(clamped, gainL, gainR);
    pendingPans[trackId] = clamped;
    if (const auto runtime = runtimes.find(trackId); runtime != runtimes.end())
    {
        runtime->second->panGainL.store(gainL, std::memory_order_relaxed);
        runtime->second->panGainR.store(gainR, std::memory_order_relaxed);
        runtime->second->pan.store(clamped, std::memory_order_relaxed);
    }
}

void BusGraph::retireTrackFxState(const juce::String& trackId)
{
    if (trackId.isEmpty()) return;

    const juce::ScopedLock sl(lock);
    pendingTone.erase(trackId);
    pendingLeveler.erase(trackId);
    pendingPunch.erase(trackId);
    pendingSaturation.erase(trackId);
    pendingBitCrusher.erase(trackId);
    pendingSends.erase(trackId);
    pendingPans.erase(trackId);
}

void BusGraph::snapParamToDefault(const juce::String& trackId, AutomationParam param) noexcept
{
    const juce::ScopedLock sl(lock);
    const auto runtime = runtimes.find(trackId);
    if (runtime == runtimes.end()) return;
    auto& track = *runtime->second;
    switch (param)
    {
        case AutomationParam::filter:
        {
            const auto tone = pendingTone.find(trackId);
            track.chain.setFilterTarget(tone != pendingTone.end() ? tone->second.filter : 0.0F, true);
            break;
        }
        case AutomationParam::toneBass:
        {
            const auto tone = pendingTone.find(trackId);
            track.chain.setBassTarget(tone != pendingTone.end() ? tone->second.bassDb : 0.0F, true);
            break;
        }
        case AutomationParam::toneMid:
        {
            const auto tone = pendingTone.find(trackId);
            track.chain.setMidTarget(tone != pendingTone.end() ? tone->second.midDb : 0.0F, true);
            break;
        }
        case AutomationParam::toneTreble:
        {
            const auto tone = pendingTone.find(trackId);
            track.chain.setTrebleTarget(tone != pendingTone.end() ? tone->second.trebleDb : 0.0F, true);
            break;
        }
        case AutomationParam::leveler:
        {
            const auto leveler = pendingLeveler.find(trackId);
            track.chain.setLeveler(leveler != pendingLeveler.end() ? leveler->second : 0.0F, true);
            break;
        }
        case AutomationParam::punch:
        {
            const auto punch = pendingPunch.find(trackId);
            track.chain.setPunchTarget(punch != pendingPunch.end() ? punch->second : 0.0F, true);
            break;
        }
        case AutomationParam::saturationDrive:
        {
            const auto saturation = pendingSaturation.find(trackId);
            track.chain.setSaturationDriveTarget(
                saturation != pendingSaturation.end() ? saturation->second.drive : 0.0F, true);
            break;
        }
        case AutomationParam::saturationMix:
        {
            const auto saturation = pendingSaturation.find(trackId);
            track.chain.setSaturationMixTarget(
                saturation != pendingSaturation.end() ? saturation->second.mix : 1.0F, true);
            break;
        }
        case AutomationParam::bitCrusherRate:
        {
            const auto crusher = pendingBitCrusher.find(trackId);
            track.chain.setBitCrusherRateTarget(
                crusher != pendingBitCrusher.end() ? crusher->second.rate : 1.0F, true);
            break;
        }
        case AutomationParam::bitCrusherBits:
        {
            const auto crusher = pendingBitCrusher.find(trackId);
            track.chain.setBitCrusherBitsTarget(
                crusher != pendingBitCrusher.end() ? static_cast<float>(crusher->second.bits) : 16.0F,
                true);
            break;
        }
        case AutomationParam::bitCrusherBoost:
        {
            const auto crusher = pendingBitCrusher.find(trackId);
            track.chain.setBitCrusherBoostTarget(
                crusher != pendingBitCrusher.end() ? crusher->second.boost : 0.0F, true);
            break;
        }
        case AutomationParam::bitCrusherMix:
        {
            const auto crusher = pendingBitCrusher.find(trackId);
            track.chain.setBitCrusherMixTarget(
                crusher != pendingBitCrusher.end() ? crusher->second.mix : 0.0F, true);
            break;
        }
        case AutomationParam::level: track.chain.setLevelTarget(0.0F, true); break;
        case AutomationParam::reverbSend:
        {
            const auto sends = pendingSends.find(trackId);
            track.reverbSend.store(sends != pendingSends.end() ? sends->second.reverbSend : 0.0F,
                                   std::memory_order_relaxed);
            break;
        }
        case AutomationParam::delaySend:
        {
            const auto sends = pendingSends.find(trackId);
            track.delaySend.store(sends != pendingSends.end() ? sends->second.delaySend : 0.0F,
                                  std::memory_order_relaxed);
            break;
        }
        case AutomationParam::pan:
        {
            const auto pan = pendingPans.find(trackId);
            const float value = pan != pendingPans.end() ? pan->second : 0.0F;
            float gainL = 1.0F;
            float gainR = 1.0F;
            equalPowerPanGains(value, gainL, gainR);
            track.pan.store(value, std::memory_order_relaxed);
            track.panGainL.store(gainL, std::memory_order_relaxed);
            track.panGainR.store(gainR, std::memory_order_relaxed);
            break;
        }
        case AutomationParam::count_: break;
    }
}

void BusGraph::clearPendingTrackFx()
{
    pendingTone.clear();
    pendingLeveler.clear();
    pendingPunch.clear();
    pendingSaturation.clear();
    pendingBitCrusher.clear();
    pendingSends.clear();
    pendingPans.clear();
}

} // namespace silverdaw
