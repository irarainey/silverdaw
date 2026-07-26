#include "ScratchSessionCommands.h"

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "Log.h"
#include "PeaksCache.h"
#include "ProjectSession.h"
#include "ProjectState.h"
#include "Waveform.h"
#include "scratch/ScratchProtocol.h"
#include "scratch/ScratchSourcePreparation.h"
#include "scratch/ScratchBackingPreparation.h"
#include "mixdown/MixdownEngine.h"

#include <juce_events/juce_events.h>

#include <algorithm>

namespace silverdaw
{
namespace
{
void broadcastScratchPatternIfReady(AudioEngine& engine, BridgeServer& bridge,
                                    const juce::String& sessionId)
{
    auto pattern = engine.takeScratchRecordingPattern();
    if (!pattern)
        return;

    auto* envelope = new juce::DynamicObject();
    envelope->setProperty("protocolVersion", scratch::kProtocolVersion);
    envelope->setProperty("sessionId", sessionId);
    envelope->setProperty("pattern", scratch::serializePattern(*pattern));
    bridge.broadcast("SCRATCH_PATTERN_RECORDED", juce::var(envelope));
}

double effectivePeaksPerSecond(const waveform::PeaksResult& result)
{
    if (result.sampleRate <= 0.0 || result.peaksPerSecond <= 0)
        return static_cast<double>(result.peaksPerSecond);
    const int samplesPerPeak =
        juce::jmax(1, static_cast<int>(result.sampleRate / result.peaksPerSecond));
    return result.sampleRate / static_cast<double>(samplesPerPeak);
}

void broadcastScratchSourcePeaksReady(const juce::String& sessionId,
                                      const juce::File& cacheFile,
                                      const waveform::PeaksResult& peaks,
                                      BridgeServer& bridge)
{
    auto* payload = new juce::DynamicObject();
    payload->setProperty("sessionId", sessionId);
    payload->setProperty("cachePath", cacheFile.getFullPathName());
    payload->setProperty("peakCount", peaks.bucketsPerLane());
    payload->setProperty("peaksPerSecond", effectivePeaksPerSecond(peaks));
    payload->setProperty("sampleRate", peaks.sampleRate);
    bridge.broadcast("SCRATCH_SOURCE_PEAKS_READY", juce::var(payload));
}
} // namespace

void broadcastScratchSessionState(AudioEngine& engine, BridgeServer& bridge)
{
    engine.reconcileScratchSessionSourceEnd();
    const auto state = engine.getScratchSessionSnapshot();
    if (!state)
    {
        return;
    }
    broadcastScratchPatternIfReady(engine, bridge, state->sessionId);
    auto* object = new juce::DynamicObject();
    object->setProperty("protocolVersion", scratch::kProtocolVersion);
    object->setProperty("sessionId", state->sessionId);
    object->setProperty("clipId", state->clipId);
    object->setProperty("status", state->status);
    object->setProperty("preparationProgress", state->preparationProgress);
    object->setProperty("positionUs", static_cast<juce::int64>(state->positionUs));
    object->setProperty("durationUs", static_cast<juce::int64>(state->durationUs));
    object->setProperty("platterTurns", state->platterTurns);
    object->setProperty("playbackRate", state->playbackRate);
    object->setProperty("crossfader", state->crossfader);
    object->setProperty("crossfaderReversed", state->crossfaderReversed);
    object->setProperty(
        "ownerDeviceIdentifier",
        state->ownerDeviceIdentifier
            ? juce::var(*state->ownerDeviceIdentifier)
            : juce::var());
    object->setProperty(
        "selectedDeck",
        state->selectedDeck
            ? juce::var(static_cast<int>(*state->selectedDeck))
            : juce::var());
    object->setProperty(
        "ownerDeck",
        state->ownerDeck
            ? juce::var(static_cast<int>(*state->ownerDeck))
            : juce::var());
    object->setProperty("touched", state->touched);
    object->setProperty("armed", state->armed);
    object->setProperty("backingStatus", state->backingStatus);
    object->setProperty("backingDurationUs",
                        static_cast<juce::int64>(state->backingDurationUs));
    object->setProperty("backingPositionUs",
                        static_cast<juce::int64>(state->backingPositionUs));
    object->setProperty("backingLoop", state->backingLoop);
    object->setProperty("backingGain", state->backingGain);
    object->setProperty("scratchMonitorGain", state->scratchMonitorGain);
    object->setProperty("replaying", state->replaying);
    object->setProperty("replayPositionNormalized", state->replayPositionNormalized);
    if (state->backingError.isNotEmpty())
    {
        object->setProperty("backingError", state->backingError);
    }
    if (state->error.isNotEmpty())
    {
        object->setProperty("error", state->error);
    }
    bridge.broadcast("SCRATCH_SESSION_STATE", juce::var(object));
}

void handleScratchSessionOpen(const juce::var& payload,
                              AudioEngine& engine,
                              ProjectState& projectState,
                              BridgeServer& bridge,
                              juce::ThreadPool& workerPool,
                              const PeaksCache& cache,
                              const juce::String& projectPath)
{
    const auto request = scratch::parseSessionOpenPayload(payload);
    if (!request)
    {
        silverdaw::log::warn("scratch", "rejected malformed SCRATCH_SESSION_OPEN");
        return;
    }

    const auto fromLibrary = request->libraryItemId.isNotEmpty();
    const auto identity = fromLibrary ? request->libraryItemId : request->clipId;
    const auto sessionId = engine.beginScratchSession(identity);
    const auto clip = fromLibrary
        ? projectState.getLibraryItemPreparationInfo(request->libraryItemId)
        : projectState.getClipPreparationInfo(request->clipId);
    if (!clip)
    {
        engine.failScratchSession(sessionId, "The selected clip is unavailable");
        broadcastScratchSessionState(engine, bridge);
        return;
    }
    scratch::SourcePreparationSettings settings;
    settings.sourceFile = juce::File(clip->sourcePath);
    settings.inMs = clip->inMs;
    settings.durationMs = clip->durationMs;
    settings.reversed = clip->reversed;
    settings.warpEnabled = clip->warpEnabled;
    settings.warpMode = clip->warpMode;
    settings.tempoRatio = clip->tempoRatio;
    settings.semitones = clip->semitones;
    settings.cents = clip->cents;
    // Re-opening a saved scratch: prepare from its self-contained source snapshot
    // (the exact window the scratch was performed over) rather than the baked WAV,
    // which would otherwise be scratched a second time. The snapshot is already the
    // post-warp/reverse prepared audio, so it is fed back verbatim (identity window).
    bool usesScratchSourceSnapshot = false;
    if (fromLibrary)
    {
        const auto scratchSource =
            projectState.getLibraryItemScratchSourcePath(request->libraryItemId);
        if (scratchSource.isNotEmpty() && juce::File(scratchSource).existsAsFile())
        {
            settings.sourceFile = juce::File(scratchSource);
            settings.inMs = 0.0;
            settings.durationMs = 0.0;
            settings.reversed = false;
            settings.warpEnabled = false;
            settings.tempoRatio = 1.0;
            settings.semitones = 0.0;
            settings.cents = 0.0;
            usesScratchSourceSnapshot = true;
        }
    }
    const auto cacheDirectory = projectArtifactsBaseDir(projectPath, "scratch-cache");
    broadcastScratchSessionState(engine, bridge);

    workerPool.addJob(
        [sessionId, settings, cacheDirectory, usesScratchSourceSnapshot, &engine, &bridge, &cache]
        {
            scratch::PreparedSource prepared;
            juce::String error;
            double lastPublishedProgress = -1.0;
            const bool ok = scratch::prepareSourceToCache(
                settings, cacheDirectory, engine, prepared, error,
                [&engine, &sessionId]
                {
                    const auto current = engine.getScratchSessionSnapshot();
                    return !current || current->sessionId != sessionId;
                },
                [&engine, &bridge, &sessionId, &lastPublishedProgress](double progress)
                {
                    if (!engine.setScratchPreparationProgress(sessionId, progress))
                        return;
                    if (progress < 1.0
                        && progress - lastPublishedProgress < 0.05)
                        return;
                    lastPublishedProgress = progress;
                    juce::MessageManager::callAsync(
                        [&engine, &bridge]
                        {
                            broadcastScratchSessionState(engine, bridge);
                        });
                });
            const bool applied =
                ok
                    ? engine.completeScratchSession(
                        sessionId, prepared.audio, prepared.sampleRate)
                    : engine.failScratchSession(sessionId, error);
            waveform::PeaksResult peaks;
            if (applied && usesScratchSourceSnapshot)
            {
                peaks = cache.tryLoad(prepared.cacheFile, waveform::kDefaultPeaksPerSecond);
                if (peaks.peaks.empty())
                {
                    peaks = waveform::computePeaks(
                        prepared.cacheFile, engine.getFormatManager(), waveform::kDefaultPeaksPerSecond);
                    if (!peaks.peaks.empty())
                        cache.store(prepared.cacheFile, peaks);
                }
            }
            juce::MessageManager::callAsync(
                [applied, sessionId, peaks = std::move(peaks), preparedCache = prepared.cacheFile,
                 &engine, &bridge, &cache]
                {
                    if (!applied)
                    {
                        silverdaw::log::debug(
                            "scratch", "ignored stale scratch preparation completion");
                        return;
                    }
                    broadcastScratchSessionState(engine, bridge);
                    const auto current = engine.getScratchSessionSnapshot();
                    if (peaks.peaks.empty() || !current || current->sessionId != sessionId)
                        return;
                    broadcastScratchSourcePeaksReady(
                        sessionId,
                        cache.getCacheFilePath(preparedCache, waveform::kDefaultPeaksPerSecond),
                        peaks,
                        bridge);
                });
        });
}

void handleScratchSessionClose(const juce::var& payload,
                               AudioEngine& engine,
                               BridgeServer& bridge)
{
    juce::ignoreUnused(bridge);
    const auto request = scratch::parseSessionClosePayload(payload);
    if (!request || !engine.closeScratchSession(request->sessionId))
    {
        silverdaw::log::warn("scratch", "rejected stale or malformed SCRATCH_SESSION_CLOSE");
    }
}

void handleScratchSessionControl(const juce::var& payload,
                                 AudioEngine& engine,
                                 BridgeServer& bridge)
{
    const auto control = scratch::parseSessionControlPayload(payload);
    if (!control)
    {
        silverdaw::log::warn("scratch", "rejected malformed SCRATCH_SESSION_CONTROL");
        return;
    }
    if (!engine.controlScratchSession(*control))
    {
        // A recordStop can race the controller's own end-of-window
        // reconciliation: the take auto-finalizes first, so the control is
        // reported as inapplicable (status is no longer "recording") even
        // though it arrived for the still-active session. Still publish
        // immediately via the authoritative broadcastScratchSessionState path
        // rather than silently waiting for the next timer-driven broadcast.
        // Guard on the session id so a stale/wrong-session control can never
        // drain another session's completed pattern.
        const auto snapshot = engine.getScratchSessionSnapshot();
        const bool racedRecordStop =
            control->action == scratch::ControlAction::recordStop
            && snapshot && snapshot->sessionId == control->sessionId;
        if (!racedRecordStop)
        {
            silverdaw::log::debug("scratch", "ignored inapplicable SCRATCH_SESSION_CONTROL");
            return;
        }
    }

    broadcastScratchSessionState(engine, bridge);
}

void handleScratchBackingPrepare(const juce::var& payload,
                                 AudioEngine& engine,
                                 ProjectState& projectState,
                                 BridgeServer& bridge,
                                 juce::ThreadPool& workerPool)
{
    const auto request = scratch::parseBackingPreparePayload(payload);
    if (!request)
    {
        silverdaw::log::warn("scratch", "rejected malformed SCRATCH_BACKING_PREPARE");
        return;
    }

    if (!engine.beginScratchBackingPreparation(request->sessionId))
    {
        silverdaw::log::debug("scratch", "ignored inapplicable SCRATCH_BACKING_PREPARE");
        return;
    }

    // Snapshot and track-filter on the message thread; the offline render then
    // runs on a worker. Filter to the requested tracks (empty = none selected).
    auto snapshot = snapshotProjectForMixdown(projectState);
    std::vector<MixdownSnapshot::TrackSnapshot> kept;
    for (auto& track : snapshot.tracks)
    {
        const bool selected =
            std::find(request->trackIds.begin(), request->trackIds.end(), track.id)
            != request->trackIds.end();
        if (selected)
            kept.push_back(track);
    }
    snapshot.tracks = std::move(kept);

    const double anchorMs =
        request->startAnchor == "playhead" ? engine.getPositionMs() : 0.0;
    // durationSec == 0 is the full-arrangement sentinel: span from the anchor to
    // the last clip end of the selected tracks. Fixed windows use their seconds.
    const double durationMs =
        request->durationSec <= 0
            ? juce::jmax(0.0, silverdaw::computeLastClipEndMs(snapshot) - anchorMs)
            : static_cast<double>(request->durationSec) * 1000.0;
    const auto sessionId = request->sessionId;

    broadcastScratchSessionState(engine, bridge);

    workerPool.addJob(
        [sessionId, snapshot = std::move(snapshot), anchorMs, durationMs,
         &engine, &bridge]() mutable
        {
            scratch::PreparedBacking prepared;
            juce::String error;
            const bool ok = scratch::prepareBackingToBuffer(
                snapshot, anchorMs, durationMs, prepared, error,
                [&engine, &sessionId]
                {
                    const auto current = engine.getScratchSessionSnapshot();
                    return !current || current->sessionId != sessionId;
                });
            const bool applied =
                ok
                    ? engine.completeScratchBacking(
                        sessionId, prepared.audio, prepared.sampleRate)
                    : engine.failScratchBacking(sessionId, error);
            juce::MessageManager::callAsync(
                [applied, &engine, &bridge]
                {
                    if (!applied)
                        silverdaw::log::debug(
                            "scratch", "ignored stale scratch backing completion");
                    broadcastScratchSessionState(engine, bridge);
                });
        });
}

void handleScratchBackingClear(const juce::var& payload,
                               AudioEngine& engine,
                               BridgeServer& bridge)
{
    const auto request = scratch::parseBackingClearPayload(payload);
    if (!request || !engine.clearScratchBacking(request->sessionId))
    {
        silverdaw::log::debug("scratch", "ignored stale or malformed SCRATCH_BACKING_CLEAR");
        return;
    }
    broadcastScratchSessionState(engine, bridge);
}

} // namespace silverdaw
