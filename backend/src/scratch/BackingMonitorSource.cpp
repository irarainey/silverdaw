#include "BackingMonitorSource.h"

#include <thread>

namespace silverdaw::scratch
{

BackingMonitorSource::BackingMonitorSource() = default;

void BackingMonitorSource::waitForCallbackQuiescence() const noexcept
{
    // Spin-yield until no callback is in-flight.  Message/control thread only.
    while (callbackInFlight.load(std::memory_order_acquire) > 0)
        std::this_thread::yield();
}

std::int64_t BackingMonitorSource::sourceSampleForUs(std::int64_t us) const noexcept
{
    const auto sourceSamples = audio != nullptr ? audio->getNumSamples() : 0;
    const auto requested = static_cast<std::int64_t>(
        (static_cast<double>(juce::jmax<std::int64_t>(0, us)) * sourceSampleRate) / 1000000.0);
    if (sourceSamples <= 0)
        return 0;
    return juce::jlimit<std::int64_t>(0, sourceSamples, requested);
}

void BackingMonitorSource::activate(
    std::shared_ptr<const juce::AudioBuffer<float>> preparedAudio,
    double preparedSampleRate)
{
    active.store(false, std::memory_order_release);
    waitForCallbackQuiescence();
    audio = std::move(preparedAudio);
    sourceSampleRate = juce::jmax(1.0, preparedSampleRate);
    sourceSamplesPerOutputSample = sourceSampleRate / outputSampleRate;
    playPosition = 0.0;
    playing.store(false, std::memory_order_release);
    gain.store(1.0F, std::memory_order_release);
    endReached.store(false, std::memory_order_release);
    pendingSeekSourceSample.store(0, std::memory_order_release);
    publishedPosition.store(0.0, std::memory_order_release);
    seekGeneration.fetch_add(1, std::memory_order_acq_rel);
    appliedSeekGeneration = seekGeneration.load(std::memory_order_acquire);
    active.store(audio != nullptr && audio->getNumSamples() > 0,
                 std::memory_order_release);
}

void BackingMonitorSource::deactivate() noexcept
{
    active.store(false, std::memory_order_release);
    waitForCallbackQuiescence();
    playing.store(false, std::memory_order_release);
    endReached.store(false, std::memory_order_release);
    publishedPosition.store(0.0, std::memory_order_release);
}

void BackingMonitorSource::prepareToPlay(int samplesPerBlockExpected, double newOutputSampleRate)
{
    juce::ignoreUnused(samplesPerBlockExpected);
    outputSampleRate = juce::jmax(1.0, newOutputSampleRate);
    sourceSamplesPerOutputSample = sourceSampleRate / outputSampleRate;
}

void BackingMonitorSource::releaseResources()
{
}

void BackingMonitorSource::getNextAudioBlock(const juce::AudioSourceChannelInfo& info)
{
    if (info.buffer == nullptr || info.numSamples <= 0)
        return;

    callbackInFlight.fetch_add(1, std::memory_order_acq_rel);

    // Each mixer input overwrites its provided buffer; JUCE sums the results.
    info.clearActiveBufferRegion();

    if (!active.load(std::memory_order_acquire)
        || audio == nullptr || audio->getNumChannels() <= 0 || audio->getNumSamples() <= 0)
    {
        callbackInFlight.fetch_sub(1, std::memory_order_release);
        return;
    }

    const auto requestedGeneration = seekGeneration.load(std::memory_order_acquire);
    if (requestedGeneration != appliedSeekGeneration)
    {
        playPosition = static_cast<double>(
            pendingSeekSourceSample.load(std::memory_order_acquire));
        appliedSeekGeneration = requestedGeneration;
    }

    if (!playing.load(std::memory_order_acquire))
    {
        publishedPosition.store(playPosition, std::memory_order_release);
        callbackInFlight.fetch_sub(1, std::memory_order_release);
        return;
    }

    const int sourceSamples = audio->getNumSamples();
    const int sourceChannels = audio->getNumChannels();
    const int outChannels = info.buffer->getNumChannels();
    const float g = gain.load(std::memory_order_acquire);
    const double ratio = sourceSamplesPerOutputSample;
    const double lastIndex = static_cast<double>(sourceSamples - 1);

    double pos = playPosition;
    bool reachedEnd = false;
    for (int i = 0; i < info.numSamples; ++i)
    {
        if (pos >= lastIndex)
        {
            reachedEnd = true;
            break;
        }
        const int i0 = static_cast<int>(pos);
        const int i1 = juce::jmin(i0 + 1, sourceSamples - 1);
        const float frac = static_cast<float>(pos - static_cast<double>(i0));
        for (int ch = 0; ch < outChannels; ++ch)
        {
            const int srcCh = juce::jmin(ch, sourceChannels - 1);
            const float* src = audio->getReadPointer(srcCh);
            const float sample = src[i0] + frac * (src[i1] - src[i0]);
            info.buffer->setSample(ch, info.startSample + i, sample * g);
        }
        pos += ratio;
    }

    playPosition = pos;
    publishedPosition.store(pos, std::memory_order_release);
    if (reachedEnd)
    {
        playing.store(false, std::memory_order_release);
        endReached.store(true, std::memory_order_release);
    }

    callbackInFlight.fetch_sub(1, std::memory_order_release);
}

void BackingMonitorSource::setPlaying(bool shouldPlay) noexcept
{
    playing.store(shouldPlay, std::memory_order_release);
    if (shouldPlay)
        endReached.store(false, std::memory_order_release);
}

void BackingMonitorSource::setGain(float newGain) noexcept
{
    gain.store(juce::jlimit(0.0F, 1.0F, newGain), std::memory_order_release);
}

void BackingMonitorSource::seekUs(std::int64_t us) noexcept
{
    pendingSeekSourceSample.store(sourceSampleForUs(us), std::memory_order_release);
    publishedPosition.store(
        static_cast<double>(pendingSeekSourceSample.load(std::memory_order_acquire)),
        std::memory_order_release);
    endReached.store(false, std::memory_order_release);
    seekGeneration.fetch_add(1, std::memory_order_acq_rel);
}

bool BackingMonitorSource::consumeEndReached() noexcept
{
    return endReached.exchange(false, std::memory_order_acq_rel);
}

std::int64_t BackingMonitorSource::positionUs() const noexcept
{
    const auto position = publishedPosition.load(std::memory_order_acquire);
    return static_cast<std::int64_t>(juce::jmax(0.0, position) * 1000000.0 / sourceSampleRate);
}

std::int64_t BackingMonitorSource::durationUs() const noexcept
{
    const auto sourceSamples = audio != nullptr ? audio->getNumSamples() : 0;
    return static_cast<std::int64_t>(
        static_cast<double>(sourceSamples) * 1000000.0 / sourceSampleRate);
}

} // namespace silverdaw::scratch
