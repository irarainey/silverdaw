#include "InputMonitorSource.h"

namespace silverdaw::recording
{
namespace
{
// Long enough to absorb one device block from each side plus the difference
// between them, short enough that the performer does not hear themselves late.
constexpr double kRingSeconds = 0.25;
// The backlog the consumer will tolerate before dropping down to the freshest block.
// Comfortably above one capture period plus one output period on any driver Silverdaw
// will open — DirectSound's 53 ms is the slowest — so ordinary jitter never trips it,
// while drift can never accumulate into audible monitoring delay.
constexpr double kMaxBacklogSeconds = 0.12;
} // namespace

void InputMonitorSource::prepareToPlay(int /*samplesPerBlockExpected*/, double outputSampleRate)
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

    // Write only what fits. Making room here by advancing the read pointer would be the
    // obvious way to prefer the newest audio, and it is exactly what a single-producer,
    // single-consumer FIFO forbids: `AbstractFifo::finishedRead` is a non-atomic
    // read-modify-write of the read index, so a producer calling it races the playback
    // thread doing the same and corrupts the ring for both. Staleness is bounded by the
    // consumer instead, which owns that index.
    int start1 = 0, size1 = 0, start2 = 0, size2 = 0;
    fifo.prepareToWrite(numSamples, start1, size1, start2, size2);
    if (size1 + size2 < numSamples) glitches.fetch_add(1, std::memory_order_relaxed);
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

    // Bound the backlog here, on the only thread allowed to move the read pointer. Two
    // free-running clocks drift apart, and a capture device that is even slightly fast
    // would otherwise fill the ring and leave the performer hearing themselves a quarter
    // of a second late — far worse than the momentary skip that dropping the stale audio
    // costs. The cap clears any sane pairing of device periods, so it only ever fires on
    // real accumulation rather than on normal jitter.
    const int backlogCap =
        juce::jmax(wanted * 2, static_cast<int>(sampleRate * kMaxBacklogSeconds));
    if (fifo.getNumReady() > backlogCap)
    {
        int stale1 = 0, staleSize1 = 0, stale2 = 0, staleSize2 = 0;
        fifo.prepareToRead(fifo.getNumReady() - wanted, stale1, staleSize1, stale2, staleSize2);
        fifo.finishedRead(staleSize1 + staleSize2);
        glitches.fetch_add(1, std::memory_order_relaxed);
    }

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
