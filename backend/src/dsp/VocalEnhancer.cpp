#include "VocalEnhancer.h"

#include <algorithm>
#include <cmath>

namespace silverdaw
{
namespace
{

// Per-strength tuning. The high-pass corner clears sub-bass bleed/rumble; the
// expander only acts on material well below the stem's own peak, so quiet vocal
// tails are preserved while inter-phrase bleed is pushed down. `rangeDb` caps
// the attenuation so the expander can never fully gate (chop) a tail.
struct StrengthParams
{
    double highPassHz;       // sub-bass high-pass corner
    double thresholdBelowDb; // expander threshold, in dB below the measured peak
    double ratio;            // downward-expansion ratio (> 1)
    double rangeDb;          // maximum attenuation the expander may apply
};

StrengthParams paramsFor(VocalEnhanceStrength strength) noexcept
{
    switch (strength)
    {
        case VocalEnhanceStrength::Light:
            return {60.0, 48.0, 1.5, 6.0};
        case VocalEnhanceStrength::Strong:
            return {100.0, 36.0, 2.5, 14.0};
        case VocalEnhanceStrength::Medium:
        default:
            return {80.0, 42.0, 2.0, 10.0};
    }
}

// Detector ballistics. Fast enough to ride vocal onsets, slow enough on release
// that the expander relaxes smoothly into phrases instead of pumping.
constexpr double kAttackMs = 5.0;
constexpr double kReleaseMs = 150.0;

// Below this peak the stem is treated as silent and the expander is skipped: the
// threshold would be meaningless and we must never divide by (or log) zero.
constexpr float kSilenceFloor = 1.0e-6F;

// Direct Form I biquad in double precision. Offline use only, so it is a plain
// per-channel filter with no lock-free/atomic machinery (unlike the real-time
// ToneEq). Coefficients are normalised on assignment.
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

// RBJ 2nd-order Butterworth high-pass (Q = 1/sqrt(2)); mirrors the corner design
// used elsewhere in the engine. Corner is clamped safely below Nyquist.
Biquad designButterHighPass(double sampleRate, double freqHz) noexcept
{
    Biquad f;
    const double fs = (sampleRate > 0.0 && std::isfinite(sampleRate)) ? sampleRate : 44100.0;
    const double freq = std::clamp(freqHz, 10.0, fs * 0.49);
    const double w0 = 2.0 * juce::MathConstants<double>::pi * freq / fs;
    const double cw = std::cos(w0);
    const double sw = std::sin(w0);
    const double q = 1.0 / std::sqrt(2.0);
    const double alpha = sw / (2.0 * q);
    const double a0 = 1.0 + alpha;
    const double onePlusCw = 1.0 + cw;

    f.b0 = (onePlusCw / 2.0) / a0;
    f.b1 = (-onePlusCw) / a0;
    f.b2 = (onePlusCw / 2.0) / a0;
    f.a1 = (-2.0 * cw) / a0;
    f.a2 = (1.0 - alpha) / a0;
    return f;
}

// Replaces any non-finite sample with zero so a stray NaN/Inf from the model can
// never poison the filter state, the peak measurement, or the output WAV.
void sanitiseInPlace(juce::AudioBuffer<float>& buffer) noexcept
{
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
    {
        float* data = buffer.getWritePointer(ch);
        for (int i = 0; i < buffer.getNumSamples(); ++i)
            if (! std::isfinite(data[i]))
                data[i] = 0.0F;
    }
}

void applyHighPass(juce::AudioBuffer<float>& buffer, double sampleRate, double freqHz) noexcept
{
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
    {
        Biquad f = designButterHighPass(sampleRate, freqHz);
        float* data = buffer.getWritePointer(ch);
        for (int i = 0; i < buffer.getNumSamples(); ++i)
            data[i] = static_cast<float>(f.process(static_cast<double>(data[i])));
    }
}

float bufferPeak(const juce::AudioBuffer<float>& buffer) noexcept
{
    float peak = 0.0F;
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        peak = std::max(peak, buffer.getMagnitude(ch, 0, buffer.getNumSamples()));
    return peak;
}

// Wide-band downward expander. A single shared detector (max across channels)
// drives one gain applied identically to every channel, so the stereo image is
// untouched. The static curve is continuous at the threshold (0 dB there) and
// clamped to `rangeDb`, so there are no value jumps and tails are never gated.
void applyExpander(juce::AudioBuffer<float>& buffer, double sampleRate,
                   float peak, const StrengthParams& params) noexcept
{
    const double fs = (sampleRate > 0.0 && std::isfinite(sampleRate)) ? sampleRate : 44100.0;
    const double peakDb = 20.0 * std::log10(std::max(peak, kSilenceFloor));
    const double thresholdDb = peakDb - params.thresholdBelowDb;
    const double slope = params.ratio - 1.0;

    const double aAtt = std::exp(-1.0 / (kAttackMs * 0.001 * fs));
    const double aRel = std::exp(-1.0 / (kReleaseMs * 0.001 * fs));

    const int numCh = buffer.getNumChannels();
    const int numSamples = buffer.getNumSamples();
    double env = 0.0;

    for (int i = 0; i < numSamples; ++i)
    {
        double detector = 0.0;
        for (int ch = 0; ch < numCh; ++ch)
            detector = std::max(detector, std::abs(static_cast<double>(buffer.getSample(ch, i))));

        const double coeff = detector > env ? aAtt : aRel;
        env = coeff * env + (1.0 - coeff) * detector;

        const double envDb = 20.0 * std::log10(env + 1.0e-9);
        const double overDb = envDb - thresholdDb;
        double gainDb = overDb < 0.0 ? slope * overDb : 0.0;
        gainDb = std::max(gainDb, -params.rangeDb);
        const float gain = static_cast<float>(std::pow(10.0, gainDb / 20.0));

        for (int ch = 0; ch < numCh; ++ch)
        {
            float* data = buffer.getWritePointer(ch);
            data[i] *= gain;
        }
    }
}

} // namespace

VocalEnhanceStrength vocalEnhanceStrengthFromString(const juce::String& text) noexcept
{
    const auto t = text.trim().toLowerCase();
    if (t == "light") return VocalEnhanceStrength::Light;
    if (t == "strong") return VocalEnhanceStrength::Strong;
    return VocalEnhanceStrength::Medium;
}

const char* vocalEnhanceStrengthToString(VocalEnhanceStrength strength) noexcept
{
    switch (strength)
    {
        case VocalEnhanceStrength::Light: return "light";
        case VocalEnhanceStrength::Strong: return "strong";
        case VocalEnhanceStrength::Medium:
        default: return "medium";
    }
}

float vocalDenoiseWetFor(VocalEnhanceStrength strength) noexcept
{
    switch (strength)
    {
        case VocalEnhanceStrength::Light: return 0.5F;
        case VocalEnhanceStrength::Strong: return 1.0F;
        case VocalEnhanceStrength::Medium:
        default: return 0.75F;
    }
}

void VocalEnhancer::process(juce::AudioBuffer<float>& buffer, double sampleRate,
                            const VocalEnhanceOptions& options)
{
    if (! options.enabled) return;
    if (buffer.getNumChannels() <= 0 || buffer.getNumSamples() <= 0) return;
    if (! (sampleRate > 0.0) || ! std::isfinite(sampleRate)) return;

    const juce::ScopedNoDenormals noDenormals;
    const StrengthParams params = paramsFor(options.strength);

    sanitiseInPlace(buffer);
    applyHighPass(buffer, sampleRate, params.highPassHz);

    const float peak = bufferPeak(buffer);
    if (peak <= kSilenceFloor) return; // silent after the high-pass; nothing to expand
    applyExpander(buffer, sampleRate, peak, params);
}

} // namespace silverdaw
