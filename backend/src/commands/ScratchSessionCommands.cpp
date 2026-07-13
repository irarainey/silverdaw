#include "ScratchSessionCommands.h"

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "Log.h"
#include "ProjectSession.h"
#include "ProjectState.h"
#include "scratch/ScratchProtocol.h"
#include "scratch/ScratchSourcePreparation.h"

#include <juce_events/juce_events.h>

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
                              const juce::String& projectPath)
{
    const auto request = scratch::parseSessionOpenPayload(payload);
    if (!request)
    {
        silverdaw::log::warn("scratch", "rejected malformed SCRATCH_SESSION_OPEN");
        return;
    }

    const auto sessionId = engine.beginScratchSession(request->clipId);
    const auto clip = projectState.getClipPreparationInfo(request->clipId);
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
    const auto cacheDirectory = projectArtifactsBaseDir(projectPath, "scratch-cache");
    broadcastScratchSessionState(engine, bridge);

    workerPool.addJob(
        [sessionId, settings, cacheDirectory, &engine, &bridge]
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
            juce::MessageManager::callAsync(
                [applied, &engine, &bridge]
                {
                    if (!applied)
                        silverdaw::log::debug(
                            "scratch", "ignored stale scratch preparation completion");
                    broadcastScratchSessionState(engine, bridge);
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
        silverdaw::log::debug("scratch", "ignored inapplicable SCRATCH_SESSION_CONTROL");
        return;
    }

    // On recordStop, deliver the completed pattern once via a dedicated message
    if (control->action == scratch::ControlAction::recordStop)
    {
        auto pattern = engine.takeScratchRecordingPattern();
        if (pattern)
        {
            auto* envelope = new juce::DynamicObject();
            envelope->setProperty("protocolVersion", scratch::kProtocolVersion);
            envelope->setProperty("sessionId", control->sessionId);
            envelope->setProperty("pattern", scratch::serializePattern(*pattern));
            bridge.broadcast("SCRATCH_PATTERN_RECORDED", juce::var(envelope));
        }
    }

    broadcastScratchSessionState(engine, bridge);
}

} // namespace silverdaw
