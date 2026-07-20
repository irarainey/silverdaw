#pragma once

#include "SaturationParameters.h"

#include <array>
#include <atomic>
#include <cmath>

#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

// Per-track soft saturation. First-order ADAA suppresses waveshaper aliases without latency.
class Saturation
{
public:
    void prepare(double sampleRate) noexcept
    {
        sr = (sampleRate > 0.0 && std::isfinite(sampleRate)) ? sampleRate : 44100.0;
        currentDrive = targetDrive.load(std::memory_order_relaxed);
        currentMix = targetMix.load(std::memory_order_relaxed);
        recomputeDerived();
        reset();
        prepared = true;
        snapRequested.store(false, std::memory_order_relaxed);
    }

    void reset() noexcept { previousInputs.fill(0.0F); }

    void setParams(float drive, float mix, bool snap) noexcept
    {
        targetDrive.store(saturation::sanitizeDrive(drive), std::memory_order_relaxed);
        targetMix.store(saturation::sanitizeMix(mix), std::memory_order_relaxed);
        if (snap) snapRequested.store(true, std::memory_order_release);
    }

    void setDriveTarget(float drive, bool snap) noexcept
    {
        targetDrive.store(saturation::sanitizeDrive(drive), std::memory_order_relaxed);
        if (snap) snapRequested.store(true, std::memory_order_release);
    }

    void setMixTarget(float mix, bool snap) noexcept
    {
        targetMix.store(saturation::sanitizeMix(mix), std::memory_order_relaxed);
        if (snap) snapRequested.store(true, std::memory_order_release);
    }

    void process(juce::AudioBuffer<float>& buffer, int startSample, int numSamples) noexcept
    {
        if (!prepared || numSamples <= 0) return;

        if (snapRequested.exchange(false, std::memory_order_acquire))
        {
            currentDrive = targetDrive.load(std::memory_order_relaxed);
            currentMix = targetMix.load(std::memory_order_relaxed);
            recomputeDerived();
        }
        else if (smoothParams(numSamples))
        {
            recomputeDerived();
        }

        if (currentDrive <= kBypassEpsilon || currentMix <= kBypassEpsilon) return;

        const int channels = juce::jmin(buffer.getNumChannels(), kMaxChannels);
        jassert(buffer.getNumChannels() <= kMaxChannels);
        for (int channel = 0; channel < channels; ++channel)
        {
            float* samples = buffer.getWritePointer(channel);
            float previous = previousInputs[static_cast<size_t>(channel)];
            for (int sample = startSample; sample < startSample + numSamples; ++sample)
            {
                const float dry = std::isfinite(samples[sample]) ? samples[sample] : 0.0F;
                const float drivenInput = dry * driveGain;
                const float previousDrivenInput = previous * driveGain;
                const float clipped = antialiasedTanh(drivenInput, previousDrivenInput) * normalization;
                previous = dry;
                const float driven = dry + currentDrive * (clipped - dry);
                samples[sample] = dry + currentMix * (driven - dry);
            }
            previousInputs[static_cast<size_t>(channel)] = previous;
        }
    }

private:
    static constexpr float kBypassEpsilon = 1.0e-5F;
    static constexpr float kMaxDriveGain = 10.0F;
    static constexpr float kSmoothTauSeconds = 0.02F;
    static constexpr float kAdaaDeltaEpsilon = 1.0e-5F;
    static constexpr float kLogTwo = 0.69314718F;
    static constexpr int kMaxChannels = 2;

    static float logCosh(float value) noexcept
    {
        const float magnitude = std::abs(value);
        return magnitude + std::log1p(std::exp(-2.0F * magnitude)) - kLogTwo;
    }

    static float antialiasedTanh(float current, float previous) noexcept
    {
        const float delta = current - previous;
        if (std::abs(delta) <= kAdaaDeltaEpsilon)
            return std::tanh((current + previous) * 0.5F);
        return (logCosh(current) - logCosh(previous)) / delta;
    }

    static float shapeDrive(float drive) noexcept { return drive * drive; }

    bool smoothParams(int numSamples) noexcept
    {
        const auto smooth = [this, numSamples](float current, float target) {
            if (std::abs(target - current) < kBypassEpsilon) return target;
            const double a = std::exp(-static_cast<double>(numSamples)
                                      / (static_cast<double>(kSmoothTauSeconds) * sr));
            const float alpha = static_cast<float>(juce::jlimit(0.0, 1.0, a));
            return target + (current - target) * alpha;
        };

        const float nextDrive = smooth(currentDrive, targetDrive.load(std::memory_order_relaxed));
        const float nextMix = smooth(currentMix, targetMix.load(std::memory_order_relaxed));
        const bool changed = nextDrive != currentDrive || nextMix != currentMix;
        currentDrive = nextDrive;
        currentMix = nextMix;
        return changed;
    }

    void recomputeDerived() noexcept
    {
        driveGain = 1.0F + (kMaxDriveGain - 1.0F) * shapeDrive(currentDrive);
        normalization = 1.0F / std::tanh(driveGain);
    }

    double sr = 44100.0;
    bool prepared = false;
    std::atomic<float> targetDrive{0.0F};
    std::atomic<float> targetMix{1.0F};
    std::atomic<bool> snapRequested{false};
    float currentDrive = 0.0F;
    float currentMix = 1.0F;
    float driveGain = 1.0F;
    float normalization = 1.0F;
    std::array<float, kMaxChannels> previousInputs{};

    static_assert(std::atomic<float>::is_always_lock_free,
                  "Saturation publishes params via lock-free atomics on the audio thread");
};

} // namespace silverdaw
