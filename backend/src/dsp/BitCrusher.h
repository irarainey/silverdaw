#pragma once

#include "BitCrusherParameters.h"

#include <array>
#include <atomic>
#include <cmath>

#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

// Per-track sample-rate reduction and bit-depth quantization. Mix zero is exact bypass.
class BitCrusher
{
public:
    void prepare(double sampleRate, int numChannels) noexcept
    {
        sr = (sampleRate > 0.0 && std::isfinite(sampleRate)) ? sampleRate : 44100.0;
        channels = juce::jlimit(1, kMaxChannels, numChannels);
        currentRate = targetRate.load(std::memory_order_relaxed);
        currentBits = targetBits.load(std::memory_order_relaxed);
        currentBoost = targetBoost.load(std::memory_order_relaxed);
        currentMix = targetMix.load(std::memory_order_relaxed);
        recomputeDerived();
        reset();
        prepared = true;
        snapRequested.store(false, std::memory_order_relaxed);
    }

    void reset() noexcept
    {
        capturePhase = 0.0F;
        hasHeldSample = false;
        heldSamples.fill(0.0F);
    }

    void setParams(float rate, int bits, float boost, float mix, bool snap) noexcept
    {
        targetRate.store(sanitizeRate(rate), std::memory_order_relaxed);
        targetBits.store(sanitizeBits(bits), std::memory_order_relaxed);
        targetBoost.store(sanitizeUnit(boost), std::memory_order_relaxed);
        targetMix.store(sanitizeUnit(mix), std::memory_order_relaxed);
        if (snap) snapRequested.store(true, std::memory_order_release);
    }

    void setRateTarget(float rate, bool snap) noexcept
    {
        targetRate.store(sanitizeRate(rate), std::memory_order_relaxed);
        if (snap) snapRequested.store(true, std::memory_order_release);
    }

    void setBitsTarget(float bits, bool snap) noexcept
    {
        targetBits.store(sanitizeBits(bits), std::memory_order_relaxed);
        if (snap) snapRequested.store(true, std::memory_order_release);
    }

    void setBoostTarget(float boost, bool snap) noexcept
    {
        targetBoost.store(sanitizeUnit(boost), std::memory_order_relaxed);
        if (snap) snapRequested.store(true, std::memory_order_release);
    }

    void setMixTarget(float mix, bool snap) noexcept
    {
        targetMix.store(sanitizeUnit(mix), std::memory_order_relaxed);
        if (snap) snapRequested.store(true, std::memory_order_release);
    }

    void process(juce::AudioBuffer<float>& buffer, int startSample, int numSamples) noexcept
    {
        if (!prepared || numSamples <= 0) return;

        if (snapRequested.exchange(false, std::memory_order_acquire))
        {
            currentRate = targetRate.load(std::memory_order_relaxed);
            currentBits = targetBits.load(std::memory_order_relaxed);
            currentBoost = targetBoost.load(std::memory_order_relaxed);
            currentMix = targetMix.load(std::memory_order_relaxed);
            recomputeDerived();
        }
        else if (smoothParams(numSamples))
        {
            recomputeDerived();
        }

        if (currentMix <= kBypassEpsilon) return;

        const int nCh = juce::jmin(buffer.getNumChannels(), channels);
        for (int sample = startSample; sample < startSample + numSamples; ++sample)
        {
            if (!hasHeldSample || capturePhase >= 1.0F)
            {
                if (hasHeldSample) capturePhase -= 1.0F;
                for (int channel = 0; channel < nCh; ++channel)
                {
                    const float input = buffer.getSample(channel, sample);
                    heldSamples[static_cast<size_t>(channel)] = quantize(input) * boostGain;
                }
                hasHeldSample = true;
            }

            for (int channel = 0; channel < nCh; ++channel)
            {
                const float dry = buffer.getSample(channel, sample);
                const float wet = heldSamples[static_cast<size_t>(channel)];
                buffer.setSample(channel, sample, dry + currentMix * (wet - dry));
            }

            capturePhase += currentRate;
        }
    }

private:
    static constexpr int kMaxChannels = 2;
    static constexpr int kMaxBits = bit_crusher::kMaxBits;
    static constexpr float kMaxBoostDb = 12.0F;
    static constexpr float kBypassEpsilon = 1.0e-5F;
    static constexpr float kSmoothTauSeconds = 0.02F;

    static float sanitizeUnit(float value) noexcept
    {
        return bit_crusher::sanitizeUnit(value);
    }

    static float sanitizeRate(float value) noexcept
    {
        return bit_crusher::sanitizeRate(value);
    }

    static int sanitizeBits(int value) noexcept
    {
        return bit_crusher::sanitizeBits(value);
    }

    static int sanitizeBits(float value) noexcept
    {
        return bit_crusher::sanitizeBits(value);
    }

    bool smoothParams(int numSamples) noexcept
    {
        const auto smooth = [this, numSamples](float current, float target) {
            if (std::abs(target - current) < kBypassEpsilon) return target;
            const double a = std::exp(-static_cast<double>(numSamples)
                                      / (static_cast<double>(kSmoothTauSeconds) * sr));
            const float alpha = static_cast<float>(juce::jlimit(0.0, 1.0, a));
            return target + (current - target) * alpha;
        };

        const float nextRate = smooth(currentRate, targetRate.load(std::memory_order_relaxed));
        const int nextBits = targetBits.load(std::memory_order_relaxed);
        const float nextBoost = smooth(currentBoost, targetBoost.load(std::memory_order_relaxed));
        const float nextMix = smooth(currentMix, targetMix.load(std::memory_order_relaxed));
        const bool changed = nextRate != currentRate || nextBits != currentBits
            || nextBoost != currentBoost || nextMix != currentMix;
        currentRate = nextRate;
        currentBits = nextBits;
        currentBoost = nextBoost;
        currentMix = nextMix;
        return changed;
    }

    void recomputeDerived() noexcept
    {
        quantizationSteps = static_cast<float>(1 << currentBits);
        boostGain = juce::Decibels::decibelsToGain(kMaxBoostDb * currentBoost);
    }

    float quantize(float sample) const noexcept
    {
        return std::round(sample * quantizationSteps) / quantizationSteps;
    }

    double sr = 44100.0;
    int channels = 2;
    bool prepared = false;
    std::atomic<float> targetRate{1.0F};
    std::atomic<int> targetBits{kMaxBits};
    std::atomic<float> targetBoost{0.0F};
    std::atomic<float> targetMix{0.0F};
    std::atomic<bool> snapRequested{false};
    float currentRate = 1.0F;
    int currentBits = kMaxBits;
    float currentBoost = 0.0F;
    float currentMix = 0.0F;
    float capturePhase = 0.0F;
    bool hasHeldSample = false;
    float quantizationSteps = static_cast<float>(1 << kMaxBits);
    float boostGain = 1.0F;
    std::array<float, kMaxChannels> heldSamples{};

    static_assert(std::atomic<float>::is_always_lock_free,
                  "BitCrusher publishes scalar params via lock-free atomics on the audio thread");
};

} // namespace silverdaw
