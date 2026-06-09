#pragma once

#include "AudioConstants.h"

#include <atomic>
#include <cmath>
#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

// Real-time-safe keep-alive for sleep-prone output endpoints. Holds the DAC awake with an
// inaudible ultrasonic tone whenever an output device is open (or a project is loaded, or
// playback is active), so the first play is instant — no audible hiss and no wake pre-roll
// latency, and no cold-start window in which a freshly-opened/reconnected device could
// auto-mute. The tone is added only on otherwise-silent blocks and ramped in/out to stay
// click-free; once the output device is released the output is true digital silence.
class OutputKeepAlive
{
  public:

    void setPlaying(bool p) noexcept { playing.store(p, std::memory_order_release); }
    bool isPlaying() const noexcept { return playing.load(std::memory_order_acquire); }

    void setContentLoaded(bool loaded) noexcept
    {
        contentLoaded.store(loaded, std::memory_order_release);
    }
    bool isContentLoaded() const noexcept { return contentLoaded.load(std::memory_order_acquire); }

    // Open the gate for as long as an output device is running, so a freshly-opened or
    // reconnected endpoint is held awake from the moment the stream starts — before any project
    // is loaded. This closes the cold-start window in which the device would otherwise receive
    // true digital silence (and auto-mute) between device open and the first content load.
    void setDeviceActive(bool active) noexcept
    {
        deviceActive.store(active, std::memory_order_release);
    }
    bool isDeviceActive() const noexcept { return deviceActive.load(std::memory_order_acquire); }

    // An open output device keeps the endpoint warm; once the device closes the gate shuts and
    // the output returns to true digital silence.
    bool shouldRun() const noexcept
    {
        return playing.load(std::memory_order_acquire)
               || contentLoaded.load(std::memory_order_acquire)
               || deviceActive.load(std::memory_order_acquire);
    }

    // Called from prepareToPlay (device/sample-rate start): tune the oscillator for the active
    // rate. The tone sits just below Nyquist so it is inaudible at every supported rate while
    // remaining a full-level digital signal to the endpoint's auto-mute detector.
    void prepare(double sampleRate) noexcept
    {
        const double sr = sampleRate > 0.0 ? sampleRate : 48000.0;
        const double freq = sr >= 88200.0 ? 32000.0 : sr * 0.46;
        phaseIncrement = juce::MathConstants<float>::twoPi * static_cast<float>(freq / sr);
        rampStep = static_cast<float>(
            static_cast<double>(kKeepAliveTonePeak) / juce::jmax(1.0, kKeepAliveRampSeconds * sr));
        phase = 0.0F;
        envelope = 0.0F;
    }

    // Audio thread: add the inaudible keep-alive tone on otherwise-silent blocks while the gate
    // is open, ramped to stay click-free. Returns true if any tone was written this block.
    bool maybeApplyFloor(juce::AudioBuffer<float>& buffer, int startSample, int numSamples,
                         float programPeak) noexcept
    {
        const bool active = shouldRun() && programPeak <= silverdaw::kKeepAliveSilenceThreshold;
        const float target = active ? kKeepAliveTonePeak : 0.0F;

        // Gate closed and nothing left to fade out -> leave true digital silence.
        if (! active && envelope <= 0.0F)
            return false;

        constexpr int kMaxChannels = 32;
        const int numChannels = juce::jmin(buffer.getNumChannels(), kMaxChannels);
        float* dest[kMaxChannels];
        for (int ch = 0; ch < numChannels; ++ch)
            dest[ch] = buffer.getWritePointer(ch, startSample);

        bool wrote = false;
        for (int i = 0; i < numSamples; ++i)
        {
            if (envelope < target)
                envelope = juce::jmin(target, envelope + rampStep);
            else if (envelope > target)
                envelope = juce::jmax(target, envelope - rampStep);

            const float sample = std::sin(phase) * envelope;
            phase += phaseIncrement;
            if (phase >= juce::MathConstants<float>::twoPi)
                phase -= juce::MathConstants<float>::twoPi;

            if (envelope > 0.0F)
            {
                for (int ch = 0; ch < numChannels; ++ch)
                    dest[ch][i] += sample;
                wrote = true;
            }
        }
        return wrote;
    }

  private:
    std::atomic<bool> playing{false};
    std::atomic<bool> contentLoaded{false};
    std::atomic<bool> deviceActive{false};
    // Oscillator state — audio-thread only. prepare() runs from prepareToPlay during a
    // device/sample-rate (re)start, which JUCE serialises against the IO callback (the stream
    // is stopped across the restart), so these non-atomic floats are never touched concurrently.
    float phase{0.0F};
    float phaseIncrement{0.0F};
    float envelope{0.0F};
    float rampStep{0.0F};
};

} // namespace silverdaw