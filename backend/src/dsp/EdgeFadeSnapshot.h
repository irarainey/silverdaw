#pragma once

#include <cmath>
#include <memory>

#include <juce_core/juce_core.h>

namespace silverdaw
{

// Immutable transition fades are published to the audio thread by pointer.
// Timeline-sample coordinates avoid warp conversion, and equal-power legs preserve blend energy.
class EdgeFadeSnapshot
{
  public:
    EdgeFadeSnapshot() = default;

    /** Drops degenerate legs so the audio thread always sees a valid snapshot. */
    static std::unique_ptr<EdgeFadeSnapshot> create(bool wantFadeIn,
                                                     juce::int64 fadeInStart,
                                                     juce::int64 fadeInEnd,
                                                     bool wantFadeOut,
                                                     juce::int64 fadeOutStart,
                                                     juce::int64 fadeOutEnd)
    {
        auto snap = std::make_unique<EdgeFadeSnapshot>();
        if (wantFadeIn && fadeInEnd > fadeInStart)
        {
            snap->hasFadeIn = true;
            snap->fadeInStart = fadeInStart;
            snap->fadeInEnd = fadeInEnd;
        }
        if (wantFadeOut && fadeOutEnd > fadeOutStart)
        {
            snap->hasFadeOut = true;
            snap->fadeOutStart = fadeOutStart;
            snap->fadeOutEnd = fadeOutEnd;
        }
        return snap;
    }

    bool isEmpty() const noexcept { return !hasFadeIn && !hasFadeOut; }

    /** RT-safe; multiplies head/tail legs so sandwiched clips compose naturally. */
    float gainAtSample(juce::int64 s) const noexcept
    {
        float g = 1.0F;
        if (hasFadeIn)
        {
            if (s <= fadeInStart)
                g = 0.0F;
            else if (s < fadeInEnd)
            {
                const double t = static_cast<double>(s - fadeInStart) /
                                 static_cast<double>(fadeInEnd - fadeInStart);
                g *= static_cast<float>(std::sin(t * kHalfPi));
            }
        }
        if (hasFadeOut)
        {
            if (s >= fadeOutEnd)
                g = 0.0F;
            else if (s >= fadeOutStart)
            {
                const double t = static_cast<double>(s - fadeOutStart) /
                                 static_cast<double>(fadeOutEnd - fadeOutStart);
                g *= static_cast<float>(std::cos(t * kHalfPi));
            }
        }
        return g;
    }

    bool getHasFadeIn() const noexcept { return hasFadeIn; }
    bool getHasFadeOut() const noexcept { return hasFadeOut; }
    juce::int64 getFadeInStart() const noexcept { return fadeInStart; }
    juce::int64 getFadeInEnd() const noexcept { return fadeInEnd; }
    juce::int64 getFadeOutStart() const noexcept { return fadeOutStart; }
    juce::int64 getFadeOutEnd() const noexcept { return fadeOutEnd; }

  private:
    static constexpr double kHalfPi = 1.57079632679489661923;

    bool hasFadeIn = false;
    bool hasFadeOut = false;
    juce::int64 fadeInStart = 0;
    juce::int64 fadeInEnd = 0;
    juce::int64 fadeOutStart = 0;
    juce::int64 fadeOutEnd = 0;
};

} // namespace silverdaw
