#include "AudioEngine.h"

#include <algorithm>
#include <iostream>

namespace jackdaw
{

AudioEngine::AudioEngine() = default;

AudioEngine::~AudioEngine()
{
    shutdown();
}

juce::String AudioEngine::initialise()
{
    // Register all built-in audio formats. On Windows this includes
    // WindowsMediaAudioFormat (gated by JUCE_USE_WINDOWS_MEDIA_FORMAT)
    // for MP3/M4A/WMA support via Media Foundation.
    formatManager.registerBasicFormats();

    // Background thread must be running before any track's read-ahead
    // buffer is created in addClip(), otherwise the buffer stays empty
    // and the audio thread only ever sees silence.
    readAheadThread.startThread();

    // Default: stereo output, 44.1/48 kHz, 512-sample buffer.
    const auto err = deviceManager.initialiseWithDefaultDevices(0, 2);

    if (err.isEmpty())
    {
        sourcePlayer.setSource(&mixer);
        deviceManager.addAudioCallback(&sourcePlayer);
    }

    return err;
}

void AudioEngine::shutdown()
{
    stop();
    deviceManager.removeAudioCallback(&sourcePlayer);
    sourcePlayer.setSource(nullptr);
    mixer.removeAllInputs();
    tracks.clear();
    deviceManager.closeAudioDevice();
    readAheadThread.stopThread(1000);
}

bool AudioEngine::addClip(const juce::String& trackId, const juce::File& filePath, juce::String* outError)
{
    if (!filePath.existsAsFile())
    {
        const auto msg = "file does not exist: " + filePath.getFullPathName();
        std::cerr << "[addClip] " << msg.toStdString() << '\n';
        if (outError != nullptr)
        {
            *outError = msg;
        }
        return false;
    }

    auto* reader = formatManager.createReaderFor(filePath);
    if (reader == nullptr)
    {
        // The File overload filters formats by extension. JUCE's WindowsMediaAudioFormat
        // only advertises .mp3/.wma/.wmv/.asf/.wm even though Media Foundation can also
        // decode .m4a/.mp4/.aac. Fall back to the stream overload, which lets every
        // registered format probe the bytes directly.
        if (auto stream = filePath.createInputStream())
        {
            reader = formatManager.createReaderFor(std::move(stream));
        }
    }
    if (reader == nullptr)
    {
        juce::StringArray formatNames;
        for (int i = 0; i < formatManager.getNumKnownFormats(); ++i)
        {
            auto* af = formatManager.getKnownFormat(i);
            formatNames.add(af != nullptr ? af->getFormatName() : juce::String("<null>"));
        }
        const auto msg = "createReaderFor returned null (ext=" + filePath.getFileExtension() +
                         ", size=" + juce::String(filePath.getSize()) + " bytes, registered=[" +
                         formatNames.joinIntoString(", ") + "])";
        std::cerr << "[addClip] " << msg.toStdString() << '\n';
        if (outError != nullptr)
        {
            *outError = msg;
        }
        return false;
    }

    auto track = std::make_unique<Track>();
    track->sampleRate = reader->sampleRate;
    track->numChannels = static_cast<int>(reader->numChannels);

    // `AudioFormatReaderSource` takes ownership of the reader (deleteWhenRemoved=true).
    track->readerSource = std::make_unique<juce::AudioFormatReaderSource>(reader, true);

    // OffsetSource sits between the reader and the transport so any timeline
    // offset is reflected in the audio the transport's read-ahead buffer
    // pulls; the transport itself still represents the global timeline.
    track->offsetSource = std::make_unique<OffsetSource>(track->readerSource.get());

    track->transportSource = std::make_unique<juce::AudioTransportSource>();
    track->transportSource->setSource(track->offsetSource.get(),
                                      32768,            // read-ahead buffer size in samples
                                      &readAheadThread, // background reader thread (required when buffer > 0)
                                      track->sampleRate, track->numChannels);

    // Replace any existing track with the same id.
    if (auto it = tracks.find(trackId); it != tracks.end())
    {
        mixer.removeInputSource(it->second->transportSource.get());
        tracks.erase(it);
    }

    mixer.addInputSource(track->transportSource.get(), false);
    tracks.emplace(trackId, std::move(track));

    return true;
}

bool AudioEngine::removeTrack(const juce::String& trackId)
{
    auto it = tracks.find(trackId);
    if (it == tracks.end())
    {
        return false;
    }

    // Remove from mixer first so the audio thread stops pulling samples,
    // then release the file reader by clearing the transport's source.
    mixer.removeInputSource(it->second->transportSource.get());
    it->second->transportSource->setSource(nullptr);
    tracks.erase(it);
    return true;
}

bool AudioEngine::setTrackGain(const juce::String& trackId, float gain)
{
    auto it = tracks.find(trackId);
    if (it == tracks.end())
    {
        return false;
    }

    if (it->second->transportSource != nullptr)
    {
        it->second->transportSource->setGain(juce::jlimit(0.0F, 4.0F, gain));
    }
    return true;
}

void AudioEngine::play()
{
    for (auto& [id, track] : tracks)
    {
        if (track->transportSource != nullptr)
        {
            track->transportSource->start();
        }
    }
}

void AudioEngine::pause()
{
    for (auto& [id, track] : tracks)
    {
        if (track->transportSource != nullptr)
        {
            track->transportSource->stop();
        }
    }
}

void AudioEngine::stop()
{
    for (auto& [id, track] : tracks)
    {
        if (track->transportSource != nullptr)
        {
            track->transportSource->stop();
            track->transportSource->setPosition(0.0);
        }
    }
}

void AudioEngine::setPositionMs(double ms)
{
    const double seconds = juce::jmax(0.0, ms / 1000.0);
    for (auto& [id, track] : tracks)
    {
        if (track->transportSource != nullptr)
        {
            track->transportSource->setPosition(seconds);
        }
    }
}

bool AudioEngine::setClipOffsetMs(const juce::String& trackId, double offsetMs)
{
    auto it = tracks.find(trackId);
    if (it == tracks.end())
    {
        return false;
    }

    auto& track = it->second;
    if (track->offsetSource == nullptr || track->transportSource == nullptr)
    {
        return false;
    }

    const double clampedMs = juce::jmax(0.0, offsetMs);
    const auto newOffsetSamples = static_cast<juce::int64>(clampedMs * track->sampleRate / 1000.0);
    track->offsetSource->setOffsetSamples(newOffsetSamples);

    // Fully rebuild the transport's source chain so the read-ahead
    // `BufferingAudioSource` is reconstructed from scratch and can't
    // serve any prefetched samples from the OLD offset. Just re-seeking
    // is racy: the background reader thread may not have moved off the
    // cached range before playback starts, so the listener would still
    // hear the old audio at the old playhead position.
    const double pos = track->transportSource->getCurrentPosition();
    const bool wasPlaying = track->transportSource->isPlaying();
    if (wasPlaying)
    {
        track->transportSource->stop();
    }

    track->transportSource->setSource(nullptr, 0, nullptr);
    track->transportSource->setSource(track->offsetSource.get(), 32768, &readAheadThread, track->sampleRate,
                                      track->numChannels);

    track->transportSource->setPosition(pos);
    if (wasPlaying)
    {
        track->transportSource->start();
    }
    return true;
}

bool AudioEngine::isPlaying() const
{
    return std::any_of(tracks.begin(), tracks.end(),
                       [](const auto& entry)
                       {
                           const auto& transport = entry.second->transportSource;
                           return transport != nullptr && transport->isPlaying();
                       });
}

double AudioEngine::getPositionMs() const
{
    // Use the first track as master clock; all tracks start at t=0 in Phase 1.
    if (tracks.empty())
    {
        return 0.0;
    }

    const auto& first = tracks.begin()->second;
    return first->transportSource != nullptr ? first->transportSource->getCurrentPosition() * 1000.0 : 0.0;
}

} // namespace jackdaw
