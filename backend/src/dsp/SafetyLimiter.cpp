#include "SafetyLimiter.h"

#include <cmath>

namespace silverdaw
{

namespace
{
constexpr float kKneeDb = -2.0F;
constexpr float kBypassEpsilon = 1.0e-5F;
constexpr double kToggleRampSeconds = 0.005;
}

void SafetyLimiter::prepare(double newSampleRate) noexcept
{
    sampleRate = (newSampleRate > 0.0 && std::isfinite(newSampleRate)) ? newSampleRate : 44100.0;
    mixStep = static_cast<float>(1.0 / juce::jmax(1.0, sampleRate * kToggleRampSeconds));
    reset();
}

void SafetyLimiter::reset() noexcept
{
    mix = targetEnabled.load(std::memory_order_relaxed) ? 1.0F : 0.0F;
    snapRequested.store(false, std::memory_order_relaxed);
}

void SafetyLimiter::setEnabled(bool enabled, bool snap) noexcept
{
    targetEnabled.store(enabled, std::memory_order_relaxed);
    if (snap)
        snapRequested.store(true, std::memory_order_release);
}

float SafetyLimiter::ceilingGain() noexcept
{
    return juce::Decibels::decibelsToGain(kCeilingDb);
}

float SafetyLimiter::limitedMagnitude(float magnitude) noexcept
{
    const float knee = juce::Decibels::decibelsToGain(kKneeDb);
    const float ceiling = ceilingGain();
    if (magnitude <= knee) return magnitude;
    if (magnitude >= ceiling) return ceiling;

    const float t = (magnitude - knee) / (ceiling - knee);
    return knee + (ceiling - knee) * (t + t * t - t * t * t);
}

void SafetyLimiter::process(juce::AudioBuffer<float>& buffer, int startSample,
                            int numSamples) noexcept
{
    if (numSamples <= 0 || buffer.getNumChannels() <= 0) return;

    const bool enabled = targetEnabled.load(std::memory_order_relaxed);
    if (snapRequested.exchange(false, std::memory_order_acquire))
        mix = enabled ? 1.0F : 0.0F;

    if (!enabled && mix <= kBypassEpsilon)
    {
        mix = 0.0F;
        return;
    }

    const int channels = buffer.getNumChannels();
    for (int sample = startSample; sample < startSample + numSamples; ++sample)
    {
        const float targetMix = enabled ? 1.0F : 0.0F;
        mix += juce::jlimit(-mixStep, mixStep, targetMix - mix);

        float peak = 0.0F;
        for (int channel = 0; channel < channels; ++channel)
            peak = juce::jmax(peak, std::abs(buffer.getSample(channel, sample)));

        const float limited = limitedMagnitude(peak);
        const float gain = peak > 0.0F ? limited / peak : 1.0F;
        for (int channel = 0; channel < channels; ++channel)
        {
            const float dry = buffer.getSample(channel, sample);
            buffer.setSample(channel, sample, dry + (dry * gain - dry) * mix);
        }
    }
}

} // namespace silverdaw
