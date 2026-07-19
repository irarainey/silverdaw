#pragma once

#include "SaturationParameters.h"

#include <atomic>
#include <cmath>

#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

// Per-track soft saturation. Zero Drive is an exact bypass regardless of Mix.
class Saturation
{
public:
    void prepare(double sampleRate) noexcept
    {
        sr = (sampleRate > 0.0 && std::isfinite(sampleRate)) ? sampleRate : 44100.0;
        currentDrive = targetDrive.load(std::memory_order_relaxed);
        currentMix = targetMix.load(std::memory_order_relaxed);
        recomputeDerived();
        prepared = true;
        snapRequested.store(false, std::memory_order_relaxed);
    }

    void reset() noexcept {}

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

        for (int channel = 0; channel < buffer.getNumChannels(); ++channel)
        {
            float* samples = buffer.getWritePointer(channel);
            for (int sample = startSample; sample < startSample + numSamples; ++sample)
            {
                const float dry = samples[sample];
                const float clipped = std::tanh(dry * driveGain) * normalization;
                const float driven = dry + currentDrive * (clipped - dry);
                samples[sample] = dry + currentMix * (driven - dry);
            }
        }
    }

private:
    static constexpr float kBypassEpsilon = 1.0e-5F;
    static constexpr float kMaxDriveGain = 10.0F;
    static constexpr float kSmoothTauSeconds = 0.02F;

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
        driveGain = 1.0F + (kMaxDriveGain - 1.0F) * currentDrive;
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

    static_assert(std::atomic<float>::is_always_lock_free,
                  "Saturation publishes params via lock-free atomics on the audio thread");
};

} // namespace silverdaw
