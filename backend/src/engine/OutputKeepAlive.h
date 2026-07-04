#pragma once

#include "AudioConstants.h"

#include <atomic>
#include <cstdint>
#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

// Real-time-safe keep-alive for sleep-prone output endpoints. A CONTINUOUS, inaudible dither
// stream is added on otherwise-silent blocks whenever a sleep-prone output device is the selected
// output. A generic USB-Audio-Class dongle DAC auto-mutes its headphone amp on silence (commonly
// on runs of exact-zero PCM, and/or on energy below a short-window threshold); continuous broadband
// dither keeps *every* sample non-zero with steady in-band energy the detector registers as "audio
// present", while sitting at the format noise floor so it stays inaudible. The endpoint is held
// awake from the moment the device opens — before any project is even loaded — so playback is
// instant: programme audio starts at full level from the first sample, with no wake pre-roll.
// Because the holding dither can keep a *warm* device awake but is too quiet to *wake a cold one*,
// every device (re)start also emits a brief, decaying broadband wake burst (see prepare()) to rouse
// an amp that auto-muted while the app was closed — finishing long before the user presses play.
// Gated by keep-awake-enabled, so only sleep-prone (USB) endpoints incur the dither; a released or
// non-sleep-prone device outputs true digital silence.
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

    // Keep-awake policy gate. An explicit per-device user choice (default off): only devices the
    // user has opted in get the dither + wake burst; everything else stays true digital silence
    // and plays instantly. The launcher enables it before the preferred device opens (via env) so
    // a cold DAC wakes at stream start; the renderer re-pushes the open device's setting on connect.
    void setKeepAwakeEnabled(bool enabled) noexcept
    {
        keepAwakeEnabled.store(enabled, std::memory_order_release);
    }
    bool isKeepAwakeEnabled() const noexcept
    {
        return keepAwakeEnabled.load(std::memory_order_acquire);
    }

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

    // Called from prepareToPlay (device/sample-rate start). The dither is rate-independent; this
    // reseeds the audio-thread PRNG so the stream starts cleanly, and arms a one-time wake burst so
    // a *cold* endpoint (auto-muted while the app was closed, or freshly (re)connected) is roused
    // before the user ever presses play. JUCE serialises prepareToPlay against the IO callback (the
    // stream is stopped across a device/SR restart), so the audio-thread-only burst counters are
    // safe to set here.
    void prepare(double sampleRate) noexcept
    {
        rngState = kRngSeed;
        wakeBurstSamples =
            sampleRate > 0.0 ? static_cast<int>(sampleRate * (kWakeBurstMs / 1000.0)) : 0;
        wakeBurstRemaining = wakeBurstSamples;
    }

    // Re-arm the decaying wake burst from full. Called at the start of each play on a sleep-prone
    // endpoint (via MasterClockSource's audio-thread pre-roll) so the amp is roused before the
    // downbeat even if it relaxed back to mute since the last play. Audio-thread only.
    void armWakeBurst() noexcept { wakeBurstRemaining = wakeBurstSamples; }

    // Audio thread: add the keep-alive signal on otherwise-silent blocks while the gate is open. A
    // decaying wake burst rouses a cold amp on the first blocks after a device (re)start, falling to
    // the continuous, inaudible holding dither. The signal is per-channel, zero-mean (DC-free), and
    // non-zero every sample so it defeats both energy- and zero-run-based auto-mute detectors.
    // Returns true if anything was written this block. No fade on stop — stopping writes nothing.
    bool maybeApplyFloor(juce::AudioBuffer<float>& buffer, int startSample, int numSamples,
                         float programPeak) noexcept
    {
        const bool active = shouldRun() && programPeak <= silverdaw::kKeepAliveSilenceThreshold;
        if (! active || numSamples <= 0)
            return false;

        constexpr int kMaxChannels = 32;
        const int numChannels = juce::jmin(buffer.getNumChannels(), kMaxChannels);
        if (numChannels <= 0)
            return false;

        // Snapshot the burst countdown so every channel decays identically; advance it once per
        // sample-frame after all channels are written.
        const int startRemaining = wakeBurstRemaining;
        for (int ch = 0; ch < numChannels; ++ch)
        {
            float* dest = buffer.getWritePointer(ch, startSample);
            int rem = startRemaining;
            for (int i = 0; i < numSamples; ++i)
            {
                dest[i] += nextTpdf() * wakeAmplitude(rem);
                if (rem > 0)
                    --rem;
            }
        }
        wakeBurstRemaining = juce::jmax(0, startRemaining - numSamples);
        return true;
    }

  private:
    // Per-sample amplitude: linearly decays from the wake-burst peak (at the start of a device
    // session) down to the holding dither over kWakeBurstMs, then stays at the dither floor.
    float wakeAmplitude(int remaining) const noexcept
    {
        if (remaining <= 0 || wakeBurstSamples <= 0)
            return silverdaw::kKeepAliveDitherPeak;
        const float fraction = static_cast<float>(remaining) / static_cast<float>(wakeBurstSamples);
        return silverdaw::kKeepAliveDitherPeak +
               (silverdaw::kWakeBurstPeak - silverdaw::kKeepAliveDitherPeak) * fraction;
    }

    // xorshift32 — fast, audio-thread-local PRNG (no allocation, lock, or syscall).
    float nextUniform() noexcept
    {
        std::uint32_t x = rngState;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        rngState = x;
        return static_cast<float>(x) * (1.0F / 4294967296.0F); // [0, 1)
    }

    // TPDF (triangular) noise in (-1, 1), zero mean — the difference of two uniforms. Scaled by the
    // caller to the holding-dither or wake-burst amplitude.
    float nextTpdf() noexcept { return nextUniform() - nextUniform(); }

    static constexpr std::uint32_t kRngSeed = 0x9E3779B9u;

    std::atomic<bool> playing{false};
    std::atomic<bool> contentLoaded{false};
    std::atomic<bool> deviceActive{false};
    // Off by default; the renderer pushes the open device's explicit per-device toggle.
    std::atomic<bool> keepAwakeEnabled{false};
    // PRNG state — audio-thread only. prepare() runs from prepareToPlay during a device/sample-rate
    // (re)start, which JUCE serialises against the IO callback (the stream is stopped across the
    // restart), so this is never touched concurrently.
    std::uint32_t rngState{kRngSeed};
    // One-time wake-burst counters — audio-thread only, set by prepare() during a serialised
    // device/SR restart (see prepare()). wakeBurstSamples is the armed length; wakeBurstRemaining
    // counts down to zero as the burst decays into the holding dither.
    int wakeBurstSamples{0};
    int wakeBurstRemaining{0};
};

} // namespace silverdaw