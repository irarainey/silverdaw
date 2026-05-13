#include "TrackMixerSource.h"

//==============================================================================
TrackMixerSource::TrackMixerSource() = default;
TrackMixerSource::~TrackMixerSource() { releaseResources(); }

//==============================================================================
Track* TrackMixerSource::addTrack (std::unique_ptr<Track> track)
{
    jassert (track != nullptr);

    // Prepare the new track before publishing it to the audio thread.
    if (prepared)
        track->prepareToPlay (currentBlockSize, currentSampleRate);

    // Mixer will seek the track lazily on the next block render.

    auto* raw = track.get();
    {
        const juce::ScopedLock sl (tracksLock);
        tracks.push_back (std::move (track));
    }
    return raw;
}

void TrackMixerSource::removeTrack (int index)
{
    std::unique_ptr<Track> toDelete;

    {
        const juce::ScopedLock sl (tracksLock);
        if (! juce::isPositiveAndBelow (index, (int) tracks.size()))
            return;

        toDelete = std::move (tracks[(size_t) index]);
        tracks.erase (tracks.begin() + index);
    }
    // toDelete falls out of scope here, after the lock is released.
}

int TrackMixerSource::getNumTracks() const
{
    const juce::ScopedLock sl (tracksLock);
    return (int) tracks.size();
}

Track* TrackMixerSource::getTrack (int index) const
{
    const juce::ScopedLock sl (tracksLock);
    if (! juce::isPositiveAndBelow (index, (int) tracks.size()))
        return nullptr;
    return tracks[(size_t) index].get();
}

//==============================================================================
void TrackMixerSource::prepareToPlay (int samplesPerBlockExpected, double sampleRate)
{
    currentBlockSize  = samplesPerBlockExpected;
    currentSampleRate = sampleRate;
    prepared          = true;

    // Two output channels is what the main component asks for; tracks render
    // into a temp buffer sized to match before being summed into the output.
    tempBuffer.setSize (2, samplesPerBlockExpected, false, true, true);

    const juce::ScopedLock sl (tracksLock);
    for (auto& t : tracks)
        t->prepareToPlay (samplesPerBlockExpected, sampleRate);
}

void TrackMixerSource::releaseResources()
{
    prepared = false;

    const juce::ScopedLock sl (tracksLock);
    for (auto& t : tracks)
        t->releaseResources();

    tempBuffer.setSize (0, 0);
}

void TrackMixerSource::getNextAudioBlock (const juce::AudioSourceChannelInfo& info)
{
    info.clearActiveBufferRegion();

    const juce::ScopedLock sl (tracksLock);

    if (tracks.empty() || currentSampleRate <= 0.0)
    {
        currentPosition += info.numSamples;
        return;
    }

    const bool anySoloed = std::any_of (tracks.begin(), tracks.end(),
                                        [] (const auto& t) { return t->isSoloed(); });

    // Make sure the temp buffer is large enough.
    if (tempBuffer.getNumSamples() < info.numSamples
        || tempBuffer.getNumChannels() < info.buffer->getNumChannels())
    {
        tempBuffer.setSize (juce::jmax (2, info.buffer->getNumChannels()),
                            info.numSamples, false, true, true);
    }

    const juce::int64 blockStart = currentPosition;
    const juce::int64 blockEnd   = blockStart + info.numSamples;

    for (auto& track : tracks)
    {
        const juce::int64 trackStart = (juce::int64) (track->getStartOffsetSeconds()
                                                      * currentSampleRate);
        const juce::int64 trackLen   = track->getTotalLength();
        if (trackLen <= 0)
            continue;

        const juce::int64 trackEnd = trackStart + trackLen;

        // Intersection of [blockStart, blockEnd) with [trackStart, trackEnd).
        const juce::int64 overlapStart = juce::jmax (blockStart, trackStart);
        const juce::int64 overlapEnd   = juce::jmin (blockEnd,   trackEnd);

        if (overlapStart >= overlapEnd)
            continue; // no audible samples from this track in this block

        const int destOffset      = (int) (overlapStart - blockStart);
        const int numSamplesToRead = (int) (overlapEnd - overlapStart);
        const juce::int64 trackLocalPos = overlapStart - trackStart;

        // Seek the track if its internal cursor doesn't already match.
        if (track->getNextReadPosition() != trackLocalPos)
            track->setNextReadPosition (trackLocalPos);

        // Render into the temp buffer at offset 0 for clean addressing.
        tempBuffer.clear (0, numSamplesToRead);
        juce::AudioSourceChannelInfo tempInfo;
        tempInfo.buffer      = &tempBuffer;
        tempInfo.startSample = 0;
        tempInfo.numSamples  = numSamplesToRead;
        track->getNextAudioBlock (tempInfo);

        const bool shouldOutput = ! track->isMuted()
                                  && (! anySoloed || track->isSoloed());
        if (! shouldOutput)
            continue;

        const float trackGain = track->getGain();
        const int   numOutCh  = info.buffer->getNumChannels();
        const int   numTempCh = tempBuffer.getNumChannels();

        for (int ch = 0; ch < numOutCh; ++ch)
        {
            const int srcCh = juce::jmin (ch, numTempCh - 1);
            info.buffer->addFrom (ch, info.startSample + destOffset,
                                  tempBuffer, srcCh, 0,
                                  numSamplesToRead, trackGain);
        }
    }

    currentPosition += info.numSamples;
}

//==============================================================================
void TrackMixerSource::setNextReadPosition (juce::int64 newPosition)
{
    currentPosition = newPosition;

    // Per-track seek positions are computed lazily in getNextAudioBlock based
    // on each track's offset, so there's nothing more to do here.
}

juce::int64 TrackMixerSource::getNextReadPosition() const
{
    return currentPosition;
}

juce::int64 TrackMixerSource::getTotalLength() const
{
    if (currentSampleRate <= 0.0)
        return 0;

    juce::int64 maxEnd = 0;

    const juce::ScopedLock sl (tracksLock);
    for (auto& t : tracks)
    {
        const juce::int64 offsetSamples = (juce::int64) (t->getStartOffsetSeconds()
                                                         * currentSampleRate);
        maxEnd = juce::jmax (maxEnd, offsetSamples + t->getTotalLength());
    }

    return maxEnd;
}
