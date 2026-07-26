#include "MasterClockSource.h"

#include <algorithm>

namespace silverdaw
{

void MasterClockSource::getNextAudioBlock(const juce::AudioSourceChannelInfo& info)
{
    const juce::ScopedNoDenormals scopedNoDenormals;
    const auto startTicks = juce::Time::getHighResolutionTicks();
    callbackCount.fetch_add(1, std::memory_order_relaxed);
    const bool playing = keepAlive.isPlaying();
    const auto requestedGeneration = scrubGeneration.load(std::memory_order_acquire);
    if (requestedGeneration != activeScrubGeneration)
    {
        activeScrubGeneration = requestedGeneration;
        scrubRendered = scrubRemaining > 0 ? kScrubEdgeFadeSamples : 0;
        scrubRemaining = scrubRequestedSamples.load(std::memory_order_relaxed);
    }
    if (!playing && scrubRemaining <= 0)
    {
        wakePrerollRemaining = 0;
        info.clearActiveBufferRegion();
        publishAudioPerf(startTicks, info.numSamples);
        return;
    }

    if (!playing)
    {
        info.clearActiveBufferRegion();
        const int renderSamples = juce::jmin(info.numSamples, scrubRemaining);
        if (renderSamples <= 0)
        {
            publishAudioPerf(startTicks, info.numSamples);
            return;
        }

        juce::AudioSourceChannelInfo scrubInfo(info.buffer, info.startSample, renderSamples);
        child.getNextAudioBlock(scrubInfo);
        mixGlue.process(*info.buffer, info.startSample, renderSamples);
        if (scrubDirection.load(std::memory_order_relaxed) < 0)
        {
            for (int ch = 0; ch < info.buffer->getNumChannels(); ++ch)
            {
                auto* samples = info.buffer->getWritePointer(ch, info.startSample);
                std::reverse(samples, samples + renderSamples);
            }
        }

        for (int i = 0; i < renderSamples; ++i)
        {
            const float fadeIn = juce::jlimit(
                0.0F, 1.0F,
                static_cast<float>(scrubRendered + i + 1)
                    / static_cast<float>(kScrubEdgeFadeSamples));
            const float fadeOut = juce::jlimit(
                0.0F, 1.0F,
                static_cast<float>(scrubRemaining - i)
                    / static_cast<float>(kScrubEdgeFadeSamples));
            const float gain = juce::jmin(fadeIn, fadeOut);
            for (int ch = 0; ch < info.buffer->getNumChannels(); ++ch)
                info.buffer->getWritePointer(ch, info.startSample)[i] *= gain;
        }
        scrubRendered += renderSamples;
        scrubRemaining -= renderSamples;
        publishAudioPerf(startTicks, info.numSamples);
        return;
    }

    if (playStartPending.exchange(false, std::memory_order_acq_rel))
    {
        if (keepAlive.isKeepAwakeEnabled())
        {
            wakePrerollRemaining = prerollSamples;
            keepAlive.armWakeBurst();
        }
        else
        {
            wakePrerollRemaining = 0;
        }
    }

    if (wakePrerollRemaining > 0)
    {
        info.clearActiveBufferRegion();
        wakePrerollRemaining = juce::jmax(0, wakePrerollRemaining - info.numSamples);
        publishAudioPerf(startTicks, info.numSamples);
        return;
    }

    const float transportTarget = transportGainTarget.load(std::memory_order_acquire);
    if (holdOutputSilence && transportTarget > 0.0F)
    {
        holdOutputSilence = false;
        outputFadeOutComplete.store(false, std::memory_order_release);
    }
    if (holdOutputSilence && transportTarget == 0.0F)
    {
        info.clearActiveBufferRegion();
        publishAudioPerf(startTicks, info.numSamples);
        return;
    }

    child.getNextAudioBlock(info);
    mixGlue.process(*info.buffer, info.startSample, info.numSamples);
    applyTransportFade(*info.buffer, info.startSample, info.numSamples, transportTarget);

    positionSamples.fetch_add(static_cast<juce::int64>(info.numSamples), std::memory_order_relaxed);
    publishAudioPerf(startTicks, info.numSamples);
}

void MasterClockSource::applyTransportFade(juce::AudioBuffer<float>& buffer, int startSample,
                                           int numSamples, float target) noexcept
{
    const int channels = buffer.getNumChannels();
    for (int i = 0; i < numSamples; ++i)
    {
        transportGain += juce::jlimit(-kTransportFadeStep, kTransportFadeStep,
                                       target - transportGain);
        if (transportGain != 1.0F)
        {
            for (int ch = 0; ch < channels; ++ch)
                buffer.getWritePointer(ch, startSample)[i] *= transportGain;
        }
        if (target == 0.0F && transportGain == 0.0F)
        {
            holdOutputSilence = true;
            outputFadeOutComplete.store(true, std::memory_order_release);
            for (int ch = 0; ch < channels; ++ch)
                buffer.clear(ch, startSample + i + 1, numSamples - i - 1);
            break;
        }
    }
}

} // namespace silverdaw
