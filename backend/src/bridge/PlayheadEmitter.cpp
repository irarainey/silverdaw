#include "PlayheadEmitter.h"

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "Log.h"
#include "MidiDeviceCommands.h"
#include "ProjectState.h"
#include "ScratchSessionCommands.h"

namespace silverdaw
{

PlayheadEmitter::PlayheadEmitter(AudioEngine& e, BridgeServer& b, ProjectState& p)
    : engine(e),
      bridge(b),
      project(p),
      payloadObject(new juce::DynamicObject()),
      payload(payloadObject.get())
{
}

void PlayheadEmitter::timerCallback()
{
    const bool playing = engine.isPlaying();
    engine.reconcileScratchSessionSourceEnd();
    const auto scratchState = engine.getScratchSessionSnapshot();
    const bool scratchPlaying = scratchState
        && (scratchState->status == "playing" || scratchState->status == "recording");
    sendMidiTransportPlaying(scratchState ? scratchPlaying : playing);
    const double rawPosMs = engine.getPositionMs();

    // Compensate only during playback so the playhead matches heard audio without moving seek anchors.
    const double latencyMs = playing ? engine.getOutputLatencyMs() : 0.0;
    const double posMs = playing ? juce::jmax(0.0, rawPosMs - latencyMs) : rawPosMs;
    sendMidiMarkerLights(project.hasMarkerNear(posMs), project.getMarkerCount());

    // Reuse payload storage to avoid 60 Hz message-thread heap churn.
    if (playing || posMs != lastPosMs)
    {
        payloadObject->setProperty("positionMs", posMs);
        payloadObject->setProperty("isPlaying", playing);
        bridge.broadcast("PLAYHEAD_UPDATE", payload);
        lastPosMs = posMs;
    }

    // Preview transport is independent. A trimmed clip/library-clip preview keeps
    // streaming past its window (still inside the file) so `isPreviewPlaying()`
    // stays true and the position check below catches the window end. A full-file
    // sample preview, however, hits true end-of-file at exactly `durationMs`: JUCE
    // auto-stops the transport, so `isPreviewPlaying()` has already flipped false
    // by the time the position reaches the end. Without also checking the
    // stream-finished flag, that case never emits `PREVIEW_ENDED`, so the clip
    // editor's loop never restarts. `stopPreview()` resets the position (and the
    // stream-finished flag), so this fires exactly once per natural end.
    const bool previewPlaying = engine.isPreviewPlaying();
    const double previewPos = engine.getPreviewPositionMs();
    const double previewDur = engine.getPreviewDurationMs();
    const bool reachedWindowEnd = previewPlaying && previewDur > 0.0 && previewPos >= previewDur;
    const bool streamFinished = engine.isPreviewFinished();
    if (reachedWindowEnd || streamFinished)
    {
        engine.stopPreview();
        auto* endedObj = new juce::DynamicObject();
        endedObj->setProperty("generation", static_cast<juce::int64>(engine.getPreviewGeneration()));
        bridge.broadcast("PREVIEW_ENDED", juce::var(endedObj));
        auto* stateObj = new juce::DynamicObject();
        stateObj->setProperty("isPlaying", false);
        stateObj->setProperty("isLoaded", engine.isPreviewLoaded());
        stateObj->setProperty("durationMs", previewDur);
        stateObj->setProperty("generation", static_cast<juce::int64>(engine.getPreviewGeneration()));
        bridge.broadcast("PREVIEW_STATE", juce::var(stateObj));
        lastPreviewPosMs = 0.0;
    }
    else if (previewPlaying || previewPos != lastPreviewPosMs)
    {
        previewPayloadObject->setProperty("positionMs", previewPos);
        previewPayloadObject->setProperty("isPlaying", previewPlaying);
        previewPayloadObject->setProperty(
            "generation", static_cast<juce::int64>(engine.getPreviewGeneration()));
        bridge.broadcast("PREVIEW_POSITION", previewPayload);
        lastPreviewPosMs = previewPos;
    }

    // ── Scratch session state emission (~15 Hz + end-stop reconciliation) ────
    {
        const bool reconciled = engine.reconcileScratchSessionSourceEnd();
        if (reconciled || ++scratchStateTick >= 2)
        {
            scratchStateTick = 0;
            const auto emittedScratchState = engine.getScratchSessionSnapshot();
            if (emittedScratchState)
            {
                const bool statusChanged = emittedScratchState->status != lastScratchStatus;
                const bool crossfaderChanged =
                    emittedScratchState->crossfader != lastScratchCrossfader;
                lastScratchStatus = emittedScratchState->status;
                lastScratchCrossfader = emittedScratchState->crossfader;
                if (statusChanged
                    || crossfaderChanged
                    || emittedScratchState->status == "playing"
                    || emittedScratchState->status == "recording"
                    || emittedScratchState->replaying
                    || emittedScratchState->touched)
                {
                    broadcastScratchSessionState(engine, bridge);
                }
            }
            else
            {
                lastScratchStatus = {};
                lastScratchCrossfader = -1.0;
            }
        }
    }

    // Gate meter broadcasts, but emit one trailing zero so renderer decay can finish.
    float peakL = 0.0F;
    float peakR = 0.0F;
    engine.consumeMasterPeaks(peakL, peakR);
    constexpr float kMeterEpsilon = 1.0e-5F;
    const bool hasSignal = peakL > kMeterEpsilon || peakR > kMeterEpsilon;
    if (hasSignal || lastMasterLevelHadSignal)
    {
        masterLevelObject->setProperty("peakL", static_cast<double>(peakL));
        masterLevelObject->setProperty("peakR", static_cast<double>(peakR));
        bridge.broadcast("MASTER_LEVEL", masterLevelPayload);
        lastMasterLevelHadSignal = hasSignal;
    }

    // Accumulate post-master peaks on the message thread so diagnostics miss fewer transients.
    if (playing)
    {
        masterPeakLogMaxL = juce::jmax(masterPeakLogMaxL, peakL);
        masterPeakLogMaxR = juce::jmax(masterPeakLogMaxR, peakR);
    }
    else
    {
        masterPeakLogMaxL = 0.0F;
        masterPeakLogMaxR = 0.0F;
    }
    const double nowMs = juce::Time::getMillisecondCounterHiRes();
    // Idle/paused output is true silence, so logging it would spam zeros.
    if (playing && (nowMs - lastMasterPeakLogMs) >= kMasterPeakLogIntervalMs)
    {
        silverdaw::log::debug("perf.master",
                              "playing=" + juce::String(playing ? 1 : 0) +
                                  " peakL=" + juce::String(masterPeakLogMaxL, 5) +
                                  " peakR=" + juce::String(masterPeakLogMaxR, 5) +
                                  " posMs=" + juce::String(rawPosMs, 1));
        lastMasterPeakLogMs = nowMs;
        masterPeakLogMaxL = 0.0F;
        masterPeakLogMaxR = 0.0F;
    }

    // Surface any audio blocks the bus graph dropped under contention. Logged on
    // the message thread (never the audio thread) and only when newly dropped.
    const juce::uint64 skipped = engine.busGraphSkippedBlocks();
    if (skipped != lastSkippedBlocks)
    {
        silverdaw::log::warn("engine.audio",
                             "busGraph skipped " + juce::String(skipped - lastSkippedBlocks) +
                                 " audio block(s) under message-thread contention (total=" +
                                 juce::String(skipped) + ")");
        lastSkippedBlocks = skipped;
    }

    // perf.audio: the audio thread publishes raw block timing lock-free; format
    // and log it here, off the real-time thread. Reports worst-case elapsed since
    // the last drain so transient overruns stay visible.
    if ((nowMs - lastAudioPerfLogMs) >= kAudioPerfLogIntervalMs)
    {
        const auto perf = engine.drainAudioPerf();
        const double budgetMs = perf.sampleRate > 0.0 && perf.numSamples > 0
                                    ? (static_cast<double>(perf.numSamples) * 1000.0) / perf.sampleRate
                                    : 0.0;
        const double pct = budgetMs > 0.0 ? (perf.maxElapsedMs / budgetMs) * 100.0 : 0.0;
        silverdaw::log::debug("perf.audio",
                              "cb#" + juce::String(static_cast<juce::int64>(perf.callbackCount)) +
                                  " playing=" + juce::String(perf.playing ? 1 : 0) +
                                  " pos=" + juce::String(perf.positionSamples) +
                                  " elapsedMs=" + juce::String(perf.maxElapsedMs, 3) +
                                  " budgetMs=" + juce::String(budgetMs, 3) +
                                  " budgetPct=" + juce::String(pct, 1));
        lastAudioPerfLogMs = nowMs;
    }

    // Per-track meters use the same activity gate and one trailing zero as master.
    engine.drainAllTrackPeaks(trackPeakScratch);
    bool anyTrackHasSignal = false;
    float selectedTrackPeakL = 0.0F;
    float selectedTrackPeakR = 0.0F;
    const auto selectedTrackId = project.getViewSelectedTrack();
    for (const auto& snap : trackPeakScratch)
    {
        if (snap.trackId == selectedTrackId)
        {
            selectedTrackPeakL = snap.peakL;
            selectedTrackPeakR = snap.peakR;
        }
        if (snap.peakL > kMeterEpsilon || snap.peakR > kMeterEpsilon)
            anyTrackHasSignal = true;
    }
    // MIDI output deduplicates values; this unconditional call also clears meters on stop.
    sendMidiSelectedTrackMeter(selectedTrackPeakL, selectedTrackPeakR,
                               playing && selectedTrackId.isNotEmpty());

    // perf.tracks: accumulate each track's peak between emissions so a track that
    // falls silent after a gain/filter change is identifiable in the backend log
    // (the master meter hides a single muted track). Cleared when idle to avoid
    // logging stale peaks.
    if (playing)
    {
        for (const auto& snap : trackPeakScratch)
        {
            auto& acc = tracksPeakLogMax[snap.trackId];
            acc.first = juce::jmax(acc.first, snap.peakL);
            acc.second = juce::jmax(acc.second, snap.peakR);
        }
        if ((nowMs - lastTracksPeakLogMs) >= kTracksPeakLogIntervalMs && ! tracksPeakLogMax.empty())
        {
            juce::String line("playing=1 posMs=" + juce::String(rawPosMs, 1));
            for (const auto& kv : tracksPeakLogMax)
                line << " [" << kv.first << " L=" << juce::String(kv.second.first, 5)
                     << " R=" << juce::String(kv.second.second, 5) << "]";
            silverdaw::log::debug("perf.tracks", line);
            lastTracksPeakLogMs = nowMs;
            tracksPeakLogMax.clear();
        }
    }
    else if (! tracksPeakLogMax.empty())
    {
        tracksPeakLogMax.clear();
    }

    if (anyTrackHasSignal || lastTrackLevelsHadSignal)
    {
        juce::Array<juce::var> tracksVar;
        tracksVar.ensureStorageAllocated(static_cast<int>(trackPeakScratch.size()));
        for (const auto& snap : trackPeakScratch)
        {
            auto* trackObj = new juce::DynamicObject();
            trackObj->setProperty("id", snap.trackId);
            trackObj->setProperty("peakL", static_cast<double>(snap.peakL));
            trackObj->setProperty("peakR", static_cast<double>(snap.peakR));
            tracksVar.add(juce::var(trackObj));
        }
        trackLevelsObject->setProperty("tracks", tracksVar);
        bridge.broadcast("TRACK_LEVELS", trackLevelsPayload);
        lastTrackLevelsHadSignal = anyTrackHasSignal;
    }
}

} // namespace silverdaw
