#pragma once

#include "MasterClockSource.h"
#include "Metronome.h"
#include "OutputKeepAlive.h"
#include "SafetyLimiter.h"

#include <atomic>
#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

// Apply master gain before metering; inject keep-alive after gain so the endpoint floor is
// volume-independent. The metronome click is also mixed post-gain so the project master volume
// never silences the monitoring tick.
class MeteringSource : public juce::AudioSource
{
  public:
    MeteringSource(juce::AudioSource& s, OutputKeepAlive& keepAlive, MasterClockSource& clock,
                   Metronome& metronome)
        : source(s), keepAlive(keepAlive), clock(clock), metronome(metronome) {}

    void prepareToPlay(int samplesPerBlockExpected, double sampleRate) override
    {
        source.prepareToPlay(samplesPerBlockExpected, sampleRate);
        keepAlive.prepare(sampleRate);
        metronome.prepare(sampleRate);
        // The output device is now streaming: hold the endpoint awake from this first block so a
        // freshly-opened or reconnected DAC never sleeps before the user loads a project and plays.
        keepAlive.setDeviceActive(true);
        smoothedGain.reset(sampleRate, 0.01);
        smoothedGain.setCurrentAndTargetValue(targetGain.load(std::memory_order_relaxed));
        limiter.prepare(sampleRate);
    }

    void releaseResources() override
    {
        keepAlive.setDeviceActive(false);
        limiter.reset();
        source.releaseResources();
    }

    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override
    {
        // ScopedNoDenormals protects realtime DSP from denormal CPU spikes.
        const juce::ScopedNoDenormals scopedNoDenormals;
        // Capture the transport position BEFORE pulling the source: the clock advances inside the
        // pull, so this is the true start-of-block sample.
        const juce::int64 posBefore = clock.getPositionSamples();
        source.getNextAudioBlock(info);
        if (info.buffer == nullptr || info.numSamples <= 0)
            return;

        const int n = info.numSamples;
        const int numCh = info.buffer->getNumChannels();

        float programPeak = 0.0F;
        for (int ch = 0; ch < numCh; ++ch)
            programPeak = juce::jmax(programPeak, info.buffer->getMagnitude(ch, info.startSample, n));

        smoothedGain.setTargetValue(targetGain.load(std::memory_order_relaxed));
        const float startGain = smoothedGain.getNextValue();
        if (n > 1)
            smoothedGain.skip(n - 1);
        const float endGain = smoothedGain.getCurrentValue();

        const bool unity = std::abs(startGain - 1.0F) < 1.0e-6F &&
                           std::abs(endGain - 1.0F) < 1.0e-6F;
        if (! unity)
        {
            for (int ch = 0; ch < numCh; ++ch)
                info.buffer->applyGainRamp(ch, info.startSample, n, startGain, endGain);
        }

        // Mix the metronome click post master gain, only when the transport actually advanced this
        // block (real playback — not a stopped block or a wake pre-roll, where the position is
        // frozen). This keeps the click phase-aligned to the playhead and seek-correct.
        if (clock.getPositionSamples() == posBefore + static_cast<juce::int64>(n))
            metronome.render(*info.buffer, info.startSample, n, posBefore, clock.getSampleRate());

        limiter.process(*info.buffer, info.startSample, n);

        if (numCh > 0)
            atomicMaxFloat(peakL_, info.buffer->getMagnitude(0, info.startSample, n));
        if (numCh > 1)
            atomicMaxFloat(peakR_, info.buffer->getMagnitude(1, info.startSample, n));
        else if (numCh > 0)
            atomicMaxFloat(peakR_, info.buffer->getMagnitude(0, info.startSample, n));

        keepAlive.maybeApplyFloor(*info.buffer, info.startSample, n, programPeak);
    }

    void setTargetGain(float g) noexcept
    {
        targetGain.store(juce::jlimit(0.0F, 1.0F, g), std::memory_order_relaxed);
    }

    void setSafetyLimiterEnabled(bool enabled, bool snap) noexcept
    {
        limiter.setEnabled(enabled, snap);
    }

    void consumePeaks(float& outL, float& outR) noexcept
    {
        outL = peakL_.exchange(0.0F, std::memory_order_relaxed);
        outR = peakR_.exchange(0.0F, std::memory_order_relaxed);
    }

  private:
    static void atomicMaxFloat(std::atomic<float>& a, float v) noexcept
    {
        float cur = a.load(std::memory_order_relaxed);
        while (v > cur && ! a.compare_exchange_weak(cur, v, std::memory_order_relaxed))
        {
        }
    }

    juce::AudioSource& source;
    OutputKeepAlive& keepAlive;
    MasterClockSource& clock;
    Metronome& metronome;
    juce::LinearSmoothedValue<float> smoothedGain;
    SafetyLimiter limiter;
    std::atomic<float> targetGain{1.0F};
    std::atomic<float> peakL_{0.0F};
    std::atomic<float> peakR_{0.0F};
};

} // namespace silverdaw
