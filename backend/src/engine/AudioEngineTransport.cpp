// Transport: play, prime, pause, stop, and retired-snapshot reclamation.
// All methods are message-thread-only.
#include "AudioEngine.h"
#include "AudioConstants.h"
#include "Log.h"

namespace silverdaw
{

void AudioEngine::play()
{
    if (pendingTransportAction != PendingTransportAction::none)
    {
        pendingTransportAction = PendingTransportAction::none;
        transportFadeTimer.stopTimer();
        master.requestOutputFadeIn();
        master.cancelScrub();
        return;
    }
    master.cancelScrub();
    rebuildTimer.stopTimer();
    pendingSeekPrewarm = false;
    const auto primeStart = juce::Time::getMillisecondCounterHiRes();
    flushAllDirtyRebuildsSync();

    if (! primeTracksForPlayback(kPlayPrimeBudgetMs))
    {
        silverdaw::log::warn("engine",
                             "play deferred: tracks not ready after prime budget (tracks=" +
                                 juce::String(static_cast<int>(tracks.size())) +
                                 " pos=" + juce::String(master.getPositionSamples()) +
                                 ") — gate kept closed to avoid a silent first play");
        return;
    }
    // Message-thread time spent rebuilding and refilling read-ahead buffers before the gate
    // opens. Near zero when a prior seek settle left them warm; anything above a few ms is
    // heard as a stall on the first beat, so it is logged to make that measurable.
    const double primeMs = juce::Time::getMillisecondCounterHiRes() - primeStart;

    // Fill the plugin delay lines before the gate opens, so the first block already carries
    // audio instead of the alignment's worth of silence (ADR 0026).
    primePluginPipeline();

    // On a sleep-prone (USB) endpoint, MasterClockSource runs a short audio-thread wake pre-roll
    // here (it emits the louder wake burst without advancing the transport) so the DAC's auto-mute
    // amp is roused before the downbeat — the opening beat is never swallowed. The holding dither
    // keeps a warm device awake but is too quiet to wake a cold/relaxed amp on its own. The pre-roll
    // runs entirely on the audio thread (no message-thread block) and preserves the downbeat
    // position; non-sleep-prone endpoints skip it and play instantly.
    master.setPlaying(true);
    busGraph.snapAutomationCursors();
    updateTimelineLoopTimer();
    silverdaw::log::info("engine", "play (tracks=" + juce::String(static_cast<int>(tracks.size())) +
                                       " pos=" + juce::String(master.getPositionSamples()) +
                                       " primeMs=" + juce::String(primeMs, 1) + " wakePreroll=" +
                                       (outputKeepAlive.isKeepAwakeEnabled() ? "on" : "off") + ")");
}

bool AudioEngine::primeTracksForPlayback(int totalBudgetMs)
{
    if (master.getSampleRate() <= 0.0)
    {
        return false;
    }

    const double deadline = juce::Time::getMillisecondCounterHiRes() +
                            static_cast<double>(juce::jmax(0, totalBudgetMs));
    juce::AudioBuffer<float> scratch(2, kPrimeReadyTargetSamples);

    // Rebuild stale JUCE read-ahead buffers after timeline changes so playback starts at the
    // new position.
    std::vector<Track*> notReady;
    notReady.reserve(tracks.size());
    for (auto& [id, track] : tracks)
    {
        if (track->transportSource == nullptr || track->bufferingSource == nullptr)
        {
            continue;
        }
        if (!isTrackAudible(track->trackId))
        {
            continue;
        }
        const double seekSeconds = trackSeekSecondsFor(*track, master.getPositionSamples());
        track->transportSource->setPosition(seekSeconds);
        // A track transport that previously played to the end of its source has
        // auto-stopped (AudioTransportSource clears `playing` at EOF). Repositioning
        // alone does NOT clear that state, so without restarting it the transport
        // would emit silence forever. This bit short clips such as separated stems
        // (which reach their EOF within a bar) after the first full play-through;
        // long clips rarely hit EOF so never surfaced it. Restart here, before every
        // play primes, so a re-seek + play always resumes output. start() is
        // idempotent for an already-playing transport.
        track->transportSource->start();

        // Settle the transport's internal gain ramp before the master gate opens.
        // AudioTransportSource ramps from the previous rendered block's gain (lastGain)
        // to the current gain across the first block it renders, then catches lastGain
        // up. While the master is gated the audio thread does not pull these transports,
        // so a gain changed during that window — e.g. a track muted by engaging solo —
        // leaves lastGain stale (at the old, audible level). The first block after the
        // gate opens would then ramp the now-muted content from its old gain down to
        // zero: a one-block fade-out leaking into the output = an audible click on the
        // first play after the change. Pump a single throwaway sample here (safe: the
        // gate is closed, so only this message thread touches the transport) to run the
        // gain-settle so lastGain == gain, then re-seek to undo the one-sample advance.
        // The pump can reach a short clip's EOF and auto-stop the transport, so restart
        // again afterwards (only start() clears the EOF-stopped state).
        juce::AudioSourceChannelInfo settleInfo(&scratch, 0, 1);
        scratch.clear(0, 1);
        track->transportSource->getNextAudioBlock(settleInfo);
        track->transportSource->setPosition(seekSeconds);
        track->transportSource->start();

        notReady.push_back(track.get());
    }

    while (! notReady.empty())
    {
        const double remaining = deadline - juce::Time::getMillisecondCounterHiRes();
        if (remaining <= 0.0)
        {
            break;
        }

        for (auto it = notReady.begin(); it != notReady.end();)
        {
            Track* track = *it;
            const double passRemaining = deadline - juce::Time::getMillisecondCounterHiRes();
            if (passRemaining <= 0.0)
            {
                break;
            }

            if (waitForTrackPrefetch(*track, deadline, scratch))
            {
                track->prefetchDirty = false;
                it = notReady.erase(it);
            }
            else
            {
                ++it;
            }
        }
    }

    for (Track* track : notReady)
    {
        for (auto& [id, t] : tracks)
        {
            if (t.get() == track)
            {
                silverdaw::log::warn("engine", "prime incomplete id=" + id);
                break;
            }
        }
    }
    return notReady.empty();
}

// The master is gated here, so MasterClockSource never pulls the graph and this is the only
// thread rendering it. Advancing the transport per block keeps automation and the plugin
// play head in step with the audio being pushed through (ADR 0026).
void AudioEngine::primePluginPipeline()
{
    const int alignment = busGraph.getLatencyCompensationSamples();
    if (alignment <= 0) return;
    // Only safe with the gate closed; anything else would race the audio thread.
    if (master.isPlaying()) return;

    const int block = juce::jmax(1, busGraph.getPreparedBlockSize());
    const juce::int64 startSamples = master.getPositionSamples();
    juce::AudioBuffer<float> discard(2, block);

    for (int primed = 0; primed < alignment;)
    {
        const int n = juce::jmin(block, alignment - primed);
        master.setPositionSamples(startSamples + primed);
        discard.clear();
        juce::AudioSourceChannelInfo info(&discard, 0, n);
        busGraph.getNextAudioBlock(info);
        primed += n;
    }

    // The render cursor now leads the audible one by the alignment, exactly as it already
    // leads by the device's own output latency.
    master.setPositionSamples(startSamples + alignment);
}

bool AudioEngine::waitForTrackPrefetch(Track& track, double deadlineMs,
                                       juce::AudioBuffer<float>& scratch)
{
    if (track.bufferingSource == nullptr) return true;

    int want = kPrimeReadyTargetSamples;
    const juce::int64 total = track.bufferingSource->getTotalLength();
    if (total > 0)
    {
        const juce::int64 left =
            total - track.bufferingSource->getNextReadPosition();
        want = static_cast<int>(
            juce::jlimit<juce::int64>(0, kPrimeReadyTargetSamples, left));
    }
    if (want <= 0) return true;

    const double remaining =
        deadlineMs - juce::Time::getMillisecondCounterHiRes();
    if (remaining <= 0.0) return false;

    juce::AudioSourceChannelInfo info(&scratch, 0, want);
    const auto timeout = static_cast<juce::uint32>(
        juce::jmin(remaining, static_cast<double>(kPrimePerTrackTimeoutMs)));
    return track.bufferingSource->waitForNextAudioBlockReady(info, timeout);
}

void AudioEngine::setTimelineLoop(std::optional<LoopRange> range)
{
    timelineLoop = range;
    updateTimelineLoopTimer();
}

void AudioEngine::updateTimelineLoopTimer()
{
    if (timelineLoop.has_value() && master.isPlaying())
        timelineLoopTimer.startTimer(kTimelineLoopPollMs);
    else
        timelineLoopTimer.stopTimer();
}

// Wrapping on the engine's own uncompensated position lands the restart at the loop end in
// the rendered stream. The renderer's playhead is latency-compensated, so a renderer-driven
// wrap could only ever ask for the seek after the engine had already rendered (and queued)
// audio past the end. setPositionMsNow is the immediate seek path — no output fade-out /
// fade-in ramp, and reverb and delay tails carry across the wrap.
void AudioEngine::wrapTimelineLoopIfDue()
{
    if (! timelineLoop.has_value() || ! master.isPlaying())
    {
        updateTimelineLoopTimer();
        return;
    }
    // A pending pause / stop / seek fade owns the transport until it completes.
    if (pendingTransportAction != PendingTransportAction::none) return;
    if (getPositionMs() < timelineLoop->endMs) return;

    setPositionMsNow(timelineLoop->startMs, /*resetEffects*/ false);
}

void AudioEngine::pause()
{
    master.cancelScrub();
    if (!master.isPlaying())
    {
        reclaimRetiredPlaybackSnapshots();
        return;
    }

    pendingTransportAction = PendingTransportAction::pause;
    master.requestOutputFadeOut();
    transportFadeTimer.startTimer(kTransportFadePollMs);
}

void AudioEngine::stop()
{
    master.cancelScrub();
    if (master.isPlaying())
    {
        pendingTransportAction = PendingTransportAction::stop;
        master.requestOutputFadeOut();
        transportFadeTimer.startTimer(kTransportFadePollMs);
        return;
    }

    master.setPositionSamples(0);
    busGraph.resetSharedFx();
    busGraph.resetBeatRepeats();
    for (auto& [id, track] : tracks)
        if (track->transportSource != nullptr)
            track->transportSource->setPosition(trackSeekSecondsFor(*track, 0));
    reclaimRetiredPlaybackSnapshots();
    silverdaw::log::info("engine", "stop");
}

void AudioEngine::completePendingTransportFade()
{
    if (pendingTransportAction == PendingTransportAction::none
        || !master.isOutputFadeOutComplete())
        return;

    const auto action = pendingTransportAction;
    pendingTransportAction = PendingTransportAction::none;
    transportFadeTimer.stopTimer();

    switch (action)
    {
        case PendingTransportAction::pause:
            master.setPlaying(false);
            updateTimelineLoopTimer();
            // Now that the transport is genuinely stopped, a seek that arrived during the
            // fade can be applied on the immediate path without restarting playback.
            if (pendingSeekAfterPauseMs.has_value())
                setPositionMsNow(*pendingSeekAfterPauseMs, /*resetEffects*/ false);
            pendingSeekAfterPauseMs.reset();
            reclaimRetiredPlaybackSnapshots();
            silverdaw::log::info(
                "engine", "pause (pos=" + juce::String(master.getPositionSamples()) + ")");
            break;

        case PendingTransportAction::stop:
            master.setPlaying(false);
            updateTimelineLoopTimer();
            pendingSeekAfterPauseMs.reset();
            master.setPositionSamples(0);
            busGraph.resetSharedFx();
            busGraph.resetBeatRepeats();
            for (auto& [id, track] : tracks)
                if (track->transportSource != nullptr)
                    track->transportSource->setPosition(trackSeekSecondsFor(*track, 0));
            reclaimRetiredPlaybackSnapshots();
            silverdaw::log::info("engine", "stop");
            break;

        case PendingTransportAction::seek:
            setPositionMsNow(pendingTransportPositionMs, pendingTransportResetEffects);
            flushAllDirtyRebuildsSync();
            rebuildTimer.stopTimer();
            master.requestOutputFadeIn();
            break;

        case PendingTransportAction::none: break;
    }
}

void AudioEngine::reclaimRetiredPlaybackSnapshots()
{
    // Publishing an equivalent graph snapshot makes every callback that could
    // still hold a superseded clip/automation pointer finish before reclamation.
    busGraph.synchronizeRenderThread();
    for (auto& [id, track] : tracks)
    {
        track->retiredWarps.clear();
        track->retiredEnvelopes.clear();
        track->retiredEdgeFades.clear();
        track->retiredBrakes.clear();
        track->retiredBackspins.clear();
    }
    retiredAutomation.clear();
    retiredBeatRepeats.clear();
}

std::size_t AudioEngine::retiredPlaybackSnapshotCount() const noexcept
{
    std::size_t count = retiredAutomation.size()
                      + retiredBeatRepeats.size()
                      + preview.retiredWarps.size()
                      + preview.retiredEnvelopes.size()
                      + preview.retiredBrakes.size()
                      + preview.retiredBackspins.size();
    for (const auto& [id, track] : tracks)
    {
        count += track->retiredWarps.size()
               + track->retiredEnvelopes.size()
               + track->retiredEdgeFades.size()
               + track->retiredBrakes.size()
               + track->retiredBackspins.size();
    }
    return count;
}

} // namespace silverdaw
