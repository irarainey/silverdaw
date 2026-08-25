#pragma once

#include <atomic>

#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

// Per-track plugin delay compensation (ADR 0026). The message thread publishes a target
// delay; the audio thread crossfades to it over one block so a plugin appearing, being
// removed, or being bypassed cannot click.
class LatencyDelayLine final
{
public:
    /** Message thread. Allocates; call from `prepareToPlay`. */
    void prepare(int numChannels, int maxDelay, int maxBlockSamples)
    {
        channels = juce::jmax(1, numChannels);
        maxDelaySamples = juce::jmax(0, maxDelay);
        capacity = maxDelaySamples + juce::jmax(1, maxBlockSamples) + 1;
        fadeLength = juce::jmax(1, maxBlockSamples);
        history.setSize(channels, capacity, false, true, false);
        reset();
    }

    /** Call only with the graph quiescent; `requestReset` is the live-path equivalent. */
    void reset() noexcept
    {
        resetRequested.store(false, std::memory_order_relaxed);
        clearState();
    }

    /** Message thread, lock-free. The audio thread drops the tail on its next block. */
    void requestReset() noexcept
    {
        resetRequested.store(true, std::memory_order_release);
    }

    /** Message thread. Clamped to the prepared capacity when the audio thread reads it. */
    void setDelaySamples(int samples) noexcept
    {
        target.store(juce::jmax(0, samples), std::memory_order_relaxed);
    }

    int getDelaySamples() const noexcept { return target.load(std::memory_order_relaxed); }

    /** Audio thread. In place, no allocation. */
    void process(juce::AudioBuffer<float>& buffer, int startSample, int numSamples) noexcept
    {
        if (capacity <= 1 || numSamples <= 0) return;

        if (resetRequested.exchange(false, std::memory_order_acquire)) clearState();

        const int wanted = clampDelay(target.load(std::memory_order_relaxed));
        if (fadeRemaining == 0 && wanted != activeDelay)
        {
            fadeTarget = wanted;
            fadeRemaining = fadeLength;
        }

        // History is kept even while dry so a later delay has a tail to fade into.
        const bool dry = (fadeRemaining == 0 && activeDelay == 0);
        const int chans = juce::jmin(channels, buffer.getNumChannels());
        const float fadeScale = 1.0F / static_cast<float>(fadeLength);

        int lastWritePos = writePos;
        int lastFade = fadeRemaining;

        for (int ch = 0; ch < chans; ++ch)
        {
            float* data = buffer.getWritePointer(ch) + startSample;
            float* tail = history.getWritePointer(ch);
            int wp = writePos;
            int fade = fadeRemaining;

            for (int i = 0; i < numSamples; ++i)
            {
                tail[wp] = data[i];
                if (! dry)
                {
                    const float held = tail[readIndex(wp, activeDelay)];
                    if (fade > 0)
                    {
                        --fade;
                        const float mix = 1.0F - (static_cast<float>(fade) * fadeScale);
                        data[i] = held + (tail[readIndex(wp, fadeTarget)] - held) * mix;
                    }
                    else
                    {
                        data[i] = held;
                    }
                }
                if (++wp >= capacity) wp = 0;
            }

            lastWritePos = wp;
            lastFade = fade;
        }

        writePos = lastWritePos;
        fadeRemaining = lastFade;
        if (fadeRemaining == 0) activeDelay = fadeTarget;
    }

private:
    void clearState() noexcept
    {
        history.clear();
        writePos = 0;
        fadeRemaining = 0;
        activeDelay = clampDelay(target.load(std::memory_order_relaxed));
        fadeTarget = activeDelay;
    }

    int clampDelay(int samples) const noexcept
    {
        return juce::jlimit(0, maxDelaySamples, samples);
    }

    int readIndex(int wp, int delay) const noexcept
    {
        const int rp = wp - delay;
        return rp < 0 ? rp + capacity : rp;
    }

    juce::AudioBuffer<float> history;
    std::atomic<int> target{0};
    std::atomic<bool> resetRequested{false};
    int channels = 0;
    int capacity = 0;
    int maxDelaySamples = 0;
    int fadeLength = 1;
    // Audio-thread owned.
    int writePos = 0;
    int activeDelay = 0;
    int fadeTarget = 0;
    int fadeRemaining = 0;
};

} // namespace silverdaw
