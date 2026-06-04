#pragma once

#include "AudioConstants.h"

#include <atomic>
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

namespace silverdaw
{

/**
 * Real-time-safe output "keep-alive" subsystem and the single source of truth
 * for the transport-gating flags it depends on.
 *
 * The output device must never see a sustained run of digital silence while
 * audio is needed: some endpoints — notably USB-C headphone dongles and
 * USB-Audio-Class DACs — silence-detect and soft-mute during silence, then
 * apply a wake-up fade on the next audible block, swallowing the attack of the
 * first audio after the gap. To prevent that we inject a low TPDF dither floor
 * into output blocks that are otherwise (near-)silent.
 *
 * The floor is applied at the FINAL output stage, AFTER the master gain
 * (see `MeteringSource`), so a low project master volume can never attenuate it
 * below the level that keeps a sleep-prone endpoint awake.
 *
 * Gating — the floor runs only when output is genuinely needed:
 *   - while PLAYING, to fill leading silence before the first clip and any gap
 *     with no active clip;
 *   - during a short WAKE PRE-ROLL (`wakePreroll`) fired by the engine before a
 *     cold-start play, so the endpoint's wake-up fade is spent on the floor and
 *     not on the first musical attack.
 * While the app sits idle/paused it emits TRUE digital silence — there is no
 * continuous floor — so a loaded-but-stopped project makes no sound. The
 * per-block silence test (the caller passes the block's pre-floor content peak)
 * still ensures real audio is never coloured.
 *
 * State is written from the message thread and read on the audio thread via
 * atomics. The dither path is real-time safe: no allocation, no locking, no
 * exceptions, bounded work.
 */
class OutputKeepAlive
{
  public:
    // --- Transport state (single source of truth) ---

    void setPlaying(bool p) noexcept { playing.store(p, std::memory_order_release); }
    bool isPlaying() const noexcept { return playing.load(std::memory_order_acquire); }

    /** Arm/disarm the wake pre-roll: while set, the floor runs even though the
     *  transport gate is still closed, so the engine can wake a cold endpoint
     *  before opening content. Driven by the message thread. */
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

    /** Whether the keep-alive floor should be emitted given transport state:
     *  while playing (fills gaps / leading silence) or during a wake pre-roll.
     *  Idle/paused output stays truly silent. The per-block silence test still
     *  gates on actual content so real audio is never coloured. */
    bool shouldRun() const noexcept
    {
        return playing.load(std::memory_order_acquire)
               || wakePreroll.load(std::memory_order_acquire);
    }

    /**
     * Inject the dither floor across [startSample, startSample + numSamples) of
     * every channel, but ONLY if the transport gate is open and `programPeak`
     * (the block's pre-floor content peak, measured on the program audio so a
     * low master volume can't make real content look silent) is at or below the
     * silence threshold. Returns true if the floor was injected.
     *
     * Real-time safe: no allocation, no locking, no exceptions, bounded work.
     */
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
    // Armed during the cold-start wake pre-roll: runs the floor with the
    // transport gate still closed so the endpoint wakes before content.
    std::atomic<bool> wakePreroll{false};
    std::atomic<bool> contentLoaded{false};
    // xorshift PRNG state for the dither. Touched only on the audio thread inside
    // maybeApplyFloor, so a plain (non-atomic) word is sufficient. Seeded to a
    // non-zero constant (xorshift requires a non-zero state).
    juce::uint32 rngState{0x9E3779B9u};
};

} // namespace silverdaw
