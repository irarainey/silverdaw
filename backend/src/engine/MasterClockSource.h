#pragma once

#include "AudioConstants.h"
#include "Leveler.h"
#include "Log.h"
#include "OutputKeepAlive.h"

#include <atomic>
#include <cstdint>
#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

class MasterClockSource : public juce::AudioSource
{
  public:
    MasterClockSource(juce::AudioSource& child, OutputKeepAlive& keepAlive)
        : child(child), keepAlive(keepAlive) {}

    void prepareToPlay(int blockSize, double newSampleRate) override
    {
        const double oldSr = sampleRate.load(std::memory_order_acquire);
        if (oldSr > 0.0 && newSampleRate > 0.0 && oldSr != newSampleRate)
        {
            const juce::int64 oldPos = positionSamples.load(std::memory_order_relaxed);
            const auto rescaled = static_cast<juce::int64>(
                (static_cast<double>(oldPos) * newSampleRate) / oldSr);
            positionSamples.store(rescaled, std::memory_order_relaxed);
        }
        sampleRate.store(newSampleRate, std::memory_order_release);
        prerollSamples =
            newSampleRate > 0.0 ? static_cast<int>(newSampleRate * (silverdaw::kWakePrerollMs / 1000.0)) : 0;
        silverdaw::log::info("master",
                             "prepareToPlay block=" + juce::String(blockSize) + " sr=" + juce::String(newSampleRate));
        child.prepareToPlay(blockSize, newSampleRate);
        mixGlue.prepare(newSampleRate, 2);
        monitorTrim.reset(newSampleRate, 0.01);
        monitorTrim.setCurrentAndTargetValue(monitorTrimTarget.load(std::memory_order_acquire));
    }

    void releaseResources() override
    {
        silverdaw::log::info("master", "releaseResources");
        mixGlue.reset();
        child.releaseResources();
    }

    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override;

    void setPlaying(bool p) noexcept
    {
        // Arm the one-time wake pre-roll on a stopped->playing transition only (idempotent restarts
        // must not re-trigger it mid-playback).
        const bool wasPlaying = keepAlive.isPlaying();
        if (p && ! wasPlaying)
        {
            // Cleared and re-stamped BEFORE the play is published, so the audio thread
            // cannot see `playing` and fail its stamp against the previous play's value
            // only for the clear to land immediately after — that would cost a whole
            // block of accuracy. The epoch closes the remaining hole: a callback from a
            // previous play still in flight across a fast stop/restart carries the old
            // epoch and is refused.
            transportStartTicks.store(0, std::memory_order_relaxed);
            playEpoch.fetch_add(1, std::memory_order_relaxed);
            playStartPending.store(true, std::memory_order_relaxed);
            if (outputFadeOutComplete.load(std::memory_order_acquire))
                transportGainTarget.store(1.0F, std::memory_order_relaxed);
        }
        // Publishes the play; everything above happens-before the audio thread sees it.
        keepAlive.setPlaying(p);
    }

    /** Monotonic counter identifying the current play. A recording captures it at start
     *  and refuses a start stamp that belongs to any other play. */
    std::uint32_t getPlayEpoch() const noexcept
    {
        return playEpoch.load(std::memory_order_acquire);
    }

    /**
     * High-resolution tick stamp of the first block this play actually advanced
     * the transport on, or 0 if it has not started rolling yet.
     *
     * `play()` is not instantaneous: it primes read-ahead buffers and the plugin
     * pipeline on the message thread and may then sit through a silent wake pre-roll
     * on the audio thread, none of which moves the playhead. A recording that started
     * capturing when `play()` was *called* is therefore already running by the time the
     * arrangement is audible, and the take lands late by that much. Stamping the real
     * start lets the capture measure the gap instead of assuming it is zero.
     *
     * `outEpoch` receives the play the stamp belongs to, so a caller can reject a
     * stamp from a play other than its own.
     */
    juce::int64 getTransportStartTicks(std::uint32_t* outEpoch = nullptr) const noexcept
    {
        const auto ticks = transportStartTicks.load(std::memory_order_acquire);
        if (outEpoch != nullptr) *outEpoch = playEpoch.load(std::memory_order_acquire);
        return ticks;
    }

