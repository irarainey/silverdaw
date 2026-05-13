#include "Track.h"

//==============================================================================
Track::Track (juce::AudioFormatManager& fm,
              juce::AudioThumbnailCache& cache,
              juce::TimeSliceThread&     thread)
    : formatManager (fm),
      readAheadThread (thread),
      thumbnail (512, fm, cache)
{
}

Track::~Track()
{
    releaseResources();
}

//==============================================================================
bool Track::loadFile (const juce::File& newFile)
{
    auto* reader = formatManager.createReaderFor (newFile);
    if (reader == nullptr)
        return false;

    const auto newFileSampleRate = reader->sampleRate;
    const int  numFileChannels   = (int) reader->numChannels;

    auto newReaderSource = std::make_unique<juce::AudioFormatReaderSource> (reader, true);

    // Roughly half a second of read-ahead at typical sample rates is enough
    // to hide file I/O and codec decode latency without bloating memory.
    constexpr int kBufferSamples = 32768;
    auto newBuffered = std::make_unique<juce::BufferingAudioSource> (
        newReaderSource.get(),
        readAheadThread,
        /*deleteSourceWhenDeleted*/ false,
        kBufferSamples,
        numFileChannels);

    auto newResampler = std::make_unique<juce::ResamplingAudioSource> (newBuffered.get(),
                                                                       false,
                                                                       numFileChannels);

    // If the audio device has already been prepared, prepare the new chain
    // *before* swapping it into place. That avoids glitches.
    if (deviceSampleRate > 0.0)
    {
        newReaderSource->prepareToPlay (currentBlockSize, deviceSampleRate);
        newBuffered->prepareToPlay     (currentBlockSize, deviceSampleRate);
        newResampler->setResamplingRatio (newFileSampleRate / deviceSampleRate);
        newResampler->prepareToPlay    (currentBlockSize, deviceSampleRate);
    }

    // Bypass the resampler entirely when rates match: ResamplingAudioSource
    // with ratio 1.0 still pays the full per-sample Lagrange interpolation
    // cost, which is significant across many tracks.
    const bool ratesMatch = deviceSampleRate > 0.0
                          && std::abs (newFileSampleRate - deviceSampleRate) < 0.5;
    juce::AudioSource* newActive = ratesMatch
        ? static_cast<juce::AudioSource*> (newBuffered.get())
        : static_cast<juce::AudioSource*> (newResampler.get());

    {
        const juce::ScopedLock sl (sourceLock);
        readerSource     = std::move (newReaderSource);
        bufferingSource  = std::move (newBuffered);
        resampler        = std::move (newResampler);
        activeSource     = newActive;
        fileSampleRate   = newFileSampleRate;
        currentDevicePos = 0;
    }

    thumbnail.setSource (new juce::FileInputSource (newFile));

    file = newFile;
    if (name.isEmpty())
        name = newFile.getFileNameWithoutExtension();

    return true;
}

//==============================================================================
void Track::prepareToPlay (int samplesPerBlockExpected, double sampleRate)
{
    deviceSampleRate = sampleRate;
    currentBlockSize = samplesPerBlockExpected;

    const juce::ScopedLock sl (sourceLock);

    if (readerSource != nullptr)
        readerSource->prepareToPlay (samplesPerBlockExpected, sampleRate);

    if (bufferingSource != nullptr)
        bufferingSource->prepareToPlay (samplesPerBlockExpected, sampleRate);

    if (resampler != nullptr)
    {
        if (fileSampleRate > 0.0)
            resampler->setResamplingRatio (fileSampleRate / sampleRate);
        resampler->prepareToPlay (samplesPerBlockExpected, sampleRate);
    }

    const bool ratesMatch = fileSampleRate > 0.0
                          && std::abs (fileSampleRate - sampleRate) < 0.5;
    activeSource = ratesMatch
        ? static_cast<juce::AudioSource*> (bufferingSource.get())
        : static_cast<juce::AudioSource*> (resampler.get());
}

void Track::releaseResources()
{
    const juce::ScopedLock sl (sourceLock);

    if (resampler       != nullptr) resampler->releaseResources();
    if (bufferingSource != nullptr) bufferingSource->releaseResources();
    if (readerSource    != nullptr) readerSource->releaseResources();
}

void Track::getNextAudioBlock (const juce::AudioSourceChannelInfo& info)
{
    // Try-lock: if the message thread is mid-swap in loadFile(), emit silence
    // for this block rather than blocking the audio thread on the OS.
    const juce::CriticalSection::ScopedTryLockType sl (sourceLock);

    if (! sl.isLocked() || activeSource == nullptr)
    {
        info.clearActiveBufferRegion();
        return;
    }

    activeSource->getNextAudioBlock (info);
    currentDevicePos += info.numSamples;
}

//==============================================================================
void Track::setNextReadPosition (juce::int64 newPosition)
{
    const juce::ScopedLock sl (sourceLock);

    currentDevicePos = newPosition;

    if (readerSource == nullptr || deviceSampleRate <= 0.0 || fileSampleRate <= 0.0)
        return;

    // Convert device-rate samples back to file-rate samples for the reader.
    const auto filePos = (juce::int64) ((double) newPosition * fileSampleRate / deviceSampleRate);
    readerSource->setNextReadPosition (filePos);

    // The buffering source caches blocks ahead of the read head; tell it the
    // stream has discontinued so it discards any prefetch from the old
    // position before the audio thread next pulls from it.
    if (bufferingSource != nullptr)
        bufferingSource->setNextReadPosition (filePos);

    // Reset the resampler so it doesn't carry filter state across the seek.
    if (resampler != nullptr)
        resampler->flushBuffers();
}

juce::int64 Track::getNextReadPosition() const
{
    return currentDevicePos;
}

juce::int64 Track::getTotalLength() const
{
    const juce::ScopedLock sl (sourceLock);

    if (readerSource == nullptr || deviceSampleRate <= 0.0 || fileSampleRate <= 0.0)
        return 0;

    return (juce::int64) ((double) readerSource->getTotalLength()
                          * deviceSampleRate / fileSampleRate);
}

double Track::getLengthInSeconds() const noexcept
{
    const juce::ScopedLock sl (sourceLock);

    if (readerSource == nullptr || fileSampleRate <= 0.0)
        return 0.0;

    return (double) readerSource->getTotalLength() / fileSampleRate;
}
