#pragma once

#include "MixdownEngine.h" // for silverdaw::MixdownSnapshot

#include <juce_core/juce_core.h>

namespace silverdaw
{

// Timeline end position (ms) of a clip after warp. Shared by the snapshot
// (`computeLastClipEndMs`) and the offline graph builder (`buildOfflineClip`),
// so it lives in a header rather than either translation unit.
inline double clipTimelineEndMs(const MixdownSnapshot::ClipSnapshot& clip) noexcept
{
    const double eff = clip.warpEnabled
                           ? (clip.effectiveDurationMs > 0.0
                                  ? clip.effectiveDurationMs
                                  : clip.durationMs / juce::jmax(0.0001, clip.tempoRatio))
                           : clip.durationMs;
    return clip.offsetMs + eff;
}

} // namespace silverdaw
