#pragma once

#include "MixdownEngine.h" // for silverdaw::MixdownSnapshot

#include <juce_core/juce_core.h>

namespace silverdaw
{

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
