#include "AudioEngine.h"

#include <iostream>

namespace silverdaw
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
        sourcePlayer.setSource(&master);
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

double AudioEngine::trackSeekSecondsFor(const Track& track, juce::int64 masterSamples) const
{
    // Latency compensation: read this track `latencySamples` earlier than
    // master so a future delay-introducing processor downstream still
    // outputs samples aligned with master. Clamp negatives to 0 (a track
    // can't read from before the timeline starts).
    const juce::int64 compensated = juce::jmax(static_cast<juce::int64>(0), masterSamples - track.latencySamples);
    const double sr = master.getSampleRate() > 0.0 ? master.getSampleRate() : track.sampleRate;
    return sr > 0.0 ? static_cast<double>(compensated) / sr : 0.0;
}

bool AudioEngine::addClip(const juce::String& trackId, const juce::File& filePath, double initialOffsetMs,
                          juce::String* outError)
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
    // Apply the initial timeline offset BEFORE the transport begins prefetching,
    // so the very first samples the BufferingAudioSource pulls are at the right
    // place. Avoids a brief offset=0 glimpse if the clip is added during playback.
    const double clampedInitialMs = juce::jmax(0.0, initialOffsetMs);
    track->offsetSource->setOffsetSamples(
        static_cast<juce::int64>(clampedInitialMs * track->sampleRate / 1000.0));

    track->transportSource = std::make_unique<juce::AudioTransportSource>();
    track->transportSource->setSource(track->offsetSource.get(),
                                      32768,            // read-ahead buffer size in samples
                                      &readAheadThread, // background reader thread (required when buffer > 0)
                                      track->sampleRate, track->numChannels);

    // Per-track transports are kept in the "started" state for their entire
    // lifetime in the engine. The master clock is the single play/pause gate;
    // when the gate is closed nobody pulls these transports, so they don't
    // advance. Starting them here means the first thing the master gate
    // does when it opens is hear audio, not silence-then-audio.
    track->transportSource->start();

    // Seek the new track to the current master position (latency-compensated)
    // so it joins playback in sync if added mid-session.
    track->transportSource->setPosition(trackSeekSecondsFor(*track, master.getPositionSamples()));

    // If we're currently playing, briefly close the master gate while we
    // swap the mixer input list. The audio callback will see a single
    // block of silence, which is acceptable for a clip-add event and
    // avoids any partial-state pull from a mixer mid-mutation.
    const bool wasPlaying = master.isPlaying();
    if (wasPlaying)
    {
        master.setPlaying(false);
    }

    // Replace any existing track with the same id.
    if (auto it = tracks.find(trackId); it != tracks.end())
    {
        mixer.removeInputSource(it->second->transportSource.get());
        tracks.erase(it);
    }

    mixer.addInputSource(track->transportSource.get(), false);
    tracks.emplace(trackId, std::move(track));

    if (wasPlaying)
    {
        master.setPlaying(true);
    }

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
    // Master gate is the single play/pause control. Per-track transports
    // are already in the started state (see `addClip`), so opening the
    // gate is enough to make audio flow.
    master.setPlaying(true);
}

void AudioEngine::pause()
{
    // Close the gate. Per-track transports stay started but don't advance
    // because nothing is pulling on them while the gate is closed.
    master.setPlaying(false);
}

void AudioEngine::stop()
{
    master.setPlaying(false);
    master.setPositionSamples(0);
    // Fan out to per-track transports so their internal positions are
    // reset to 0 too; the next `play()` then resumes from a known-good
    // zero across all tracks.
    for (auto& [id, track] : tracks)
    {
        if (track->transportSource != nullptr)
        {
            track->transportSource->setPosition(trackSeekSecondsFor(*track, 0));
        }
    }
}

void AudioEngine::setPositionMs(double ms)
{
    const double sr = master.getSampleRate();
    const double clampedMs = juce::jmax(0.0, ms);
    const auto masterSamples = sr > 0.0
                                   ? static_cast<juce::int64>(clampedMs * sr / 1000.0)
                                   : static_cast<juce::int64>(0);
    master.setPositionSamples(masterSamples);
    for (auto& [id, track] : tracks)
    {
        if (track->transportSource != nullptr)
        {
            track->transportSource->setPosition(trackSeekSecondsFor(*track, masterSamples));
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

    // Fast path: lock-free atomic write of the new offset.
    // ────────────────────────────────────────────────────
    // `OffsetSource::offsetSamples` is `std::atomic<int64>`. The next
    // call to `OffsetSource::getNextAudioBlock()` (issued by JUCE's
    // `BufferingAudioSource` background prefetch thread) sees the new
    // value and emits samples for the new offset. No locks, no
    // allocations, no source-chain rebuild.
    //
    // This is the right behaviour for the common case: clip-drag
    // updates while the transport is stopped. The frontend can stream
    // every intermediate position to us during a drag without us
    // having to tear down and rebuild a `BufferingAudioSource` per
    // frame. By the time the user presses Play, the offset has been
    // live for many blocks and any prefetch is already coherent.
    track->offsetSource->setOffsetSamples(newOffsetSamples);

    // Fallback: full source-chain rebuild when actively playing.
    // ──────────────────────────────────────────────────────────
    // If the transport is currently playing, the `BufferingAudioSource`
    // has prefetched ~0.7 s of audio (32 768 samples at 48 kHz) from
    // `OffsetSource` using the OLD offset. Those samples are already
    // baked into its internal ring buffer; the atomic write cannot
    // reach them. Without the rebuild the listener would hear
    // wrong-audio-at-wrong-position until the prefetch thread caught
    // up, which is audibly broken on a moving clip.
    //
    // `setSource(nullptr) + setSource(...)` destroys and recreates the
    // `BufferingAudioSource` from scratch, so its buffer is guaranteed
    // empty and the first prefetch reads through the new offset. The
    // current playback position is preserved across the rebuild so
    // playback continues without a perceptible seek.
    // Fallback: full source-chain rebuild when the master gate is open.
    // ────────────────────────────────────────────────────────────────
    // When playing, the `BufferingAudioSource` has prefetched ~0.7 s of
    // audio (32 768 samples at 48 kHz) from `OffsetSource` using the OLD
    // offset. Those samples are already baked into its internal ring
    // buffer; the atomic write cannot reach them. Without the rebuild
    // the listener would hear wrong-audio-at-wrong-position until the
    // prefetch thread caught up, which is audibly broken on a moving
    // clip.
    //
    // `setSource(nullptr) + setSource(...)` destroys and recreates the
    // `BufferingAudioSource` from scratch, so its buffer is guaranteed
    // empty and the first prefetch reads through the new offset. The
    // current playback position is preserved across the rebuild so
    // playback continues without a perceptible seek.
    if (master.isPlaying())
    {
        const double pos = track->transportSource->getCurrentPosition();
        track->transportSource->stop();
        track->transportSource->setSource(nullptr, 0, nullptr);
        track->transportSource->setSource(track->offsetSource.get(), 32768, &readAheadThread, track->sampleRate,
                                          track->numChannels);
        track->transportSource->setPosition(pos);
        track->transportSource->start();
    }

    return true;
}

bool AudioEngine::isPlaying() const
{
    return master.isPlaying();
}

double AudioEngine::getPositionMs() const
{
    const double sr = master.getSampleRate();
    if (sr <= 0.0)
    {
        return 0.0;
    }
    return (static_cast<double>(master.getPositionSamples()) / sr) * 1000.0;
}

} // namespace silverdaw
