#include "AudioEngine.h"
#include "ProjectState.h"

// Transitions live here to keep ProjectState/Main focused; overlap is derived to avoid drift.

namespace silverdaw
{

const juce::Identifier ProjectState::kTransition{"TRANSITION"};
const juce::Identifier ProjectState::kLeftClipId{"leftClipId"};
const juce::Identifier ProjectState::kRightClipId{"rightClipId"};
const juce::Identifier ProjectState::kRecipe{"recipe"};
const juce::Identifier ProjectState::kRecipeKind{"kind"};

namespace
{
// Unknown recipes normalise to a renderable smooth crossfade.
const juce::String kSmoothRecipeKind{"smooth"};

juce::String normaliseRecipeKind(const juce::var& recipe)
{
    if (recipe.isObject())
    {
        const auto kind = recipe.getProperty("kind", {}).toString();
        if (kind == kSmoothRecipeKind) return kSmoothRecipeKind;
    }
    return kSmoothRecipeKind;
}
} // namespace

bool ProjectState::clipTimelineSpanMs(const juce::String& clipId, double& startMs, double& endMs) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid()) return false;
    const auto timing = getClipEffectiveTiming(clipId);
    if (timing.durationMs <= 0.0) return false;
    startMs = static_cast<double>(clip.getProperty(kOffsetMs, 0.0));
    endMs = startMs + timing.durationMs;
    return true;
}

bool ProjectState::transitionOverlapMs(const juce::ValueTree& track,
                                       const juce::String& leftClipId, const juce::String& rightClipId,
                                       double& overlapStartMs, double& overlapEndMs) const
{
    if (!track.isValid() || leftClipId.isEmpty() || rightClipId.isEmpty()) return false;
    if (leftClipId == rightClipId) return false;

    const auto left = findClip(leftClipId);
    const auto right = findClip(rightClipId);
    if (!left.isValid() || !right.isValid()) return false;
    if (left.getParent() != track || right.getParent() != track) return false;

    double leftStart = 0.0, leftEnd = 0.0, rightStart = 0.0, rightEnd = 0.0;
    if (!clipTimelineSpanMs(leftClipId, leftStart, leftEnd)) return false;
    if (!clipTimelineSpanMs(rightClipId, rightStart, rightEnd)) return false;

    // Require tail/head overlap so fades stay on clip edges, not mid-clip.
    constexpr double kEps = 1.0e-6;
    if (!(leftStart + kEps < rightStart && rightStart + kEps < leftEnd && leftEnd <= rightEnd + kEps))
        return false;

    const double oStart = rightStart;
    const double oEnd = leftEnd; // == min(leftEnd, rightEnd) given leftEnd <= rightEnd
    if (oEnd - oStart <= kEps) return false;

    // Third-clip intrusion would make the derived overlap ambiguous.
    for (int i = 0; i < track.getNumChildren(); ++i)
    {
        const auto other = track.getChild(i);
        if (!other.hasType(kClip)) continue;
        const auto otherId = other.getProperty(kId).toString();
        if (otherId == leftClipId || otherId == rightClipId) continue;
        double os = 0.0, oe = 0.0;
        if (!clipTimelineSpanMs(otherId, os, oe)) continue;
        if (os + kEps < oEnd && oe - kEps > oStart) return false; // intersects overlap
    }

    overlapStartMs = oStart;
    overlapEndMs = oEnd;
    return true;
}

bool ProjectState::addTransition(const juce::String& trackId, const juce::String& transitionId,
                                 const juce::String& leftClipId, const juce::String& rightClipId,
                                 const juce::var& recipe)
{
    if (transitionId.isEmpty()) return false;
    auto track = findTrack(trackId);
    if (!track.isValid()) return false;

    // Each clip edge can have only one transition neighbour.
    for (int i = 0; i < track.getNumChildren(); ++i)
    {
        const auto t = track.getChild(i);
        if (!t.hasType(kTransition)) continue;
        if (t.getProperty(kId).toString() == transitionId) return false;
        if (t.getProperty(kLeftClipId).toString() == leftClipId) return false;
        if (t.getProperty(kRightClipId).toString() == rightClipId) return false;
    }

    double oStart = 0.0, oEnd = 0.0;
    if (!transitionOverlapMs(track, leftClipId, rightClipId, oStart, oEnd)) return false;

    juce::ValueTree node(kTransition);
    node.setProperty(kId, transitionId, &undoManager);
    node.setProperty(kLeftClipId, leftClipId, &undoManager);
    node.setProperty(kRightClipId, rightClipId, &undoManager);
    node.setProperty(kRecipeKind, normaliseRecipeKind(recipe), &undoManager);
    track.appendChild(node, &undoManager);
    return true;
}

bool ProjectState::removeTransition(const juce::String& trackId, const juce::String& transitionId)
{
    auto track = findTrack(trackId);
    if (!track.isValid()) return false;
    for (int i = 0; i < track.getNumChildren(); ++i)
    {
        auto t = track.getChild(i);
        if (t.hasType(kTransition) && t.getProperty(kId).toString() == transitionId)
        {
            track.removeChild(t, &undoManager);
            return true;
        }
    }
    return false;
}

