#include "AudioEngine.h"

namespace jackdaw
{

AudioEngine::AudioEngine() = default;

AudioEngine::~AudioEngine()
{
    shutdown();
}

juce::String AudioEngine::initialise()
{
    // Register all built-in audio formats (WAV/AIFF/FLAC/OGG) plus, on
    // Windows, the Media Foundation format for MP3/M4A/WMA support.
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

bool AudioEngine::addClip(const juce::String& trackId, const juce::File& filePath)
{
    if (!filePath.existsAsFile())
        return false;

    auto* reader = formatManager.createReaderFor(filePath);
    if (reader == nullptr)
        return false;

    auto track = std::make_unique<Track>();

    // `AudioFormatReaderSource` takes ownership of the reader (deleteWhenRemoved=true).
    track->readerSource = std::make_unique<juce::AudioFormatReaderSource>(reader, true);

    track->transportSource = std::make_unique<juce::AudioTransportSource>();
    track->transportSource->setSource(track->readerSource.get(),
                                      32768,            // read-ahead buffer size in samples
                                      &readAheadThread, // background reader thread (required when buffer > 0)
                                      (double)reader->sampleRate, (int)reader->numChannels);

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
        return false;

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
        return false;

    if (it->second->transportSource != nullptr)
        it->second->transportSource->setGain(juce::jlimit(0.0f, 4.0f, gain));
    return true;
}

void AudioEngine::play()
{
    for (auto& [id, track] : tracks)
        if (track->transportSource != nullptr)
            track->transportSource->start();
}

void AudioEngine::pause()
{
    for (auto& [id, track] : tracks)
        if (track->transportSource != nullptr)
            track->transportSource->stop();
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

bool AudioEngine::isPlaying() const
{
    for (const auto& [id, track] : tracks)
        if (track->transportSource != nullptr && track->transportSource->isPlaying())
            return true;
    return false;
}

double AudioEngine::getPositionMs() const
{
    // Use the first track as master clock; all tracks start at t=0 in Phase 1.
    if (tracks.empty())
        return 0.0;

    const auto& first = tracks.begin()->second;
    return first->transportSource != nullptr ? first->transportSource->getCurrentPosition() * 1000.0 : 0.0;
}

} // namespace jackdaw
