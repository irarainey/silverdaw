#pragma once

// Objective stem-separation metrics for the offline evaluation harness
// (`SilverdawStemEval`) and the unit tests. These give a numeric yardstick for
// "did this change actually improve separation?" instead of subjective A/B
// listening — the prerequisite for tuning shifts / overlap / post-processing /
// future models. Pure and ONNX-free.
//
// SI-SDR (scale-invariant signal-to-distortion ratio) is the standard source-
// separation metric: it projects the estimate onto the reference, so a stem that
// is correct but at a different gain still scores well (gain is not a separation
// error). Higher dB is better; an exact (or exactly-scaled) match is +inf,
// clamped to a large finite value.

#include <algorithm>
#include <cmath>
#include <limits>

#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

// Upper clamp for a perfect match so callers never propagate +inf into averages.
inline constexpr double kStemMetricCeilingDb = 200.0;

namespace detail
{
// Flatten an interleaved-by-channel view: returns dot products over the first
// `n` frames across all channels of two buffers (channel count taken as min).
struct DotSums
{
    double refDotEst = 0.0; // <ref, est>
    double refDotRef = 0.0; // <ref, ref>
    double estDotEst = 0.0; // <est, est>
};

inline DotSums dotSums(const juce::AudioBuffer<float>& reference,
                       const juce::AudioBuffer<float>& estimate)
{
    DotSums d;
    const int channels = std::min(reference.getNumChannels(), estimate.getNumChannels());
    const int frames = std::min(reference.getNumSamples(), estimate.getNumSamples());
    for (int ch = 0; ch < channels; ++ch)
    {
        const float* r = reference.getReadPointer(ch);
        const float* e = estimate.getReadPointer(ch);
        for (int i = 0; i < frames; ++i)
        {
            const double rv = static_cast<double>(r[i]);
            const double ev = static_cast<double>(e[i]);
            d.refDotEst += rv * ev;
            d.refDotRef += rv * rv;
            d.estDotEst += ev * ev;
        }
    }
    return d;
}
} // namespace detail

// Scale-invariant SDR in dB. Returns `kStemMetricCeilingDb` for a perfect match
// and a very negative value when the estimate is uncorrelated noise. A silent
// reference (no energy) returns 0 dB (nothing to separate).
inline double siSdrDb(const juce::AudioBuffer<float>& reference,
                      const juce::AudioBuffer<float>& estimate)
{
    const auto d = detail::dotSums(reference, estimate);
    if (d.refDotRef <= 0.0) return 0.0;

    const double alpha = d.refDotEst / d.refDotRef; // optimal projection scale
    const double targetEnergy = alpha * alpha * d.refDotRef;
    // ||e||^2 = ||est||^2 - 2*alpha*<ref,est> + alpha^2*||ref||^2
    double noiseEnergy = d.estDotEst - 2.0 * alpha * d.refDotEst + alpha * alpha * d.refDotRef;
    if (noiseEnergy < 0.0) noiseEnergy = 0.0; // guard tiny negative from rounding

    if (noiseEnergy <= 0.0 || targetEnergy <= 0.0)
        return targetEnergy > 0.0 ? kStemMetricCeilingDb : 0.0;

    const double db = 10.0 * std::log10(targetEnergy / noiseEnergy);
    return std::clamp(db, -kStemMetricCeilingDb, kStemMetricCeilingDb);
}

// Plain (scale-sensitive) SDR in dB: penalises a level mismatch as distortion.
inline double sdrDb(const juce::AudioBuffer<float>& reference,
                    const juce::AudioBuffer<float>& estimate)
{
    const int channels = std::min(reference.getNumChannels(), estimate.getNumChannels());
    const int frames = std::min(reference.getNumSamples(), estimate.getNumSamples());
    double signal = 0.0;
    double error = 0.0;
    for (int ch = 0; ch < channels; ++ch)
    {
        const float* r = reference.getReadPointer(ch);
        const float* e = estimate.getReadPointer(ch);
        for (int i = 0; i < frames; ++i)
        {
            const double rv = static_cast<double>(r[i]);
            const double diff = rv - static_cast<double>(e[i]);
            signal += rv * rv;
            error += diff * diff;
        }
    }
    if (signal <= 0.0) return 0.0;
    if (error <= 0.0) return kStemMetricCeilingDb;
    return std::clamp(10.0 * std::log10(signal / error), -kStemMetricCeilingDb, kStemMetricCeilingDb);
}

} // namespace silverdaw
