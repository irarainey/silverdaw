#include "Track.h"

//==============================================================================
Track::Track (juce::AudioFormatManager& fm, juce::AudioThumbnailCache& cache)
    : formatManager (fm),
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

    auto newReaderSource = std::make_unique<juce::AudioFormatReaderSource> (reader, true);
    auto newResampler    = std::make_unique<juce::ResamplingAudioSource> (newReaderSource.get(),
                                                                          false,
                                                                          (int) reader->numChannels);

    // If the audio device has already been prepared, prepare the new chain
    // *before* swapping it into place. That avoids glitches.
    if (deviceSampleRate > 0.0)
    {
        newResampler->setResamplingRatio (newFileSampleRate / deviceSampleRate);
        newResampler->prepareToPlay (currentBlockSize, deviceSampleRate);
    }

    {
        const juce::ScopedLock sl (sourceLock);
        readerSource     = std::move (newReaderSource);
        resampler        = std::move (newResampler);
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

    if (resampler != nullptr)
    {
        if (fileSampleRate > 0.0)
            resampler->setResamplingRatio (fileSampleRate / sampleRate);
        resampler->prepareToPlay (samplesPerBlockExpected, sampleRate);
    }
}

void Track::releaseResources()
{
    const juce::ScopedLock sl (sourceLock);

    if (resampler    != nullptr) resampler->releaseResources();
    if (readerSource != nullptr) readerSource->releaseResources();
}

void Track::getNextAudioBlock (const juce::AudioSourceChannelInfo& info)
{
    const juce::ScopedLock sl (sourceLock);

    if (resampler == nullptr)
    {
        info.clearActiveBufferRegion();
        return;
    }

    resampler->getNextAudioBlock (info);
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