    void requestOutputFadeOut() noexcept
    {
        transportGainTarget.store(0.0F, std::memory_order_release);
    }

    bool isOutputFadeOutComplete() const noexcept
    {
        return outputFadeOutComplete.load(std::memory_order_acquire);
    }

    void requestOutputFadeIn() noexcept
    {
        transportGainTarget.store(1.0F, std::memory_order_release);
    }

    void cancelOutputFade() noexcept
    {
        transportGainTarget.store(1.0F, std::memory_order_release);
        outputFadeOutComplete.store(false, std::memory_order_release);
    }

    void requestScrub(int direction, int samples) noexcept
    {
        scrubDirection.store(direction < 0 ? -1 : 1, std::memory_order_relaxed);
        scrubRequestedSamples.store(juce::jmax(0, samples), std::memory_order_relaxed);
        scrubGeneration.fetch_add(1, std::memory_order_release);
    }

    void cancelScrub() noexcept
    {
        scrubRequestedSamples.store(0, std::memory_order_relaxed);
        scrubGeneration.fetch_add(1, std::memory_order_release);
    }
    bool isPlaying() const noexcept
    {
        return keepAlive.isPlaying();
    }

    void setContentLoaded(bool loaded) noexcept
    {
        keepAlive.setContentLoaded(loaded);
    }
    bool isContentLoaded() const noexcept
    {
        return keepAlive.isContentLoaded();
    }

    void setMixGlueAmount(float amount, bool snap) noexcept
    {
        mixGlue.setParams(amount, snap);
    }

    /** Monitor-only trim on the arrangement, 0..1. A recording session borrows it
     *  to set how loud the backing sits under the performer; it is never
     *  persisted, never part of the mix, and never reaches a bounce. It sits here
     *  rather than on the master gain deliberately: the click and the preview
     *  voice are mixed downstream of this source, so trimming the backing leaves
     *  the count-in and the review audition of the take at full level. */
    void setMonitorTrim(float gain) noexcept
    {
        monitorTrimTarget.store(juce::jlimit(0.0F, 1.0F, gain), std::memory_order_release);
    }

    void setPositionSamples(juce::int64 p) noexcept
    {
        positionSamples.store(juce::jmax(static_cast<juce::int64>(0), p), std::memory_order_relaxed);
    }
    juce::int64 getPositionSamples() const noexcept
    {
        return positionSamples.load(std::memory_order_relaxed);
    }

    /** The block-start transport counter, for the audio thread to read directly
     *  (e.g. per-track automation sampling in BusGraph). Increments after the
     *  child renders, so the child sees the block-start position. */
    const std::atomic<juce::int64>& positionAtomicRef() const noexcept { return positionSamples; }

    /** The active device rate, for observers that read it on the audio thread. */
    const std::atomic<double>& sampleRateAtomicRef() const noexcept { return sampleRate; }

    double getSampleRate() const noexcept
    {
        return sampleRate.load(std::memory_order_acquire);
    }

    // Snapshot of the timing the audio thread publishes for non-RT logging.
    struct AudioPerfSnapshot
    {
        std::uint64_t callbackCount = 0;
        juce::int64 positionSamples = 0;
        double maxElapsedMs = 0.0;
        int numSamples = 0;
        double sampleRate = 0.0;
        bool playing = false;
    };

    // Message-thread read of the audio-thread callback counter, used by the device
    // watchdog. Unlike `drainAudioPerf` this consumes nothing.
    std::uint64_t getCallbackCount() const noexcept
    {
        return callbackCount.load(std::memory_order_relaxed);
    }

    // Message-thread drain of the audio-thread timing. Resets the worst-case
    // accumulator so each call reports the peak elapsed time since the last drain.
    AudioPerfSnapshot drainAudioPerf() noexcept
    {
        AudioPerfSnapshot s;
        s.callbackCount = callbackCount.load(std::memory_order_relaxed);
        s.positionSamples = positionSamples.load(std::memory_order_relaxed);
        s.maxElapsedMs = maxElapsedMs.exchange(0.0, std::memory_order_relaxed);
        s.numSamples = lastNumSamples.load(std::memory_order_relaxed);
        s.sampleRate = sampleRate.load(std::memory_order_acquire);
        s.playing = keepAlive.isPlaying();
        return s;
    }

