#pragma once

#include <algorithm>
#include <cmath>
#include <memory>

#include <juce_core/juce_core.h>

namespace silverdaw
{

// Immutable per-clip "turntable brake" parameters, published to the audio thread
// by pointer (mirroring EnvelopeSnapshot / EdgeFadeSnapshot). The brake decelerates
// playback over the last `brakeLenSamples` of the clip's timeline footprint — a
// VARISPEED ramp where the source-read rate goes 1 -> 0, coupling pitch and tempo
// so the audio pitches down and grinds to a stop (a vinyl record-stop).
//
// The deceleration models a direct-drive deck (e.g. Technics SL-1210): hitting the
// stop button applies a roughly CONSTANT brake torque to the platter flywheel, so
// angular velocity (and thus the playback rate) decays LINEARLY to zero over a
// FIXED wall-clock platter-stop time (~1 s, independent of the track tempo). Because
// the stop time is fixed in seconds, a faster track spans MORE beats while braking,
// not fewer — the opposite of a beats-quantised model. Perceptually the linear rate
// ramp gives the recognisable accelerating downward pitch glide (pitch is log of
// rate, so it plummets as the platter halts).
//
// The mapping is STATELESS: the source distance consumed since the brake start is a
// closed-form function of the timeline offset `u`, so live playback and offline
// mixdown match regardless of block size, and seeks/scrubs/loops can never desync
// it (there is no accumulator to drift). For the rate curve r(x) = (1 - x/T)^p the
// consumed-source integral is
//     S(u) = T/(p+1) * (1 - (1 - u/T)^(p+1)).
// `T` (the effective brake length) is passed in by the caller because it is clamped
// to the clip's live duration on the audio thread; the snapshot only owns the
// requested length and the curve power, so a clip move/trim never makes it stale.
class BrakeSnapshot
{
  public:
    BrakeSnapshot() = default;

    static std::unique_ptr<BrakeSnapshot> create(juce::int64 brakeLenSamples,
                                                 double curvePower = kDefaultCurvePower)
    {
        auto snap = std::make_unique<BrakeSnapshot>();
        snap->brakeLenSamples = juce::jmax(static_cast<juce::int64>(0), brakeLenSamples);
        snap->curvePower = juce::jlimit(kMinCurvePower, kMaxCurvePower, curvePower);
        return snap;
    }

    bool isEmpty() const noexcept { return brakeLenSamples <= 0; }
    juce::int64 getBrakeLenSamples() const noexcept { return brakeLenSamples; }
    double getCurvePower() const noexcept { return curvePower; }

    // Source samples consumed from the brake start over `u` timeline samples, for an
    // effective brake length `T`. Monotonic non-decreasing in `u`; `S(0)=0` and
    // `S(T) = T/(p+1)` (the brake swallows the rest of the would-be tail). RT-safe.
    double sourceConsumedAt(double u, double effectiveLenSamples) const noexcept
    {
        const double t = effectiveLenSamples;
        if (t <= 0.0) return 0.0;
        const double uu = juce::jlimit(0.0, t, u);
        const double base = 1.0 - uu / t; // 1 -> 0 across the brake
        const double p1 = curvePower + 1.0;
        return (t / p1) * (1.0 - std::pow(base, p1));
    }

    // Instantaneous playback rate at timeline offset `u` (1 -> 0). Exposed for tests
    // and reasoning; the render path uses `sourceConsumedAt` directly.
    double rateAt(double u, double effectiveLenSamples) const noexcept
    {
        const double t = effectiveLenSamples;
        if (t <= 0.0) return 0.0;
        const double uu = juce::jlimit(0.0, t, u);
        return std::pow(1.0 - uu / t, curvePower);
    }

    // Amplitude envelope for the brake tail. As the platter halts, the rate (and so
    // the pitch) falls toward zero; below `kEndFadeRate` the signal is sub-audio mush
    // (and the rate freezing on a sample would leave a DC click at the stop), so it is
    // faded to silence with a smooth raised-cosine ramp keyed to the INSTANTANEOUS
    // rate. Fading by rate (not a fixed number of samples) keeps the stop clean and
    // tempo/length independent, and removes the gritty extreme-low-rate region.
    float gainAt(double u, double effectiveLenSamples) const noexcept
    {
        const double t = effectiveLenSamples;
        if (t <= 0.0) return 1.0F;
        if (u >= t) return 0.0F;
        const double rate = rateAt(u, effectiveLenSamples);
        if (rate >= kEndFadeRate) return 1.0F;
        const double x = rate / kEndFadeRate; // 1 at the fade start, 0 at the stop
        return static_cast<float>(0.5 - 0.5 * std::cos(juce::MathConstants<double>::pi * x));
    }

    static constexpr double kDefaultCurvePower = 2.0; // curved record-stop (fast drop then easing)
    static constexpr double kMinCurvePower = 1.0;     // linear rate (constant deceleration)
    static constexpr double kMaxCurvePower = 4.0;

    // Fixed platter stop time for a direct-drive deck (Technics SL-1210 factory brake
    // is ~0.7-1.0 s for 33 1/3 RPM -> 0; a punchy DJ stop is shorter). The brake
    // occupies this many seconds of the clip's timeline footprint, regardless of tempo.
    static constexpr double kPlatterStopSeconds = 0.6;

  private:
    // Below this playback rate (pitch ~2.5 octaves down) the slowed audio is sub-audio
    // grit; fade it out to a clean stop rather than rendering it to literal silence.
    static constexpr double kEndFadeRate = 0.15;

    juce::int64 brakeLenSamples = 0;
    double curvePower = kDefaultCurvePower;
};

} // namespace silverdaw
