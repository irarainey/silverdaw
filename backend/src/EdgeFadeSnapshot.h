#pragma once

#include <cmath>
#include <memory>

#include <juce_core/juce_core.h>

namespace silverdaw
{

/**
 * Immutable, audio-thread-readable per-clip transition edge-fade.
 *
 * A clip-to-clip transition (§12.1) is realised as a pair of complementary
 * edge fades over the clips' sanctioned overlap region: the earlier clip
 * fades OUT across its trailing overlap, the later clip fades IN across its
 * leading overlap. A clip sandwiched between two transitions carries BOTH a
 * head fade-in and a tail fade-out.
 *
 * Coordinates are **master-timeline samples**, not clip-local time. The audio
 * thread already knows the timeline position of every sample it renders, so
 * the fade needs no warp/tempo conversion — it is purely a function of where
 * the sample sits inside the overlap region. The gain produced here MULTIPLIES
 * the user's per-clip volume `EnvelopeSnapshot`; the two are independent layers
 * so a transition never clobbers a user-drawn volume shape.
 *
 * The "smooth" recipe is an **equal-power** crossfade: the out leg uses
 * `cos(t·π/2)` and the in leg `sin(t·π/2)`, so `out² + in² == 1` and constant
 * acoustic power is preserved across the blend. Because the endpoints are
 * computed with exact trig (not dB-linear interpolation), the fade reaches
 * true unity and true silence without the `-100 dB` floor artefact that a
 * breakpoint approximation would introduce.
 *
 * Lifetime / threading mirrors `EnvelopeSnapshot`: built off the audio thread,
 * published as a `const EdgeFadeSnapshot*` (release/acquire), never mutated
 * after construction. The owning `Track` keeps the live instance alive and
 * retires replaced instances into a deferred free-list drained when the
 * transport is quiescent.
 */
class EdgeFadeSnapshot
{
  public:
    EdgeFadeSnapshot() = default;

    /** Build a fade descriptor from timeline-sample bounds. A leg is active
     *  only when its span is strictly positive; degenerate or absent legs are
     *  silently dropped so a snapshot is always valid (and `isEmpty()` when
     *  neither leg survives). */
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

    /** Equal-power crossfade gain at master-timeline sample `s`. RT-safe: no
     *  allocation, no locking, no heap access. Returns the product
     *  of the head fade-in and tail fade-out legs (each is unity outside its
     *  own region), so a sandwiched clip composes naturally. */
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