bool ProjectState::setTransitionRecipe(const juce::String& trackId, const juce::String& transitionId,
                                       const juce::var& recipe)
{
    auto track = findTrack(trackId);
    if (!track.isValid()) return false;
    for (int i = 0; i < track.getNumChildren(); ++i)
    {
        auto t = track.getChild(i);
        if (t.hasType(kTransition) && t.getProperty(kId).toString() == transitionId)
        {
            const auto kind = normaliseRecipeKind(recipe);
            if (t.getProperty(kRecipeKind).toString() == kind) return false;
            t.setProperty(kRecipeKind, kind, &undoManager);
            return true;
        }
    }
    return false;
}

ProjectState::ClipEdgeFade ProjectState::getClipEdgeFade(const juce::String& clipId) const
{
    ClipEdgeFade fade;
    const auto clip = findClip(clipId);
    if (!clip.isValid()) return fade;
    const auto track = clip.getParent();
    if (!track.isValid()) return fade;

    for (int i = 0; i < track.getNumChildren(); ++i)
    {
        const auto t = track.getChild(i);
        if (!t.hasType(kTransition)) continue;
        const auto leftId = t.getProperty(kLeftClipId).toString();
        const auto rightId = t.getProperty(kRightClipId).toString();
        if (leftId != clipId && rightId != clipId) continue;

        double oStart = 0.0, oEnd = 0.0;
        if (!transitionOverlapMs(track, leftId, rightId, oStart, oEnd)) continue;

        if (rightId == clipId)
        {
            fade.hasFadeIn = true;
            fade.fadeInStartMs = oStart;
            fade.fadeInEndMs = oEnd;
        }
        if (leftId == clipId)
        {
            fade.hasFadeOut = true;
            fade.fadeOutStartMs = oStart;
            fade.fadeOutEndMs = oEnd;
        }
    }
    return fade;
}

bool ProjectState::reconcileTransitions(bool useUndo)
{
    juce::UndoManager* um = useUndo ? &undoManager : nullptr;
    bool removedAny = false;

    for (int t = 0; t < root.getNumChildren(); ++t)
    {
        auto track = root.getChild(t);
        if (!track.hasType(kTrack)) continue;

        // Iterate backwards so removals don't shift pending indices.
        for (int i = track.getNumChildren() - 1; i >= 0; --i)
        {
            auto node = track.getChild(i);
            if (!node.hasType(kTransition)) continue;
            const auto leftId = node.getProperty(kLeftClipId).toString();
            const auto rightId = node.getProperty(kRightClipId).toString();
            double oStart = 0.0, oEnd = 0.0;
            if (!transitionOverlapMs(track, leftId, rightId, oStart, oEnd))
            {
                track.removeChild(node, um);
                removedAny = true;
            }
        }
    }
    return removedAny;
}

bool ProjectState::hasAnyTransition() const
{
    for (int t = 0; t < root.getNumChildren(); ++t)
    {
        const auto track = root.getChild(t);
        if (!track.hasType(kTrack)) continue;
        for (int i = 0; i < track.getNumChildren(); ++i)
        {
            if (track.getChild(i).hasType(kTransition)) return true;
        }
    }
    return false;
}

juce::var ProjectState::buildTransitionsJson(const juce::ValueTree& track) const
{
    juce::Array<juce::var> arr;
    for (int i = 0; i < track.getNumChildren(); ++i)
    {
        const auto t = track.getChild(i);
        if (!t.hasType(kTransition)) continue;

        auto* recipeObj = new juce::DynamicObject();
        const auto kind = t.getProperty(kRecipeKind, kSmoothRecipeKind).toString();
        recipeObj->setProperty("kind", kind.isEmpty() ? kSmoothRecipeKind : kind);

        auto* obj = new juce::DynamicObject();
        obj->setProperty("id", t.getProperty(kId).toString());
        obj->setProperty("leftClipId", t.getProperty(kLeftClipId).toString());
        obj->setProperty("rightClipId", t.getProperty(kRightClipId).toString());
        obj->setProperty("recipe", juce::var(recipeObj));
        arr.add(juce::var(obj));
    }
    return juce::var(arr);
}

juce::StringArray ProjectState::getAllClipIds() const
{
    juce::StringArray ids;
    for (int t = 0; t < root.getNumChildren(); ++t)
    {
        const auto track = root.getChild(t);
        if (!track.hasType(kTrack)) continue;
        for (int c = 0; c < track.getNumChildren(); ++c)
        {
            const auto clip = track.getChild(c);
            if (clip.hasType(kClip)) ids.add(clip.getProperty(kId).toString());
        }
    }
    return ids;
}

void syncClipEdgeFades(AudioEngine& engine, const ProjectState& project)
{
    for (const auto& clipId : project.getAllClipIds())
    {
        const auto fade = project.getClipEdgeFade(clipId);
        engine.setClipEdgeFade(clipId,
                               fade.hasFadeIn, fade.fadeInStartMs, fade.fadeInEndMs,
                               fade.hasFadeOut, fade.fadeOutStartMs, fade.fadeOutEndMs);
    }
}

} // namespace silverdaw
