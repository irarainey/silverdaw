#pragma once

#include "AudioConstants.h"

#include <atomic>
#include <cstdint>
#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

// Real-time-safe keep-alive for sleep-prone output endpoints. Two cooperating parts:
//   1. A CONTINUOUS, inaudible "fluctuate" stream — isolated, sign-alternating, minimal-amplitude
//      impulses added on otherwise-silent blocks whenever an output device is open. An impulse is
//      broadband, so unlike a near-Nyquist tone (which a DAC's reconstruction filter strips before
//      its auto-mute detector sees it) it actually reaches the detector and keeps an already-*warm*
//      DAC out of auto-mute. Every stop->play in a session is then instant — no dropped opening
//      bar, no audible hiss.
//   2. A ONE-TIME, *denser* impulse stream (same inaudible amplitude, many more non-zero frames),
//      armed by the engine for a short pre-roll on the FIRST play after a device (re)start. Waking
//      a fully-*cold* DAC (just plugged in / selected / woken from deep sleep) needs a stronger
//      "signal present" kick + lock time; the denser stream provides it. One-time per device
//      session; later plays skip it. This is the small, acceptable first-play lead-in.
// Both are gated by keep-awake-enabled, so only sleep-prone (USB) endpoints incur the stream or the
// lead-in. A released or non-sleep-prone device outputs true digital silence.
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
    // endpoints get the fluctuate stream and the one-time first-play wake; everything else stays
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
    // bracket the pre-roll, switching the injected stream to the denser cold-wake rate.
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

    // Called from prepareToPlay (device/sample-rate start): tune the impulse intervals for the
    // active rate so the maintenance and cold-wake streams keep their per-second impulse rates.
    void prepare(double sampleRate) noexcept
    {
        const double sr = sampleRate > 0.0 ? sampleRate : 48000.0;
        maintInterval = intervalFrames(sr, kKeepAliveFluctuateHz);
        wakeInterval = intervalFrames(sr, kWakeFluctuateHz);
        frame = 0;
        // A device/sample-rate (re)start means the endpoint may be cold: arm the one-time wake so
        // the next play runs the wake pre-roll.
        markDeviceStarted();
    }

    // Audio thread: add the inaudible fluctuate stream on otherwise-silent blocks while the gate
    // is open. Impulses are isolated, minimal-amplitude, and sign-alternating (DC-free); the
    // denser cold-wake rate is used while the one-time wake band is armed. Returns true if any
    // impulse was written this block. There is no envelope to fade — a sparse minimal-amplitude
    // impulse stream is inherently click-free, and stopping simply means writing nothing.
    bool maybeApplyFloor(juce::AudioBuffer<float>& buffer, int startSample, int numSamples,
                         float programPeak) noexcept
    {
        const bool active = shouldRun() && programPeak <= silverdaw::kKeepAliveSilenceThreshold;
        if (! active)
            return false;

        const std::int64_t interval =
            wakeArmed.load(std::memory_order_acquire) ? wakeInterval : maintInterval;

        constexpr int kMaxChannels = 32;
        const int numChannels = juce::jmin(buffer.getNumChannels(), kMaxChannels);
        float* dest[kMaxChannels];
        for (int ch = 0; ch < numChannels; ++ch)
            dest[ch] = buffer.getWritePointer(ch, startSample);

        bool wrote = false;
        for (int i = 0; i < numSamples; ++i)
        {
            if (frame % interval == 0)
            {
                // Alternate the sign of successive impulses so the stream carries no DC bias.
                const bool negative = ((frame / interval) & std::int64_t{1}) != 0;
                const float sample = negative ? -kKeepAliveImpulse : kKeepAliveImpulse;
                for (int ch = 0; ch < numChannels; ++ch)
                    dest[ch][i] += sample;
                wrote = true;
            }
            ++frame;
        }
        return wrote;
    }

  private:
    static std::int64_t intervalFrames(double sampleRate, double hz) noexcept
    {
        const std::int64_t frames = static_cast<std::int64_t>(sampleRate / hz + 0.5);
        return frames < 2 ? std::int64_t{2} : frames;
    }

    std::atomic<bool> playing{false};
    std::atomic<bool> contentLoaded{false};
    std::atomic<bool> deviceActive{false};
    std::atomic<bool> keepAwakeEnabled{true};
    std::atomic<bool> needsWakePreroll{false};
    std::atomic<bool> wakeArmed{false};
    // Impulse-stream state — audio-thread only. prepare() runs from prepareToPlay during a
    // device/sample-rate (re)start, which JUCE serialises against the IO callback (the stream is
    // stopped across the restart), so these are never touched concurrently.
    std::int64_t frame{0};
    std::int64_t maintInterval{960};  // 50 Hz @ 48 kHz until prepare() tunes it
    std::int64_t wakeInterval{48};    // 1000 Hz @ 48 kHz until prepare() tunes it
};

} // namespace silverdaw