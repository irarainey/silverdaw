// Shared offline DSP primitives for the per-stem cleanup/enhancement passes.
//
// These run on a worker thread after stem separation (never on the audio
// thread), so they are plain double-precision helpers with no lock-free or
// atomic machinery (unlike the real-time ToneEq). Each enhancer composes them
// with its own stage logic, so the shared filters, sanitiser, limiter, and
// statistics live here as the single source of truth.

#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <vector>

namespace silverdaw::enhancer_dsp
{

// Below this peak/level a stem is treated as silent: thresholds become
// meaningless and we must never divide by (or take the log of) zero.
constexpr float kSilenceFloor = 1.0e-6F;

// Loud/quiet contrast guards (active p95 minus gap p20, in dB) shared by the
// drum and bass cleanup expanders. Below the bypass floor the stem has no real
// gaps and gating would only expose artefacts, so the expander is skipped;
// between the floor and the full threshold the range is halved to stay gentle.
constexpr double kContrastBypassDb = 6.0;
constexpr double kContrastHalfRangeDb = 12.0;

// Direct Form I biquad in double precision. Offline use only, so it is a plain
// per-channel filter with no lock-free/atomic machinery. Coefficients are
// normalised on assignment.
struct Biquad
{
    double b0 = 1.0, b1 = 0.0, b2 = 0.0, a1 = 0.0, a2 = 0.0;
    double x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0;

    void reset() noexcept { x1 = x2 = y1 = y2 = 0.0; }

    inline double process(double x) noexcept
    {
        const double y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        return y;
    }
};

// RBJ 2nd-order Butterworth high-pass (Q = 1/sqrt(2)). Corner is clamped safely
// below Nyquist.
Biquad designButterHighPass(double sampleRate, double freqHz) noexcept;

// RBJ 2nd-order Butterworth low-pass (Q = 1/sqrt(2)). Corner is clamped safely
// below Nyquist.
Biquad designButterLowPass(double sampleRate, double freqHz) noexcept;

// Replaces any non-finite sample with zero so a stray NaN/Inf from the model can
// never poison the filter state, the level statistics, or the output WAV.
void sanitiseInPlace(juce::AudioBuffer<float>& buffer) noexcept;

// Per-channel high-pass over the whole buffer using a fresh Butterworth section.
void applyHighPass(juce::AudioBuffer<float>& buffer, double sampleRate, double freqHz) noexcept;

// Soft-knee peak safety. Samples below the knee pass through unchanged (so steady
// levels and the body of the signal are untouched); only peaks pushed past the
// knee are smoothly compressed toward the ceiling, avoiding hard-clip distortion
// without altering the rest of the signal.
void softLimitInPlace(juce::AudioBuffer<float>& buffer) noexcept;

// Soft-knee downward-expansion static curve. `overDb` is the detector level in dB
// relative to the threshold; returns the gain (dB, <= 0). The knee makes the
// transition continuous in value and slope so there are no audible steps.
double expansionGainDb(double overDb, double slope, double kneeDb, double rangeDb) noexcept;

// Linear value at a [0,1] percentile of a series (nearest-rank). The double
// overload copy-sorts the input; the float overload sorts the caller's buffer in
// place to avoid a copy in the per-bin spectral loop.
double percentile(std::vector<double> values, double p) noexcept;
double percentile(std::vector<float>& values, double p) noexcept;

} // namespace silverdaw::enhancer_dsp
