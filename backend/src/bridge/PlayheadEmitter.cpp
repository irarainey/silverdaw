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

    // Compensate only during playback so the playhead matches heard audio without moving seek anchors.
    const double latencyMs = playing ? engine.getOutputLatencyMs() : 0.0;
    const double posMs = playing ? juce::jmax(0.0, rawPosMs - latencyMs) : rawPosMs;

    // Reuse payload storage to avoid 60 Hz message-thread heap churn.
    if (playing || posMs != lastPosMs)
    {
        payloadObject->setProperty("positionMs", posMs);
        payloadObject->setProperty("isPlaying", playing);
        bridge.broadcast("PLAYHEAD_UPDATE", payload);
        lastPosMs = posMs;
    }

    // Preview transport is independent; stop here because the source only emits silence past duration.
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

    // Per-track meters use the same activity gate and one trailing zero as master.
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
