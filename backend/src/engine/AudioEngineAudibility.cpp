#include "AudioEngine.h"

namespace silverdaw
{

void AudioEngine::setTrackAudible(const juce::String& trackId, bool audible)
{
    juce::AudioBuffer<float> scratch(2, kPrimeReadyTargetSamples);
    setTrackAudibleUntil(
        trackId, audible,
        juce::Time::getMillisecondCounterHiRes() + kPrimePerTrackTimeoutMs,
        scratch);
}

void AudioEngine::setTracksAudible(
    const std::vector<std::pair<juce::String, bool>>& audibility)
{
    const double deadline =
        juce::Time::getMillisecondCounterHiRes() + kPrimePerTrackTimeoutMs;
    juce::AudioBuffer<float> scratch(2, kPrimeReadyTargetSamples);
    for (const auto& [trackId, audible] : audibility)
        setTrackAudibleUntil(trackId, audible, deadline, scratch);
}

void AudioEngine::setTrackAudibleUntil(
    const juce::String& trackId, bool audible, double prefetchDeadlineMs,
    juce::AudioBuffer<float>& prefetchScratch)
{
    if (trackId.isEmpty()) return;
    const auto existing = trackAudibility.find(trackId);
    if (existing != trackAudibility.end() && existing->second == audible) return;
    trackAudibility[trackId] = audible;

    pendingTrackBypasses.erase(trackId);
    if (!audible)
    {
        if (master.isPlaying())
        {
            busGraph.requestTrackBypass(trackId);
            pendingTrackBypasses.insert(trackId);
            trackBypassTimer.startTimer(kTrackBypassPollMs);
        }
        else
        {
            busGraph.setTrackRenderingEnabled(trackId, false);
        }
        return;
    }

    // Keep the track outside the callback while stale transports are moved
    // from their last rendered position to the current master playhead.
    busGraph.setTrackRenderingEnabled(trackId, false);
    bool allReady = true;
    for (auto& [clipId, track] : tracks)
    {
        if (track->trackId != trackId || track->transportSource == nullptr
            || track->bufferingSource == nullptr)
        {
            continue;
        }

        const double seekSeconds =
            trackSeekSecondsFor(*track, master.getPositionSamples());
        if (track->prefetchDirty)
            recreateTrackPrefetch(*track, seekSeconds);
        else
            track->transportSource->setPosition(seekSeconds);
        track->transportSource->start();
        track->prefetchDirty = false;

        if (master.isPlaying())
            allReady = waitForTrackPrefetch(
                           *track, prefetchDeadlineMs, prefetchScratch)
                       && allReady;
    }

    if (!allReady)
        silverdaw::log::warn("engine", "track unmute prefetch incomplete id=" + trackId);
    busGraph.setTrackRenderingEnabled(trackId, true);
}

void AudioEngine::flushPendingTrackBypasses()
{
    for (auto it = pendingTrackBypasses.begin();
         it != pendingTrackBypasses.end();)
    {
        bool complete = true;
        if (master.isPlaying())
            complete = busGraph.finalizeTrackBypass(*it);
        else
            busGraph.setTrackRenderingEnabled(*it, false);

        if (complete)
        {
            it = pendingTrackBypasses.erase(it);
        }
        else
        {
            ++it;
        }
    }
    if (pendingTrackBypasses.empty())
        trackBypassTimer.stopTimer();
}

bool AudioEngine::isTrackAudible(const juce::String& trackId) const noexcept
{
    const auto it = trackAudibility.find(trackId);
    return it == trackAudibility.end() || it->second;
}

} // namespace silverdaw
