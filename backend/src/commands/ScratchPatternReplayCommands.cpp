#include "ScratchPatternReplayCommands.h"

#include "BridgeServer.h"
#include "Log.h"
#include "PayloadHelpers.h"
#include "ProjectSession.h"
#include "ProjectState.h"
#include "AudioEngine.h"
#include "scratch/ScratchPatternEvaluator.h"
#include "scratch/ScratchProtocol.h"

namespace silverdaw
{

using silverdaw::bridge::tryGetRequiredString;

void handleScratchPatternApply(const juce::var& payload, ProjectState& projectState,
                               AudioEngine& engine, BridgeServer& bridge,
                               const ProjectSession& session)
{
    if (!scratch::hasValidProtocolVersion(payload))
    {
        silverdaw::log::warn("scratch", "rejected SCRATCH_PATTERN_APPLY: bad protocolVersion");
        return;
    }

    const auto clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
    const auto patternId = tryGetRequiredString(payload, "patternId").value_or(juce::String{});

    if (clipId.isEmpty() || patternId.isEmpty())
    {
        silverdaw::log::warn("scratch", "rejected SCRATCH_PATTERN_APPLY: missing clipId or patternId");
        return;
    }

    // Validate the pattern exists.
    if (!projectState.hasScratchPattern(patternId))
    {
        silverdaw::log::warn("scratch", "SCRATCH_PATTERN_APPLY: pattern not found: " + patternId);
        return;
    }

    if (!projectState.setClipScratchPatternId(clipId, patternId))
    {
        silverdaw::log::warn("scratch", "SCRATCH_PATTERN_APPLY: clip not found: " + clipId);
        return;
    }

    // Rebuild clip pattern snapshot in the engine.
    engine.rebuildClipPatternSnapshot(clipId, projectState);

    silverdaw::log::info("scratch", "SCRATCH_PATTERN_APPLY ok clip=" + clipId + " pattern=" + patternId);
    bridge.broadcast("PROJECT_STATE", silverdaw::buildProjectStateEnvelope(session, projectState, false));
}

void handleScratchPatternRemove(const juce::var& payload, ProjectState& projectState,
                                AudioEngine& engine, BridgeServer& bridge,
                                const ProjectSession& session)
{
    if (!scratch::hasValidProtocolVersion(payload))
    {
        silverdaw::log::warn("scratch", "rejected SCRATCH_PATTERN_REMOVE: bad protocolVersion");
        return;
    }

    const auto clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
    if (clipId.isEmpty())
    {
        silverdaw::log::warn("scratch", "rejected SCRATCH_PATTERN_REMOVE: missing clipId");
        return;
    }

    if (!projectState.setClipScratchPatternId(clipId, {}))
    {
        silverdaw::log::warn("scratch", "SCRATCH_PATTERN_REMOVE: clip not found: " + clipId);
        return;
    }

    // Clear the pattern snapshot in the engine.
    engine.clearClipPatternSnapshot(clipId);

    silverdaw::log::info("scratch", "SCRATCH_PATTERN_REMOVE ok clip=" + clipId);
    bridge.broadcast("PROJECT_STATE", silverdaw::buildProjectStateEnvelope(session, projectState, false));
}

void handleScratchPatternReplayStart(const juce::var& payload, AudioEngine& engine,
                                     ProjectState& projectState, BridgeServer& bridge)
{
    if (!scratch::hasValidProtocolVersion(payload))
    {
        silverdaw::log::warn("scratch", "rejected SCRATCH_PATTERN_REPLAY_START: bad protocolVersion");
        return;
    }

    const auto patternId = tryGetRequiredString(payload, "patternId").value_or(juce::String{});
    if (patternId.isEmpty())
    {
        silverdaw::log::warn("scratch", "rejected SCRATCH_PATTERN_REPLAY_START: missing patternId");
        return;
    }

    // Retrieve the pattern from project state.
    const auto patternsJson = projectState.scratchPatternsAsJson();
    const auto* arr = patternsJson.getArray();
    if (arr == nullptr)
    {
        silverdaw::log::warn("scratch", "SCRATCH_PATTERN_REPLAY_START: no patterns in project");
        return;
    }

    std::optional<scratch::Pattern> foundPattern;
    for (const auto& item : *arr)
    {
        if (item.getProperty("id", {}).toString() == patternId)
        {
            foundPattern = scratch::parsePattern(item);
            break;
        }
    }

    if (!foundPattern)
    {
        silverdaw::log::warn("scratch", "SCRATCH_PATTERN_REPLAY_START: pattern not found: " + patternId);
        return;
    }

    // Start replay in the scratch audio source using the evaluator.
    if (!engine.startScratchPatternReplay(*foundPattern))
    {
        silverdaw::log::warn("scratch", "SCRATCH_PATTERN_REPLAY_START: engine rejected replay");
        return;
    }

    silverdaw::log::info("scratch", "SCRATCH_PATTERN_REPLAY_START ok pattern=" + patternId);
}

void handleScratchPatternReplayStop(const juce::var& payload, AudioEngine& engine,
                                    BridgeServer& bridge)
{
    if (!scratch::hasValidProtocolVersion(payload))
    {
        silverdaw::log::warn("scratch", "rejected SCRATCH_PATTERN_REPLAY_STOP: bad protocolVersion");
        return;
    }

    engine.stopScratchPatternReplay();
    silverdaw::log::info("scratch", "SCRATCH_PATTERN_REPLAY_STOP ok");
}

} // namespace silverdaw