  private:
    void applyTransportFade(juce::AudioBuffer<float>& buffer, int startSample,
                            int numSamples, float target) noexcept;
    void applyMonitorTrim(juce::AudioBuffer<float>& buffer, int startSample,
                          int numSamples) noexcept;

    // Audio-thread hot path: allocation/lock/IO free. Publishes raw block timing
    // to atomics for a non-RT timer to format and log; the real-time invariant
    // forbids building strings or touching the file logger here.
    void publishAudioPerf(juce::int64 startTicks, int numSamples) noexcept
    {
        const auto elapsedTicks = juce::Time::getHighResolutionTicks() - startTicks;
        const double elapsedMs = juce::Time::highResolutionTicksToSeconds(elapsedTicks) * 1000.0;
        lastNumSamples.store(numSamples, std::memory_order_relaxed);
        // Atomic max so the logger sees the worst-case block between drains.
        double cur = maxElapsedMs.load(std::memory_order_relaxed);
        while (elapsedMs > cur
               && ! maxElapsedMs.compare_exchange_weak(cur, elapsedMs, std::memory_order_relaxed))
        {
        }
    }

    juce::AudioSource& child;
    OutputKeepAlive& keepAlive;
    Leveler mixGlue{Leveler::kProjectMixGlueMaximumMakeupDb};
    std::atomic<juce::int64> positionSamples{0};
    std::atomic<double> sampleRate{0.0};
    std::atomic<std::uint64_t> callbackCount{0};
    // Set on a stopped->playing transition (message thread), consumed by the audio thread on the
    // first block of the play to arm the wake pre-roll.
    std::atomic<bool> playStartPending{false};
    // Wall-clock stamp of the first block this play advanced the transport on; 0 until then.
    // Written by the audio thread, read by the message thread when a take is finalised.
    std::atomic<juce::int64> transportStartTicks{0};
    // Bumped on every stopped->playing transition so a stamp can be tied to one play.
    std::atomic<std::uint32_t> playEpoch{0};
    // Wake pre-roll state — audio-thread only. prerollSamples is the armed length (set in
    // prepareToPlay for the active rate); wakePrerollRemaining counts down the current pre-roll.
    int prerollSamples{0};
    int wakePrerollRemaining{0};
    std::atomic<std::uint32_t> scrubGeneration{0};
    std::atomic<int> scrubRequestedSamples{0};
    std::atomic<int> scrubDirection{1};
    std::uint32_t activeScrubGeneration{0};
    int scrubRemaining{0};
    int scrubRendered{0};
    static constexpr int kScrubEdgeFadeSamples = 32;
    static constexpr int kTransportFadeSamples = 240;
    static constexpr float kTransportFadeStep = 1.0F / static_cast<float>(kTransportFadeSamples);
    std::atomic<float> transportGainTarget{1.0F};
    std::atomic<bool> outputFadeOutComplete{false};
    float transportGain = 1.0F;
    // Session-scoped arrangement trim; smoothed so a fader move cannot click.
    std::atomic<float> monitorTrimTarget{1.0F};
    juce::LinearSmoothedValue<float> monitorTrim{1.0F};
    bool holdOutputSilence{false};
    // Block timing published by the audio thread, drained by a non-RT timer.
    std::atomic<double> maxElapsedMs{0.0};
    std::atomic<int> lastNumSamples{0};

    static_assert(std::atomic<juce::int64>::is_always_lock_free,
                  "MasterClockSource requires a lock-free 64-bit atomic counter on the audio thread");
    static_assert(std::atomic<double>::is_always_lock_free,
                  "MasterClockSource publishes timing doubles lock-free on the audio thread");
    static_assert(std::atomic<float>::is_always_lock_free,
                  "MasterClockSource transport gain target must be lock-free on the audio thread");
};

} // namespace silverdaw
