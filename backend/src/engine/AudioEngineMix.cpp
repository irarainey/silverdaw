// Mix: master gain, metronome, metering, tone/leveler/sends/pan, automation publication,
// project FX, and state getters. All methods are message-thread-only unless noted.
#include "AudioEngine.h"

namespace silverdaw
{

void AudioEngine::setMasterGain(float gain)
{
    const float clamped = juce::jlimit(0.0F, 1.0F, gain);
    masterMeter.setTargetGain(clamped);
}

void AudioEngine::setSafetyLimiterEnabled(bool enabled, bool snap)
{
    masterMeter.setSafetyLimiterEnabled(enabled, snap);
}

void AudioEngine::setMetronomeEnabled(bool enabled)
{
    metronome.setEnabled(enabled);
}

void AudioEngine::setMetronomeBpm(double bpm)
{
    metronome.setBpm(bpm);
}

void AudioEngine::consumeMasterPeaks(float& outL, float& outR)
{
    masterMeter.consumePeaks(outL, outR);
}

bool AudioEngine::consumeTrackPeaks(const juce::String& trackId, float& outL, float& outR)
{
    return busGraph.consumeTrackPeaks(trackId, outL, outR);
}

void AudioEngine::setTrackTone(const juce::String& trackId,
                               float bassDb, float midDb, float trebleDb, float filter,
                               bool snap)
{
    busGraph.setTrackTone(trackId, bassDb, midDb, trebleDb, filter, snap);
}

void AudioEngine::setTrackLeveler(const juce::String& trackId, float amount, bool snap)
{
    busGraph.setTrackLeveler(trackId, amount, snap);
}

void AudioEngine::setTrackSaturation(const juce::String& trackId,
                                     float drive, float mix, bool snap)
{
    busGraph.setTrackSaturation(trackId, drive, mix, snap);
}

void AudioEngine::setTrackBitCrusher(const juce::String& trackId, float rate, int bits,
                                     float boost, float mix, bool snap)
{
    busGraph.setTrackBitCrusher(trackId, rate, bits, boost, mix, snap);
}

void AudioEngine::setTrackSends(const juce::String& trackId, float reverbSend, float delaySend)
{
    busGraph.setTrackSends(trackId, reverbSend, delaySend);
}

void AudioEngine::setTrackPan(const juce::String& trackId, float pan)
{
    busGraph.setTrackPan(trackId, pan);
}

void AudioEngine::setTrackAutomation(const juce::String& trackId, const juce::String& paramId,
                                     const juce::Array<juce::var>& points)
{
    if (trackId.isEmpty()) return;
    AutomationParam param{};
    if (!automationParamFromString(paramId, param)) return;

    // Build a fresh immutable snapshot from the track's existing lanes, swapping
    // in this param's new curve. Then publish the raw pointer and retire the old.
    auto next = std::make_unique<TrackAutomationSnapshot>();
    if (auto it = automationCurrent.find(trackId); it != automationCurrent.end() && it->second)
    {
        const auto& prev = *it->second;
        for (int i = 0; i < TrackAutomationSnapshot::kNumParams; ++i)
        {
            if (i == static_cast<int>(param)) continue;
            if (prev.has[i])
            {
                next->has[i] = true;
                next->curves[i] = prev.curves[i];
            }
        }
    }

    if (points.size() >= 2)
    {
        const int pi = static_cast<int>(param);
        // Pan / tone interpolate musically in their native unit; all current params
        // are linear (signed positions, dB values, 0..1 levels).
        BreakpointCurve curve(InterpDomain::linear);
        curve.reserve(static_cast<std::size_t>(points.size()));
        for (const auto& p : points)
        {
            if (!p.isObject()) continue;
            const double t = static_cast<double>(p.getProperty("timeMs", 0.0));
            const double v = static_cast<double>(p.getProperty("value", 0.0));
            curve.addPoint(t, static_cast<float>(v));
        }
        curve.finalise();
        if (!curve.isEmpty())
        {
            next->has[pi] = true;
            next->curves[pi] = std::move(curve);
        }
    }

    if (!next->hasAny())
    {
        busGraph.setTrackAutomationPtr(trackId, nullptr);
        if (auto it = automationCurrent.find(trackId); it != automationCurrent.end())
        {
            if (it->second)
            {
                for (int i = 0; i < TrackAutomationSnapshot::kNumParams; ++i)
                    if (it->second->has[i])
                        busGraph.snapParamToDefault(trackId, static_cast<AutomationParam>(i));
                retiredAutomation.push_back(std::move(it->second));
            }
            automationCurrent.erase(it);
        }
        return;
    }

    // Any param that had a lane but no longer does must snap back to neutral, or the
    // chain would hold its last automated value (stuck filter/level after a clear).
    if (auto it = automationCurrent.find(trackId); it != automationCurrent.end() && it->second)
    {
        for (int i = 0; i < TrackAutomationSnapshot::kNumParams; ++i)
            if (it->second->has[i] && !next->has[i])
                busGraph.snapParamToDefault(trackId, static_cast<AutomationParam>(i));
    }

    busGraph.setTrackAutomationPtr(trackId, next.get());
    if (auto it = automationCurrent.find(trackId); it != automationCurrent.end())
    {
        if (it->second) retiredAutomation.push_back(std::move(it->second));
        it->second = std::move(next);
    }
    else
    {
        automationCurrent.emplace(trackId, std::move(next));
    }
}

void AudioEngine::clearAllTrackAutomation(const juce::String& trackId)
{
    if (trackId.isEmpty()) return;
    auto it = automationCurrent.find(trackId);
    if (it == automationCurrent.end()) return; // already clear — nothing published for this track

    busGraph.setTrackAutomationPtr(trackId, nullptr);
    if (it->second)
    {
        // Snap each previously-automated param to neutral so the chain doesn't hold its last value.
        for (int i = 0; i < TrackAutomationSnapshot::kNumParams; ++i)
            if (it->second->has[i])
                busGraph.snapParamToDefault(trackId, static_cast<AutomationParam>(i));
        retiredAutomation.push_back(std::move(it->second));
    }
    automationCurrent.erase(it);
}

void AudioEngine::setProjectReverb(float size, float decay, float tone, float mix, bool snap)
{
    busGraph.setProjectReverb(size, decay, tone, mix, snap);
}

void AudioEngine::setProjectDelay(double delayMs, float feedback, float tone, float mix, bool snap)
{
    busGraph.setProjectDelay(delayMs, feedback, tone, mix, snap,
                             /*applyTimeNow*/ ! master.isPlaying());
}

void AudioEngine::drainAllTrackPeaks(std::vector<BusGraph::TrackPeakSnapshot>& out)
{
    busGraph.drainAllTrackPeaks(out);
}

bool AudioEngine::isPlaying() const
{
    return master.isPlaying();
}

bool AudioEngine::isContentLoaded() const
{
    return master.isContentLoaded();
}

double AudioEngine::getPositionMs() const
{
    const double sr = master.getSampleRate();
    if (sr <= 0.0)
    {
        return 0.0;
    }
    const auto pos = master.getPositionSamples();
    return (static_cast<double>(pos) / sr) * 1000.0;
}

double AudioEngine::getClipDurationMs(const juce::String& clipId) const
{
    const auto it = tracks.find(clipId);
    if (it == tracks.end() || it->second->readerSource == nullptr)
    {
        return 0.0;
    }
    auto* reader = it->second->readerSource->getAudioFormatReader();
    if (reader == nullptr || reader->sampleRate <= 0.0)
    {
        return 0.0;
    }
    return (static_cast<double>(reader->lengthInSamples) / reader->sampleRate) * 1000.0;
}

} // namespace silverdaw
