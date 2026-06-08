#pragma once

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
        const auto count = callbackCount.fetch_add(1, std::memory_order_relaxed) + 1;
        if (! keepAlive.isPlaying())
        {
            // Keep-alive only wakes sleep-prone endpoints; idle output remains true digital
            // silence.
            info.clearActiveBufferRegion();
            maybeLogAudioPerf(count, startTicks, info.numSamples);
            return;
        }

        child.getNextAudioBlock(info);
        positionSamples.fetch_add(static_cast<juce::int64>(info.numSamples), std::memory_order_relaxed);
        maybeLogAudioPerf(count, startTicks, info.numSamples);
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

  private:
    void maybeLogAudioPerf(std::uint64_t count, juce::int64 startTicks, int numSamples) const
    {
        if ((count % 100) != 0) return;
        const auto elapsedTicks = juce::Time::getHighResolutionTicks() - startTicks;
        const double elapsedMs = juce::Time::highResolutionTicksToSeconds(elapsedTicks) * 1000.0;
        const double sr = sampleRate.load(std::memory_order_acquire);
        const double budgetMs = sr > 0.0 && numSamples > 0 ? (static_cast<double>(numSamples) * 1000.0) / sr : 0.0;
        const double pct = budgetMs > 0.0 ? (elapsedMs / budgetMs) * 100.0 : 0.0;
        silverdaw::log::debug("perf.audio",
                              "cb#" + juce::String(static_cast<juce::int64>(count)) +
                                  " playing=" + juce::String(keepAlive.isPlaying() ? 1 : 0) +
                                  " pos=" + juce::String(positionSamples.load(std::memory_order_relaxed)) +
                                  " elapsedMs=" + juce::String(elapsedMs, 3) +
                                  " budgetMs=" + juce::String(budgetMs, 3) +
                                  " budgetPct=" + juce::String(pct, 1));
    }

    juce::AudioSource& child;
    OutputKeepAlive& keepAlive;
    std::atomic<juce::int64> positionSamples{0};
    std::atomic<double> sampleRate{0.0};
    std::atomic<std::uint64_t> callbackCount{0};

    static_assert(std::atomic<juce::int64>::is_always_lock_free,
                  "MasterClockSource requires a lock-free 64-bit atomic counter on the audio thread");
};

} // namespace silverdaw
