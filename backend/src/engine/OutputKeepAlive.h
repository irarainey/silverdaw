#pragma once

#include "AudioConstants.h"

#include <atomic>
#include <cmath>
#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

// Real-time-safe keep-alive for sleep-prone output endpoints. Two cooperating parts:
//   1. A CONTINUOUS, inaudible ultrasonic maintenance tone, added on otherwise-silent blocks
//      whenever an output device is open. This keeps an already-*warm* DAC from auto-muting, so
//      every stop->play in a session is instant — no dropped opening bar, no audible hiss.
//   2. A ONE-TIME, louder (still ultrasonic) cold-wake band, armed by the engine for a short
//      pre-roll on the FIRST play after a device (re)start. Waking a fully-*cold* DAC (just
//      plugged in / selected / woken from deep sleep) needs more than the maintenance tone; the
//      band gives it a stronger kick + lock time. One-time per device session; later plays skip
//      it. This is the small, acceptable first-play lead-in.
// Both are gated by keep-awake-enabled, so only sleep-prone (USB) endpoints incur the tone or the
// lead-in. The tone is ramped in/out to stay click-free; a released or non-sleep-prone device
// outputs true digital silence.
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

    // Keep-awake policy gate, driven by output-device classification. Only sleep-prone (USB)
    // endpoints get the maintenance tone and the one-time first-play wake; everything else stays
    // true digital silence and plays instantly. Defaults to true so a USB DAC is covered before
    // classification has run.
    void setKeepAwakeEnabled(bool enabled) noexcept
    {
        keepAwakeEnabled.store(enabled, std::memory_order_release);
    }
    bool isKeepAwakeEnabled() const noexcept
    {
        return keepAwakeEnabled.load(std::memory_order_acquire);
    }

    // One-time cold-wake handshake. markDeviceStarted() arms it on every device/sample-rate
    // (re)start (called from prepareToPlay); the engine consumes it with a short wake pre-roll on
    // the first subsequent play, then clearNeedsWake() so later plays are instant. arm()/disarm()
    // bracket the pre-roll, switching the injected level to the louder cold-wake band.
    void markDeviceStarted() noexcept { needsWakePreroll.store(true, std::memory_order_release); }
    bool needsWake() const noexcept { return needsWakePreroll.load(std::memory_order_acquire); }
    void clearNeedsWake() noexcept { needsWakePreroll.store(false, std::memory_order_release); }
    void arm() noexcept { wakeArmed.store(true, std::memory_order_release); }
    void disarm() noexcept { wakeArmed.store(false, std::memory_order_release); }
    bool isArmed() const noexcept { return wakeArmed.load(std::memory_order_acquire); }

    // An open output device keeps the endpoint warm; once the device closes the gate shuts and
    // the output returns to true digital silence. Non-sleep-prone endpoints never open the gate.
    bool shouldRun() const noexcept
    {
        if (! keepAwakeEnabled.load(std::memory_order_acquire))
            return false;
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
        // Ramp sized so the louder cold-wake band still reaches level well within the pre-roll.
        rampStep = static_cast<float>(
            static_cast<double>(kWakeTonePeak) / juce::jmax(1.0, kKeepAliveRampSeconds * sr));
        phase = 0.0F;
        envelope = 0.0F;
        // A device/sample-rate (re)start means the endpoint may be cold: arm the one-time wake so
        // the next play runs the wake pre-roll.
        markDeviceStarted();
    }

    // Audio thread: add the inaudible keep-alive tone on otherwise-silent blocks while the gate
    // is open, ramped to stay click-free. While the one-time cold-wake band is armed the level is
    // raised to kWakeTonePeak. Returns true if any tone was written this block.
    bool maybeApplyFloor(juce::AudioBuffer<float>& buffer, int startSample, int numSamples,
                         float programPeak) noexcept
    {
        const bool active = shouldRun() && programPeak <= silverdaw::kKeepAliveSilenceThreshold;
        const float runLevel =
            wakeArmed.load(std::memory_order_acquire) ? kWakeTonePeak : kKeepAliveTonePeak;
        const float target = active ? runLevel : 0.0F;

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
    std::atomic<bool> keepAwakeEnabled{true};
    std::atomic<bool> needsWakePreroll{false};
    std::atomic<bool> wakeArmed{false};
    // Oscillator state — audio-thread only. prepare() runs from prepareToPlay during a
    // device/sample-rate (re)start, which JUCE serialises against the IO callback (the stream
    // is stopped across the restart), so these non-atomic floats are never touched concurrently.
    float phase{0.0F};
    float phaseIncrement{0.0F};
    float envelope{0.0F};
    float rampStep{0.0F};
};

} // namespace silverdaw