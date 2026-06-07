#include "PlayheadEmitter.h"

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "Log.h"

namespace silverdaw
{

PlayheadEmitter::PlayheadEmitter(AudioEngine& e, BridgeServer& b)
    : engine(e), bridge(b), payloadObject(new juce::DynamicObject()), payload(payloadObject.get())
{
}

void PlayheadEmitter::timerCallback()
{
    const bool playing = engine.isPlaying();
    const double rawPosMs = engine.getPositionMs();

    // While the transport is playing, subtract the device's
    // effective output latency from the broadcast position so the
    // visual playhead matches what the user is hearing — critical
    // for high-latency outputs like Bluetooth headphones, where
    // the uncompensated value drifts ~200 ms ahead of the audio.
    //
    // Paused / seek-anchor reads stay raw (see
    // `AudioEngine::getPositionMs` for the rationale): click-to-
    // seek lands exactly where the user clicked, and Save's
    // persisted playhead matches the engine's write position.
    // The play/pause transition does cause a one-off visual snap
    // (~latency ms), absorbed by the renderer's existing position
    // smoothing.
    const double latencyMs = playing ? engine.getOutputLatencyMs() : 0.0;
    const double posMs = playing ? juce::jmax(0.0, rawPosMs - latencyMs) : rawPosMs;

    // Always broadcast on transitions; while playing, broadcast every tick so the
    // renderer can drive a smooth playhead. Reuse a single DynamicObject so we
    // don't churn the heap 60x/s on the message thread.
    if (playing || posMs != lastPosMs)
    {
        payloadObject->setProperty("positionMs", posMs);
        payloadObject->setProperty("isPlaying", playing);
        bridge.broadcast("PLAYHEAD_UPDATE", payload);
        lastPosMs = posMs;
    }

    // Preview voice — independent of the project transport. Broadcast
    // position while playing, and detect end-of-window here (the
    // OffsetSource emits silence past durationMs but the transport
    // keeps "playing"; we explicitly stop and notify).
    const bool previewPlaying = engine.isPreviewPlaying();
    const double previewPos = engine.getPreviewPositionMs();
    const double previewDur = engine.getPreviewDurationMs();
    if (previewPlaying && previewDur > 0.0 && previewPos >= previewDur)
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

    // Master peak meter. Drain the audio thread's "max since last
    // read" lanes and broadcast a MASTER_LEVEL envelope. We gate
    // on activity (signal above ~ -100 dBFS, plus one trailing
    // zero so the renderer's hold/decay can finish gracefully)
    // to avoid spamming envelopes during long silent stretches.
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

    // Diagnostic: record the final post-master-gain output peak — the
    // signal actually handed to the device. Fires both while PLAYING (was
    // the first play silent at the engine, or did real audio reach the
    // device?). A peak at the keep-alive floor (~0.004) is dither only; a
    // music-level peak (≳ 0.1) is real audio; a flat 0 while playing means
    // the output never reached the device. We accumulate the running max
    // across every drained tick so a throttled sample can't miss a
    // transient, then emit it on the message thread (free of any
    // audio-thread cost) and reset. Only accumulate while playing so the
    // brief wake-pre-roll floor can't contaminate the first post-resume
    // sample.
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
    // Only log during active playback — idle/paused output is now true
    // silence, so logging it would just spam zeros every interval.
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

    // Per-track peak meters. Same gating rules as the master
    // meter (only broadcast on activity; emit one trailing zero
    // on the active→silent transition so the renderer's
    // hold/decay finishes cleanly). The payload carries a flat
    // array — small at typical project sizes (≤ few dozen
    // tracks) and the renderer fans out by `id` to the
    // matching track-meter component.
    engine.drainAllTrackPeaks(trackPeakScratch);
    bool anyTrackHasSignal = false;
    for (const auto& snap : trackPeakScratch)
    {
        if (snap.peakL > kMeterEpsilon || snap.peakR > kMeterEpsilon)
        {
            anyTrackHasSignal = true;
            break;
        }
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
