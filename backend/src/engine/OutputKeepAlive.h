#pragma once

#include "AudioConstants.h"

#include <atomic>
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

namespace silverdaw
{

// Real-time-safe keep-alive floor for sleep-prone output endpoints.
class OutputKeepAlive
{
  public:

    void setPlaying(bool p) noexcept { playing.store(p, std::memory_order_release); }
    bool isPlaying() const noexcept { return playing.load(std::memory_order_acquire); }

    // Wake pre-roll spends endpoint fade-in on the keep-alive floor, not the first content
    // attack.
    void setWakePreroll(bool active) noexcept
    {
        wakePreroll.store(active, std::memory_order_release);
    }
    bool isWakePreroll() const noexcept { return wakePreroll.load(std::memory_order_acquire); }

    void setContentLoaded(bool loaded) noexcept
    {
        contentLoaded.store(loaded, std::memory_order_release);
    }
    bool isContentLoaded() const noexcept { return contentLoaded.load(std::memory_order_acquire); }

    // Keep-alive only wakes sleep-prone endpoints; idle output remains true digital silence.
    bool shouldRun() const noexcept
    {
        return playing.load(std::memory_order_acquire)
               || wakePreroll.load(std::memory_order_acquire);
    }

    bool maybeApplyFloor(juce::AudioBuffer<float>& buffer, int startSample, int numSamples,
                         float programPeak) noexcept
    {
        if (! shouldRun()) return false;
        if (programPeak > silverdaw::kKeepAliveSilenceThreshold) return false;

        constexpr float int32Scale = 1.0F / 2147483648.0F; // int32 → ~[-1, 1)
        constexpr float ditherScale = silverdaw::kKeepAliveDitherAmplitude * 0.5F;
        const int numChannels = buffer.getNumChannels();
        for (int ch = 0; ch < numChannels; ++ch)
        {
            float* const dest = buffer.getWritePointer(ch, startSample);
            for (int i = 0; i < numSamples; ++i)
            {
                const float u1 = static_cast<float>(static_cast<juce::int32>(nextRandom())) * int32Scale;
                const float u2 = static_cast<float>(static_cast<juce::int32>(nextRandom())) * int32Scale;
                dest[i] += (u1 + u2) * ditherScale;
            }
        }
        return true;
    }

  private:
    juce::uint32 nextRandom() noexcept
    {
        juce::uint32 x = rngState;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        rngState = x;
        return x;
    }

    std::atomic<bool> playing{false};
    std::atomic<bool> wakePreroll{false};
    std::atomic<bool> contentLoaded{false};
    // Message-thread writes are published for bounded, lock-free audio-thread reads.
    juce::uint32 rngState{0x9E3779B9u};
};

} // namespace silverdaw
