#include "EnhancerDsp.h"

#include <algorithm>
#include <cmath>

namespace silverdaw::enhancer_dsp
{
namespace
{

// Shared RBJ corner geometry (Q = 1/sqrt(2)); the corner is clamped safely below
// Nyquist so high-/low-pass designs stay numerically stable at any sample rate.
void biquadCornerTerms(double sampleRate, double freqHz, double& cw, double& alpha) noexcept
{
    const double fs = (sampleRate > 0.0 && std::isfinite(sampleRate)) ? sampleRate : 44100.0;
    const double freq = std::clamp(freqHz, 10.0, fs * 0.49);
    const double w0 = 2.0 * juce::MathConstants<double>::pi * freq / fs;
    cw = std::cos(w0);
    const double q = 1.0 / std::sqrt(2.0);
    alpha = std::sin(w0) / (2.0 * q);
}

} // namespace

Biquad designButterHighPass(double sampleRate, double freqHz) noexcept
{
    double cw = 0.0, alpha = 0.0;
    biquadCornerTerms(sampleRate, freqHz, cw, alpha);
    Biquad f;
    const double a0 = 1.0 + alpha;
    const double onePlusCw = 1.0 + cw;
    f.b0 = (onePlusCw / 2.0) / a0;
    f.b1 = (-onePlusCw) / a0;
    f.b2 = (onePlusCw / 2.0) / a0;
    f.a1 = (-2.0 * cw) / a0;
    f.a2 = (1.0 - alpha) / a0;
    return f;
}

Biquad designButterLowPass(double sampleRate, double freqHz) noexcept
{
    double cw = 0.0, alpha = 0.0;
    biquadCornerTerms(sampleRate, freqHz, cw, alpha);
    Biquad f;
    const double a0 = 1.0 + alpha;
    const double oneMinusCw = 1.0 - cw;
    f.b0 = (oneMinusCw / 2.0) / a0;
    f.b1 = oneMinusCw / a0;
    f.b2 = (oneMinusCw / 2.0) / a0;
    f.a1 = (-2.0 * cw) / a0;
    f.a2 = (1.0 - alpha) / a0;
    return f;
}

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

void softLimitInPlace(juce::AudioBuffer<float>& buffer) noexcept
{
    constexpr float knee = 0.9F;
    constexpr float ceiling = 0.9999F;
    const float range = ceiling - knee;
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
    {
        float* data = buffer.getWritePointer(ch);
        for (int i = 0; i < buffer.getNumSamples(); ++i)
        {
            const float a = std::abs(data[i]);
            if (a <= knee) continue;
            const float comp = range * std::tanh((a - knee) / range);
            data[i] = std::copysign(knee + comp, data[i]);
        }
    }
}

double expansionGainDb(double overDb, double slope, double kneeDb, double rangeDb) noexcept
{
    const double halfKnee = kneeDb * 0.5;
    double gainDb;
    if (overDb >= halfKnee)
        gainDb = 0.0;
    else if (overDb <= -halfKnee)
        gainDb = slope * overDb;
    else
    {
        const double d = halfKnee - overDb; // 0..kneeDb across the knee
        gainDb = -slope * (d * d) / (2.0 * kneeDb);
    }
    return std::max(gainDb, -rangeDb);
}

double percentile(std::vector<double> values, double p) noexcept
{
    if (values.empty()) return 0.0;
    std::sort(values.begin(), values.end());
    const double clamped = std::clamp(p, 0.0, 1.0);
    auto idx = static_cast<size_t>(clamped * static_cast<double>(values.size() - 1) + 0.5);
    return values[std::min(idx, values.size() - 1)];
}

double percentile(std::vector<float>& values, double p) noexcept
{
    if (values.empty()) return 0.0;
    std::sort(values.begin(), values.end());
    const double clamped = std::clamp(p, 0.0, 1.0);
    auto idx = static_cast<size_t>(clamped * static_cast<double>(values.size() - 1) + 0.5);
    return values[std::min(idx, values.size() - 1)];
}

} // namespace silverdaw::enhancer_dsp
