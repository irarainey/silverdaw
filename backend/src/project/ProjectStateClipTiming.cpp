#include "ProjectState.h"

namespace silverdaw
{

ProjectState::EffectiveClipTiming ProjectState::getClipEffectiveTiming(const juce::String& clipId) const
{
    return resolveClipEffectiveTiming(findClip(clipId));
}

ProjectState::EffectiveClipTiming ProjectState::resolveClipEffectiveTiming(const juce::ValueTree& clip) const
{
    EffectiveClipTiming out;
    if (!clip.isValid())
        return out;

    out.durationMs = static_cast<double>(clip.getProperty(kDurationMs, 0.0));
    if (!static_cast<bool>(clip.getProperty(kWarpEnabled, false)))
    {
        return out;
    }

    double ratio = 1.0;
    if (clip.hasProperty(kTempoRatio))
    {
        ratio = static_cast<double>(clip.getProperty(kTempoRatio, 1.0));
    }
    else
    {
        const auto libraryItemId = clip.getProperty(kLibraryItemId, {}).toString();
        const double sourceBpm = getLibraryItemBpm(libraryItemId);
        const double projectBpm = getBpm();
        if (sourceBpm > 0.0 && projectBpm > 0.0)
        {
            ratio = projectBpm / sourceBpm;
        }
    }

    out.tempoRatio = ratio > 0.0 ? ratio : 1.0;
    // Duration-sensitive drift must match the renderer's isWarpActive (ADR 0024).
    out.warpActive = warpChangesTiming(out.durationMs, out.tempoRatio);
    if (out.warpActive)
    {
        out.durationMs = out.durationMs / out.tempoRatio;
    }
    return out;
}

} // namespace silverdaw
