#pragma once

#include <atomic>
#include <cmath>

#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

// Stereo-linked transient enhancer. Zero amount is an exact bypass.
class Punch
{
public:
    void prepare(double sampleRate) noexcept
    {
        sr = (sampleRate > 0.0 && std::isfinite(sampleRate)) ? sampleRate : 44100.0;
        currentAmount = targetAmount.load(std::memory_order_relaxed);
        updateCoefficients();
        reset();
        prepared = true;
        snapRequested.store(false, std::memory_order_relaxed);
    }

    void reset() noexcept
    {
        currentAmount = targetAmount.load(std::memory_order_relaxed);
        envelope = 0.0F;
    }

    void setAmount(float amount, bool snap) noexcept
    {
        targetAmount.store(sanitizeAmount(amount), std::memory_order_relaxed);
        if (snap) snapRequested.store(true, std::memory_order_release);
    }

    void process(juce::AudioBuffer<float>& buffer, int startSample, int numSamples) noexcept
    {
        if (!prepared || numSamples <= 0) return;

        if (snapRequested.exchange(false, std::memory_order_acquire))
            currentAmount = targetAmount.load(std::memory_order_relaxed);
        else
            smoothAmount(numSamples);

        if (currentAmount <= kBypassEpsilon)
        {
            reset();
            return;
        }

        const int channels = buffer.getNumChannels();
        for (int sample = startSample; sample < startSample + numSamples; ++sample)
        {
            float linkedPeak = 0.0F;
            for (int channel = 0; channel < channels; ++channel)
            {
                const float input = buffer.getSample(channel, sample);
                linkedPeak = juce::jmax(linkedPeak,
                                        std::isfinite(input) ? std::abs(input) : 0.0F);
            }

            const float transient = juce::jmax(0.0F, linkedPeak - envelope);
            const float coefficient = linkedPeak > envelope ? attackCoefficient : releaseCoefficient;
            envelope += coefficient * (linkedPeak - envelope);

            const float normalizedTransient = transient / (envelope + kDetectorFloor);
            const float gain = 1.0F + currentAmount * kMaxBoost
                * juce::jlimit(0.0F, 1.0F, normalizedTransient);
            for (int channel = 0; channel < channels; ++channel)
            {
                const float input = buffer.getSample(channel, sample);
                buffer.setSample(channel, sample, std::isfinite(input) ? input * gain : 0.0F);
            }
        }
    }

private:
    static constexpr float kBypassEpsilon = 1.0e-5F;
    static constexpr float kSmoothTauSeconds = 0.02F;
    static constexpr float kAttackSeconds = 0.0015F;
    static constexpr float kReleaseSeconds = 0.060F;
    static constexpr float kDetectorFloor = 0.01F;
    static constexpr float kMaxBoost = 2.0F;

    static float sanitizeAmount(float value) noexcept
    {
        return juce::jlimit(0.0F, 1.0F, std::isfinite(value) ? value : 0.0F);
    }

    void updateCoefficients() noexcept
    {
        attackCoefficient = 1.0F - static_cast<float>(std::exp(-1.0 / (kAttackSeconds * sr)));
        releaseCoefficient = 1.0F - static_cast<float>(std::exp(-1.0 / (kReleaseSeconds * sr)));
    }

    void smoothAmount(int numSamples) noexcept
    {
        const float target = targetAmount.load(std::memory_order_relaxed);
        if (std::abs(target - currentAmount) < kBypassEpsilon)
        {
            currentAmount = target;
            return;
        }
        const double alpha = std::exp(-static_cast<double>(numSamples)
                                      / (static_cast<double>(kSmoothTauSeconds) * sr));
        currentAmount = target + (currentAmount - target)
            * static_cast<float>(juce::jlimit(0.0, 1.0, alpha));
    }

    double sr = 44100.0;
    bool prepared = false;
    std::atomic<float> targetAmount{0.0F};
    std::atomic<bool> snapRequested{false};
    float currentAmount = 0.0F;
    float envelope = 0.0F;
    float attackCoefficient = 0.0F;
    float releaseCoefficient = 0.0F;

    static_assert(std::atomic<float>::is_always_lock_free,
                  "Punch publishes its amount through a lock-free atomic");
};

} // namespace silverdaw
