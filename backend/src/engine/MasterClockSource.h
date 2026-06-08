#pragma once

#include "Log.h"
#include "OutputKeepAlive.h"

#include <atomic>
#include <cstdint>
#include <limits>
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
        silverdaw::log::info("master",
                             "prepareToPlay block=" + juce::String(blockSize) + " sr=" + juce::String(newSampleRate));
        child.prepareToPlay(blockSize, newSampleRate);
    }

    void releaseResources() override
    {
        silverdaw::log::info("master", "releaseResources");
        child.releaseResources();
    }

    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override
    {
        const juce::ScopedNoDenormals scopedNoDenormals;
        const auto startTicks = juce::Time::getHighResolutionTicks();
        callbackCount.fetch_add(1, std::memory_order_relaxed);
        if (! keepAlive.isPlaying())
        {
            // Keep-alive only wakes sleep-prone endpoints; idle output remains true digital
            // silence.
            info.clearActiveBufferRegion();
            publishAudioPerf(startTicks, info.numSamples);
            return;
        }

        child.getNextAudioBlock(info);
        positionSamples.fetch_add(static_cast<juce::int64>(info.numSamples), std::memory_order_relaxed);
        publishAudioPerf(startTicks, info.numSamples);
    }

    void setPlaying(bool p) noexcept
    {
        keepAlive.setPlaying(p);
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

    void setPositionSamples(juce::int64 p) noexcept
    {
        positionSamples.store(juce::jmax(static_cast<juce::int64>(0), p), std::memory_order_relaxed);
    }
    juce::int64 getPositionSamples() const noexcept
    {
        return positionSamples.load(std::memory_order_relaxed);
    }

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
    std::atomic<juce::int64> positionSamples{0};
    std::atomic<double> sampleRate{0.0};
    std::atomic<std::uint64_t> callbackCount{0};
    // Block timing published by the audio thread, drained by a non-RT timer.
    std::atomic<double> maxElapsedMs{0.0};
    std::atomic<int> lastNumSamples{0};

    static_assert(std::atomic<juce::int64>::is_always_lock_free,
                  "MasterClockSource requires a lock-free 64-bit atomic counter on the audio thread");
    static_assert(std::atomic<double>::is_always_lock_free,
                  "MasterClockSource publishes timing doubles lock-free on the audio thread");
};

} // namespace silverdaw
