#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <atomic>

namespace silverdaw::recording
{

/**
 * Software monitoring for the record dialog (ADR 0030, Amendment 1).
 *
 * Capture and playback are deliberately different devices with different
 * clocks, so the performer's own signal cannot simply be summed on the capture
 * callback: it has to cross from the capture device's real-time thread to the
 * output device's. This source is that crossing — a fixed-size lock-free ring
 * written by `InputCaptureTap` and drained by the engine's mixer.
 *
 * Monitoring is best-effort by construction. Two clocks that never quite agree
 * will eventually over- or under-run, so the ring plays silence when it empties
 * and drops stale audio when it backs up, rather than stalling either thread or
 * trying to resample its way out. Both are momentary; neither can affect what is
 * captured, because the writer sees the same blocks whether monitoring is on or
 * not.
 *
 * The ring is strictly single-producer, single-consumer, which is what
 * `juce::AbstractFifo` guarantees and no more: the capture thread only ever
 * writes, and the read pointer is touched by the playback thread alone. Dropping
 * stale audio therefore happens on the consumer, even though it is the producer
 * that discovers the ring is full.
 *
 * Nothing here is ever recorded, bounced or written to disk: it exists purely
 * so the performer hears themselves over the backing.
 */
class InputMonitorSource final : public juce::AudioSource
{
  public:
    void prepareToPlay(int samplesPerBlockExpected, double outputSampleRate) override;
    void releaseResources() override;
    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override;

    /** Turn monitoring on or off. Turning it off empties the ring, so switching
     *  back on does not replay stale audio. Message thread only. */
    void setEnabled(bool shouldMonitor) noexcept;
    bool isEnabled() const noexcept { return enabled.load(std::memory_order_acquire); }

    /** Monitor level, 0..1. Separate from the capture gain: how loud a performer
     *  needs to hear themselves says nothing about the recording level. */
    void setGain(float newGain) noexcept
    {
        gain.store(juce::jlimit(0.0F, 2.0F, newGain), std::memory_order_relaxed);
    }

    /** Capture-thread push of the selected channels, after capture gain. Never
     *  blocks and never moves the read pointer: a full ring refuses what will not
     *  fit and the consumer bounds the backlog. */
    void push(const float* const* channels, int channelCount, int numSamples) noexcept;

    /** How many blocks were dropped or missing, for tests and diagnostics. */
    int getGlitchCount() const noexcept { return glitches.load(std::memory_order_relaxed); }

  private:
    void clearRing() noexcept;

    // Sized in prepareToPlay for the output rate; the ring is deliberately short,
    // because monitoring latency the performer can hear is worse than a glitch.
    juce::AudioBuffer<float> ring;
    juce::AbstractFifo fifo{1};
    std::atomic<bool> enabled{false};
    std::atomic<float> gain{1.0F};
    std::atomic<int> glitches{0};
    double sampleRate = 48000.0;

    static_assert(std::atomic<float>::is_always_lock_free,
                  "InputMonitorSource crosses two real-time threads and must be lock-free");
};

} // namespace silverdaw::recording
