#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <cmath>

namespace silverdaw::dsp
{

// Block-size-independent exponential alpha for a first-order RC smoother.
inline float blockAlpha(int numSamples, double sr, double tauSeconds) noexcept
{
    const double a = std::exp(-static_cast<double>(numSamples)
                              / (tauSeconds * sr));
    return static_cast<float>(juce::jlimit(0.0, 1.0, a));
}

// Exponential first-order smoother; glides `cur` toward `target` by `alpha`,
// settling when within `epsilon`.
//   SnapCountsAsMove=true  (ToneEq):  epsilon snap sets target and returns true.
//   SnapCountsAsMove=false (SharedFx): epsilon snap sets target and returns false.
template <typename T, bool SnapCountsAsMove>
bool smoothToward(T& cur, T target, float alpha, T epsilon) noexcept
{
    if (std::abs(target - cur) < epsilon)
    {
        if constexpr (SnapCountsAsMove)
        {
            if (cur != target) { cur = target; return true; }
            return false;
        }
        else
        {
            cur = target;
            return false;
        }
    }
    cur = target + (cur - target) * static_cast<T>(alpha);
    return true;
}

} // namespace silverdaw::dsp
