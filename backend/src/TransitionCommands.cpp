#include "TransitionCommands.h"

#include "Log.h"
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

    // The renderer never mints the id — the backend owns it so two clients
    // racing the same overlap can't collide on a caller-chosen string.
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

} // namespace silverdaw
