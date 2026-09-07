#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_utils/juce_audio_utils.h>

#include <atomic>
#include <vector>

namespace silverdaw::recording
{

/** Most bursts one calibration run will emit. Fixed so the audio thread never grows a buffer. */
inline constexpr int kMaxCalibrationClicks = 16;

/**
 * Emits the short bursts a latency calibration listens for, and stamps when each one was
 * handed to the output device (ADR 0030).
 *
 * The stamp is the whole point. Round trip is measured as the wall-clock gap between a burst
 * being written into the output buffer and its echo arriving in the capture stream, so it has
 * to be taken at the same reference point the arrangement's own audio is generated from —
 * anything else measures a different path from the one a performer plays against.
 *
 * Audio-thread rules: no allocation, no logging, no locks. Every buffer is sized in
 * prepareToPlay and every stamp lands in a fixed array of atomics.
 */
class CalibrationClickSource final : public juce::AudioSource
{
  public:
    void prepareToPlay(int /*samplesPerBlockExpected*/, double newSampleRate) override
    {
        sampleRate = newSampleRate > 0.0 ? newSampleRate : 48000.0;
        buildBurst();
        cancel();
    }

    void releaseResources() override {}

    /** Arms `count` bursts, the first one after `spacingSamples`, on the audio thread's next
     *  block. Safe to call while stopped only; a run in flight must be cancelled first. */
    void start(int count, double spacingMs, float amplitude) noexcept
    {
        const auto clamped = juce::jlimit(1, kMaxCalibrationClicks, count);
        emitted.store(0, std::memory_order_release);
        burstGain.store(juce::jlimit(0.0F, 1.0F, amplitude), std::memory_order_relaxed);
        spacingSamples = juce::jmax(1, static_cast<int>(sampleRate * spacingMs / 1000.0));
        countdown = spacingSamples;
        burstPosition = -1;
        remaining.store(clamped, std::memory_order_release);
        running.store(true, std::memory_order_release);
    }

    void cancel() noexcept
    {
        running.store(false, std::memory_order_release);
        remaining.store(0, std::memory_order_release);
        burstPosition = -1;
    }

    /** True once every armed burst has been written out. */
    bool isFinished() const noexcept
    {
        return ! running.load(std::memory_order_acquire) && remaining.load(std::memory_order_acquire) == 0;
    }

    int getEmittedCount() const noexcept { return emitted.load(std::memory_order_acquire); }

    /** High-resolution tick at which burst `index` entered the output buffer. Only meaningful
     *  for indices below `getEmittedCount()`. */
    juce::int64 getEmitTick(int index) const noexcept
    {
        if (index < 0 || index >= kMaxCalibrationClicks) return 0;
        return emitTicks[static_cast<size_t>(index)].load(std::memory_order_acquire);
    }

    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override
    {
        info.clearActiveBufferRegion();
        if (! running.load(std::memory_order_acquire) || info.numSamples <= 0) return;

        const auto blockTicks = juce::Time::getHighResolutionTicks();
        const auto ticksPerSecond = static_cast<double>(juce::Time::getHighResolutionTicksPerSecond());
        const float gain = burstGain.load(std::memory_order_relaxed);
        const auto burstLength = static_cast<int>(burst.size());

        for (int i = 0; i < info.numSamples; ++i)
        {
            if (burstPosition < 0 && remaining.load(std::memory_order_acquire) > 0 && --countdown <= 0)
            {
                const int index = emitted.load(std::memory_order_acquire);
                if (index < kMaxCalibrationClicks)
                {
                    // Offset within the block matters: at 480 samples a burst landing late in the
                    // buffer is 10 ms adrift of the block stamp, which is the size of the error
                    // the whole measurement exists to resolve.
                    const auto offsetTicks =
                        static_cast<juce::int64>(ticksPerSecond * static_cast<double>(i) / sampleRate);
                    emitTicks[static_cast<size_t>(index)].store(blockTicks + offsetTicks,
                                                                std::memory_order_release);
                    emitted.store(index + 1, std::memory_order_release);
                }
                burstPosition = 0;
                countdown = spacingSamples;
                remaining.fetch_sub(1, std::memory_order_acq_rel);
            }

            if (burstPosition >= 0 && burstPosition < burstLength)
            {
                const float value = burst[static_cast<size_t>(burstPosition)] * gain;
                for (int ch = 0; ch < info.buffer->getNumChannels(); ++ch)
                    info.buffer->addSample(ch, info.startSample + i, value);
                ++burstPosition;
                if (burstPosition >= burstLength) burstPosition = -1;
            }
        }

        if (remaining.load(std::memory_order_acquire) == 0 && burstPosition < 0)
            running.store(false, std::memory_order_release);
    }

  private:
    /** A short tone rather than a single impulse: a speaker cannot reproduce an impulse, and a
     *  tone survives the room and the microphone.
     *
     *  The envelope is a fast attack, a flat sustain and a short release, not a window over the
     *  whole burst. A windowed burst's energy is concentrated in its middle, so making one long
     *  enough to hear clearly would also make its rise long enough to blunt the onset — and the
     *  onset is what the round trip is timed from. Separating the two lets the burst be loud and
     *  long while its leading edge stays sharp. */
    void buildBurst()
    {
        const auto length = juce::jmax(1, static_cast<int>(sampleRate * kBurstMs / 1000.0));
        const auto attack = juce::jmax(1, static_cast<int>(sampleRate * kBurstAttackMs / 1000.0));
        const auto release = juce::jmax(1, static_cast<int>(sampleRate * kBurstReleaseMs / 1000.0));
        burst.assign(static_cast<size_t>(length), 0.0F);
        for (int i = 0; i < length; ++i)
        {
            const double phase = juce::MathConstants<double>::twoPi * kBurstHz
                                 * static_cast<double>(i) / sampleRate;
            double envelope = 1.0;
            if (i < attack)
            {
                envelope = 0.5
                           - 0.5 * std::cos(juce::MathConstants<double>::pi * static_cast<double>(i)
                                            / static_cast<double>(attack));
            }
            else if (i >= length - release)
            {
                envelope = 0.5
                           - 0.5
                                 * std::cos(juce::MathConstants<double>::pi
                                            * static_cast<double>(length - i)
                                            / static_cast<double>(release));
            }
            burst[static_cast<size_t>(i)] = static_cast<float>(std::sin(phase) * envelope);
        }
    }

    /** Long enough to read as a beep rather than a tick, and far shorter than the gap between
     *  bursts so two can never run together. */
    static constexpr double kBurstMs = 40.0;
    static constexpr double kBurstAttackMs = 1.5;
    static constexpr double kBurstReleaseMs = 8.0;
    /** Where hearing is most sensitive, so it carries at a given level, and above the speech
     *  band most microphone echo cancellers work hardest on. */
    static constexpr double kBurstHz = 3000.0;

    double sampleRate{48000.0};
    std::vector<float> burst;
    int spacingSamples{1};
    int countdown{0};
    int burstPosition{-1};
    std::atomic<bool> running{false};
    std::atomic<int> remaining{0};
    std::atomic<int> emitted{0};
    std::atomic<float> burstGain{0.5F};
    std::array<std::atomic<juce::int64>, kMaxCalibrationClicks> emitTicks{};
};

} // namespace silverdaw::recording
