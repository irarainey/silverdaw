#include "VocalEnhancer.h"

#include "EnhancerDsp.h"

#include <algorithm>
#include <cmath>

namespace silverdaw
{
namespace
{

using enhancer_dsp::applyHighPass;
using enhancer_dsp::kSilenceFloor;
using enhancer_dsp::sanitiseInPlace;

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
