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
        fastEnvelope = 0.0F;
        slowEnvelope = 0.0F;
        currentGain = 1.0F;
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

            const float fastCoefficient = linkedPeak > fastEnvelope
                ? fastAttackCoefficient : fastReleaseCoefficient;
            fastEnvelope += fastCoefficient * (linkedPeak - fastEnvelope);
            const float slowCoefficient = linkedPeak > slowEnvelope
                ? slowAttackCoefficient : slowReleaseCoefficient;
            slowEnvelope += slowCoefficient * (linkedPeak - slowEnvelope);
            const float normalizedTransient = (fastEnvelope - slowEnvelope)
                / (fastEnvelope + kDetectorFloor);
            const float transientStrength = juce::jlimit(0.0F, 1.0F, normalizedTransient);
            const float targetGain = 1.0F + currentAmount * kMaxBoost * transientStrength;
            const float gainCoefficient = targetGain > currentGain
                ? gainAttackCoefficient : gainReleaseCoefficient;
            currentGain += gainCoefficient * (targetGain - currentGain);

            if (currentAmount > kBypassEpsilon)
            {
                for (int channel = 0; channel < channels; ++channel)
                {
                    const float input = buffer.getSample(channel, sample);
                    buffer.setSample(channel, sample, std::isfinite(input) ? input * currentGain : 0.0F);
                }
            }
        }
    }

private:
    static constexpr float kBypassEpsilon = 1.0e-5F;
    static constexpr float kSmoothTauSeconds = 0.02F;
    static constexpr float kFastAttackSeconds = 0.0005F;
    static constexpr float kFastReleaseSeconds = 0.010F;
    static constexpr float kSlowAttackSeconds = 0.005F;
    static constexpr float kSlowReleaseSeconds = 0.100F;
    static constexpr float kGainAttackSeconds = 0.002F;
    static constexpr float kGainReleaseSeconds = 0.050F;
    static constexpr float kDetectorFloor = 0.01F;
    static constexpr float kMaxBoost = 0.99526231F; // +6 dB

    static float sanitizeAmount(float value) noexcept
    {
        return juce::jlimit(0.0F, 1.0F, std::isfinite(value) ? value : 0.0F);
    }

    void updateCoefficients() noexcept
    {
        fastAttackCoefficient = onePoleCoefficient(kFastAttackSeconds);
        fastReleaseCoefficient = onePoleCoefficient(kFastReleaseSeconds);
        slowAttackCoefficient = onePoleCoefficient(kSlowAttackSeconds);
        slowReleaseCoefficient = onePoleCoefficient(kSlowReleaseSeconds);
        gainAttackCoefficient = onePoleCoefficient(kGainAttackSeconds);
        gainReleaseCoefficient = onePoleCoefficient(kGainReleaseSeconds);
    }

    float onePoleCoefficient(float timeSeconds) const noexcept
    {
        return 1.0F - static_cast<float>(std::exp(-1.0 / (timeSeconds * sr)));
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
    float fastEnvelope = 0.0F;
    float slowEnvelope = 0.0F;
    float currentGain = 1.0F;
    float fastAttackCoefficient = 0.0F;
    float fastReleaseCoefficient = 0.0F;
    float slowAttackCoefficient = 0.0F;
    float slowReleaseCoefficient = 0.0F;
    float gainAttackCoefficient = 0.0F;
    float gainReleaseCoefficient = 0.0F;

    static_assert(std::atomic<float>::is_always_lock_free,
                  "Punch publishes its amount through a lock-free atomic");
};

} // namespace silverdaw
