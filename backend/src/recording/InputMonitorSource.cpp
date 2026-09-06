#include "InputMonitorSource.h"

namespace silverdaw::recording
{
namespace
{
// Long enough to absorb one device block from each side plus the difference
// between them, short enough that the performer does not hear themselves late.
constexpr double kRingSeconds = 0.25;
} // namespace

void InputMonitorSource::prepareToPlay(int, double outputSampleRate)
{
    sampleRate = outputSampleRate > 0.0 ? outputSampleRate : 48000.0;
    const int capacity = juce::jmax(1024, static_cast<int>(sampleRate * kRingSeconds));
    ring.setSize(2, capacity, false, true, false);
    fifo.setTotalSize(capacity);
    clearRing();
}

void InputMonitorSource::releaseResources()
{
    clearRing();
}

void InputMonitorSource::clearRing() noexcept
{
    fifo.reset();
    ring.clear();
}

void InputMonitorSource::setEnabled(bool shouldMonitor) noexcept
{
    if (! shouldMonitor)
    {
        // Drop whatever is in flight, so re-arming does not play stale audio.
        enabled.store(false, std::memory_order_release);
        fifo.reset();
        return;
    }
    fifo.reset();
    enabled.store(true, std::memory_order_release);
}

void InputMonitorSource::push(const float* const* channels, int channelCount,
                              int numSamples) noexcept
{
    if (! enabled.load(std::memory_order_acquire) || channels == nullptr || channelCount <= 0
        || numSamples <= 0)
        return;

    // Make room rather than refuse the newest audio: a listener wants to hear
    // now, so an over-full ring is stale by definition.
    const int overflow = numSamples - fifo.getFreeSpace();
    if (overflow > 0)
    {
        int start1 = 0, size1 = 0, start2 = 0, size2 = 0;
        fifo.prepareToRead(juce::jmin(overflow, fifo.getNumReady()), start1, size1, start2, size2);
        fifo.finishedRead(size1 + size2);
        glitches.fetch_add(1, std::memory_order_relaxed);
    }

    int start1 = 0, size1 = 0, start2 = 0, size2 = 0;
    fifo.prepareToWrite(numSamples, start1, size1, start2, size2);
    for (int channel = 0; channel < ring.getNumChannels(); ++channel)
    {
        // A mono capture is monitored down both sides: the performer is listening,
        // not mixing, and a voice in one ear is worse than no width at all.
        const float* source = channels[juce::jmin(channel, channelCount - 1)];
        if (source == nullptr) continue;
        if (size1 > 0) ring.copyFrom(channel, start1, source, size1);
        if (size2 > 0) ring.copyFrom(channel, start2, source + size1, size2);
    }
    fifo.finishedWrite(size1 + size2);
}

void InputMonitorSource::getNextAudioBlock(const juce::AudioSourceChannelInfo& info)
{
    info.clearActiveBufferRegion();
    if (! enabled.load(std::memory_order_acquire) || info.buffer == nullptr || info.numSamples <= 0)
        return;

    const int wanted = info.numSamples;
    const int available = juce::jmin(wanted, fifo.getNumReady());
    if (available <= 0)
    {
        glitches.fetch_add(1, std::memory_order_relaxed);
        return;
    }

    int start1 = 0, size1 = 0, start2 = 0, size2 = 0;
    fifo.prepareToRead(available, start1, size1, start2, size2);
    const float level = gain.load(std::memory_order_relaxed);
    for (int channel = 0; channel < info.buffer->getNumChannels(); ++channel)
    {
        const int sourceChannel = juce::jmin(channel, ring.getNumChannels() - 1);
        if (size1 > 0)
            info.buffer->copyFrom(channel, info.startSample, ring, sourceChannel, start1, size1);
        if (size2 > 0)
            info.buffer->copyFrom(channel, info.startSample + size1, ring, sourceChannel, start2,
                                  size2);
        if (level != 1.0F)
            info.buffer->applyGain(channel, info.startSample, available, level);
    }
    fifo.finishedRead(size1 + size2);
}

} // namespace silverdaw::recording
