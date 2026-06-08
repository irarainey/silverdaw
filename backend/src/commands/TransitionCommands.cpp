#include "TransitionCommands.h"

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "Log.h"
#include "ProjectSession.h"
#include "ProjectState.h"

namespace silverdaw
{

namespace
{
juce::String requiredString(const juce::var& payload, const char* key)
{
    return payload.getProperty(key, juce::var()).toString();
}
} // namespace

bool applyTransitionCreate(const juce::var& payload, ProjectState& projectState)
{
    const auto trackId = requiredString(payload, "trackId");
    const auto leftClipId = requiredString(payload, "leftClipId");
    const auto rightClipId = requiredString(payload, "rightClipId");
    if (trackId.isEmpty() || leftClipId.isEmpty() || rightClipId.isEmpty())
    {
        log::warn("transition", "TRANSITION_CREATE rejected: missing trackId/leftClipId/rightClipId");
        return false;
    }

    // Backend-minted ids avoid caller-chosen collisions.
    const auto transitionId = juce::Uuid().toDashedString();
    const auto recipe = payload.getProperty("recipe", juce::var());

    const bool ok = projectState.addTransition(trackId, transitionId, leftClipId, rightClipId, recipe);
    log::info("transition", "TRANSITION_CREATE track=" + trackId + " left=" + leftClipId +
                                " right=" + rightClipId + " -> " + (ok ? "added id=" + transitionId : "rejected"));
    return ok;
}

bool applyTransitionDelete(const juce::var& payload, ProjectState& projectState)
{
    const auto trackId = requiredString(payload, "trackId");
    const auto transitionId = requiredString(payload, "transitionId");
    if (trackId.isEmpty() || transitionId.isEmpty())
    {
        log::warn("transition", "TRANSITION_DELETE rejected: missing trackId/transitionId");
        return false;
    }
    const bool ok = projectState.removeTransition(trackId, transitionId);
    log::info("transition", "TRANSITION_DELETE track=" + trackId + " id=" + transitionId +
                                " -> " + (ok ? "removed" : "not found"));
    return ok;
}

bool applyTransitionSetRecipe(const juce::var& payload, ProjectState& projectState)
{
    const auto trackId = requiredString(payload, "trackId");
    const auto transitionId = requiredString(payload, "transitionId");
    if (trackId.isEmpty() || transitionId.isEmpty())
    {
        log::warn("transition", "TRANSITION_SET_RECIPE rejected: missing trackId/transitionId");
        return false;
    }
    const auto recipe = payload.getProperty("recipe", juce::var());
    const bool ok = projectState.setTransitionRecipe(trackId, transitionId, recipe);
    log::info("transition", "TRANSITION_SET_RECIPE track=" + trackId + " id=" + transitionId +
                                " -> " + (ok ? "changed" : "unchanged"));
    return ok;
}

void finishTransitionEdit(silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                          silverdaw::BridgeServer& bridge, silverdaw::ProjectSession& session)
{
    projectState.reconcileTransitions(/*useUndo*/ true);
    silverdaw::syncClipEdgeFades(engine, projectState);
    bridge.broadcast("PROJECT_STATE", silverdaw::buildProjectStateEnvelope(session, projectState, false));
}

bool transitionGeometryMayHaveChanged(const juce::String& type) noexcept
{
    return type == "CLIP_MOVE" || type == "CLIP_TRIM" || type == "CLIP_REMOVE" ||
           type == "CLIP_SET_WARP" || type == "TRACK_REMOVE" || type == "PROJECT_SET_BPM" ||
           type == "CLIP_RELINK";
}

void reconcileTransitionsAfterGeometryEdit(silverdaw::AudioEngine& engine,
                                           silverdaw::ProjectState& projectState,
                                           silverdaw::BridgeServer& bridge, silverdaw::ProjectSession& session)
{
    if (!projectState.hasAnyTransition()) return;
    const bool removed = projectState.reconcileTransitions(/*useUndo*/ true);
    silverdaw::syncClipEdgeFades(engine, projectState);
    if (removed)
    {
        bridge.broadcast("PROJECT_STATE", silverdaw::buildProjectStateEnvelope(session, projectState, false));
    }
}

} // namespace silverdaw
