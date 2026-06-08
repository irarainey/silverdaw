#pragma once

#include "OutputKeepAlive.h"

#include <atomic>
#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

// Apply master gain before metering; inject keep-alive after gain so the endpoint floor is
// volume-independent.
class MeteringSource : public juce::AudioSource
{
  public:
    MeteringSource(juce::AudioSource& s, OutputKeepAlive& keepAlive) : source(s), keepAlive(keepAlive) {}

    void prepareToPlay(int samplesPerBlockExpected, double sampleRate) override
    {
        source.prepareToPlay(samplesPerBlockExpected, sampleRate);
        smoothedGain.reset(sampleRate, 0.01);
        smoothedGain.setCurrentAndTargetValue(targetGain.load(std::memory_order_relaxed));
    }

    void releaseResources() override { source.releaseResources(); }

    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override
    {
        // ScopedNoDenormals protects realtime DSP from denormal CPU spikes.
        const juce::ScopedNoDenormals scopedNoDenormals;
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
    juce::LinearSmoothedValue<float> smoothedGain;
    std::atomic<float> targetGain{1.0F};
    std::atomic<float> peakL_{0.0F};
    std::atomic<float> peakR_{0.0F};
};

} // namespace silverdaw
