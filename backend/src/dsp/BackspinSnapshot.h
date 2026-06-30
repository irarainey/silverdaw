#pragma once

#include <algorithm>
#include <cmath>
#include <memory>

#include <juce_core/juce_core.h>

namespace silverdaw
{

// Immutable per-clip "turntable backspin" parameters, published to the audio
// thread by pointer (mirroring BrakeSnapshot / EdgeFadeSnapshot). The backspin
// emulates a DJ yanking the platter backwards at the end of a clip: at the
// trigger the playback REVERSES at a high speed and rewinds back through the
// audio just played, the spin decaying to a stop as the platter loses momentum.
// You hear the recognisable reverse "rewind" whoosh — pitched up and fast at
// first (|rate| > 1), dropping and slowing to a clean stop.
//
// Model: over the last `backspinLenSamples` of the clip's timeline footprint the
// reverse rate magnitude decays as r(u) = spinSpeed * (1 - u/T)^p (spinSpeed at
// u=0, 0 at u=T). The SOURCE position moves backward from the trigger position
// S0 by the analytic, STATELESS integral
//     Rewound(u) = spinSpeed * T/(p+1) * (1 - (1 - u/T)^(p+1)),
// so live playback and offline mixdown match regardless of block size and
// seeks/scrubs/loops can never desync it (no accumulator). `T` (the effective
// length) is passed in by the caller because it is clamped to the clip's live
// duration on the audio thread; the snapshot only owns the requested length,
// the peak spin speed, and the curve power.
class BackspinSnapshot
{
  public:
    BackspinSnapshot() = default;

    static std::unique_ptr<BackspinSnapshot> create(juce::int64 backspinLenSamples,
                                                    double spinSpeed = kDefaultSpinSpeed,
                                                    double curvePower = kDefaultCurvePower)
    {
        auto snap = std::make_unique<BackspinSnapshot>();
        snap->backspinLenSamples = juce::jmax(static_cast<juce::int64>(0), backspinLenSamples);
        snap->spinSpeed = juce::jlimit(kMinSpinSpeed, kMaxSpinSpeed, spinSpeed);
        snap->curvePower = juce::jlimit(kMinCurvePower, kMaxCurvePower, curvePower);
        return snap;
    }

    bool isEmpty() const noexcept { return backspinLenSamples <= 0; }
    juce::int64 getBackspinLenSamples() const noexcept { return backspinLenSamples; }
    double getSpinSpeed() const noexcept { return spinSpeed; }
    double getCurvePower() const noexcept { return curvePower; }

    // Source samples rewound BACKWARD from the trigger over `u` timeline samples,
    // for an effective length `T`. Monotonic non-decreasing; `Rewound(0)=0` and
    // `Rewound(T) = spinSpeed*T/(p+1)` (the total span the spin rewinds). RT-safe.
    double sourceRewoundAt(double u, double effectiveLenSamples) const noexcept
    {
        const double t = effectiveLenSamples;
        if (t <= 0.0) return 0.0;
        const double uu = juce::jlimit(0.0, t, u);
        const double base = 1.0 - uu / t; // 1 -> 0 across the spin
        const double p1 = curvePower + 1.0;
        return spinSpeed * (t / p1) * (1.0 - std::pow(base, p1));
    }

    // Total source span rewound across the whole spin (= Rewound(T)).
    double totalRewound(double effectiveLenSamples) const noexcept
    {
        const double t = juce::jmax(0.0, effectiveLenSamples);
        return spinSpeed * (t / (curvePower + 1.0));
    }

    // Instantaneous reverse-rate MAGNITUDE at timeline offset `u` (spinSpeed -> 0).
    double rateMagAt(double u, double effectiveLenSamples) const noexcept
    {
        const double t = effectiveLenSamples;
        if (t <= 0.0) return 0.0;
        const double uu = juce::jlimit(0.0, t, u);
        return spinSpeed * std::pow(1.0 - uu / t, curvePower);
    }

    // Click-guard / end fade. As the platter halts the rate magnitude falls toward
    // zero; below `kEndFadeRate` the slowed audio is sub-audio mush (and the rate
    // freezing on a sample would leave a DC click), so it is faded to silence with
    // a smooth raised-cosine ramp keyed to the instantaneous rate magnitude.
    float gainAt(double u, double effectiveLenSamples) const noexcept
    {
        const double t = effectiveLenSamples;
        if (t <= 0.0) return 1.0F;
        if (u >= t) return 0.0F;
        const double rate = rateMagAt(u, effectiveLenSamples);
        if (rate >= kEndFadeRate) return 1.0F;
        const double x = rate / kEndFadeRate; // 1 at the fade start, 0 at the stop
        return static_cast<float>(0.5 - 0.5 * std::cos(juce::MathConstants<double>::pi * x));
    }

    static constexpr double kDefaultSpinSpeed = 6.0; // peak reverse rate (x normal speed)
    static constexpr double kMinSpinSpeed = 2.0;
    static constexpr double kMaxSpinSpeed = 12.0;
    static constexpr double kDefaultCurvePower = 3.0; // front-loaded: fast pull then a quick decay
    static constexpr double kMinCurvePower = 1.0;
    static constexpr double kMaxCurvePower = 4.0;

    // Default spin duration in seconds (a quick DJ rewind). The backspin occupies
    // this many seconds of the clip's timeline footprint, regardless of tempo.
    static constexpr double kDefaultSpinSeconds = 0.6;

  private:
    // Below this rate magnitude the spin is essentially stopped; fade out cleanly.
    static constexpr double kEndFadeRate = 0.15;

    juce::int64 backspinLenSamples = 0;
    double spinSpeed = kDefaultSpinSpeed;
    double curvePower = kDefaultCurvePower;
};

} // namespace silverdaw
