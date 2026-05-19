#include "AudioEngine.h"
#include "Log.h"

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
    rebuildTimer.stopTimer();
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

bool AudioEngine::addClip(const juce::String& clipId, const juce::File& filePath, double initialOffsetMs,
                          double inMs, double clipDurationMs, float initialGain, juce::String* outError)
{
    silverdaw::log::info("engine", "addClip id=" + clipId + " offsetMs=" + juce::String(initialOffsetMs) +
                                        " inMs=" + juce::String(inMs) + " durMs=" + juce::String(clipDurationMs) +
                                        " path=" + filePath.getFileName());
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
    // Initial trim window: where in the source file to start reading, and
    // how long the clip plays for. Defaults of 0 mean "from the start"
    // and "to the end of the source" respectively — un-trimmed legacy
    // behaviour.
    const double clampedInMs = juce::jmax(0.0, inMs);
    track->offsetSource->setInSourceSamples(
        static_cast<juce::int64>(clampedInMs * track->sampleRate / 1000.0));
    const double clampedDurMs = juce::jmax(0.0, clipDurationMs);
    track->offsetSource->setClipDurationSamples(
        static_cast<juce::int64>(clampedDurMs * track->sampleRate / 1000.0));

    track->transportSource = std::make_unique<juce::AudioTransportSource>();
    // 8192 samples (~186 ms at 44.1 kHz) of read-ahead is plenty for
    // SSD-backed file reads — enough to hide disk-IO latency on a
    // 60 Hz audio callback without the heavy synchronous initial-fill
    // cost a 32 768-sample buffer paid every time a clip was added.
    // Large buffers were biting hard when several duplicates of an
    // MP3 source landed in quick succession (each addClip blocking
    // the message thread for ~1 s on a fresh BufferingAudioSource).
    track->transportSource->setSource(track->offsetSource.get(),
                                      8192,             // read-ahead buffer size in samples
                                      &readAheadThread, // background reader thread (required when buffer > 0)
                                      track->sampleRate, track->numChannels);
    track->transportSource->setGain(juce::jlimit(0.0F, 4.0F, initialGain));

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

    // Replace any existing clip with the same id.
    if (auto it = tracks.find(clipId); it != tracks.end())
    {
        mixer.removeInputSource(it->second->transportSource.get());
        tracks.erase(it);
    }

    mixer.addInputSource(track->transportSource.get(), false);
    tracks.emplace(clipId, std::move(track));

    if (wasPlaying)
    {
        master.setPlaying(true);
    }

    return true;
}

bool AudioEngine::removeClip(const juce::String& clipId)
{
    auto it = tracks.find(clipId);
    if (it == tracks.end())
    {
        silverdaw::log::warn("engine", "removeClip unknown id=" + clipId);
        return false;
    }

    // Remove from mixer first so the audio thread stops pulling samples,
    // then release the file reader by clearing the transport's source.
    mixer.removeInputSource(it->second->transportSource.get());
    it->second->transportSource->setSource(nullptr);
    tracks.erase(it);
    silverdaw::log::info("engine", "removeClip id=" + clipId);
    return true;
}

bool AudioEngine::setClipGain(const juce::String& clipId, float gain)
{
    auto it = tracks.find(clipId);
    if (it == tracks.end())
    {
        silverdaw::log::warn("engine", "setClipGain unknown id=" + clipId);
        return false;
    }

    if (it->second->transportSource != nullptr)
    {
        it->second->transportSource->setGain(juce::jlimit(0.0F, 4.0F, gain));
    }
    silverdaw::log::debug("engine", "setClipGain id=" + clipId + " gain=" + juce::String(gain));
    return true;
}

void AudioEngine::rebuildTrackPrefetch(Track& track)
{
    if (track.transportSource == nullptr || track.offsetSource == nullptr)
    {
        return;
    }
    const double pos = trackSeekSecondsFor(track, master.getPositionSamples());
    silverdaw::log::info("engine", "rebuild prefetch (pos=" + juce::String(pos) + ")");
    // Just re-seek the existing source chain rather than tearing it
    // down and recreating it. `AudioTransportSource::setPosition`
    // forwards to its inner `BufferingAudioSource`, which invalidates
    // its prefetch buffer and asks the read-ahead thread to refill
    // from the new position — the side-effect we actually want.
    //
    // The previous implementation did
    //   transportSource->setSource(nullptr, ...)
    //   transportSource->setSource(newSource, 32 k-sample buffer, …)
    // which forced a *synchronous* initial fill of the new buffering
    // source on the message thread. For MP3 inputs that turned into
    // a ~1 s block per call — multiply by N dirty tracks and the
    // message thread stalled long enough for WebSocket events to
    // queue up. The setPosition path is non-blocking; the worst case
    // is a few audio blocks of silence while the read-ahead catches
    // up, which is still preferable to the stale-prefetch audio we
    // were originally trying to prevent.
    track.transportSource->setPosition(pos);
    track.prefetchDirty = false;
}

void AudioEngine::flushAllDirtyRebuildsSync()
{
    for (auto& [id, track] : tracks)
    {
        if (track->prefetchDirty)
        {
            rebuildTrackPrefetch(*track);
        }
    }
}

void AudioEngine::flushDirtyRebuilds()
{
    // Process at most ONE dirty track per call. Each
    // `rebuildTrackPrefetch` blocks the message thread for hundreds
    // of ms (sometimes north of a second on MP3 sources) while
    // JUCE's `BufferingAudioSource` is set up and the read-ahead
    // thread is asked to fill the initial 32 k-sample buffer. If we
    // looped through every dirty track in one go, the message
    // thread would be unresponsive for that × N seconds — long
    // enough that the user's transport-button clicks queue up in
    // the WebSocket dispatcher and only fire as a burst at the end
    // (see the diagnostic trace from the 2026-05-19 session).
    //
    // Chunking gives the message thread a chance to drain other
    // pending events (transport clicks, drag updates, etc.) between
    // each rebuild. The 10 ms re-arm leaves enough slack for several
    // queued envelopes to dispatch before the next chunk fires.
    Track* dirty = nullptr;
    for (auto& [id, track] : tracks)
    {
        if (track->prefetchDirty)
        {
            dirty = track.get();
            break;
        }
    }
    if (dirty == nullptr) return;

    rebuildTrackPrefetch(*dirty);

    for (auto& [id, track] : tracks)
    {
        if (track->prefetchDirty)
        {
            rebuildTimer.startTimer(10);
            return;
        }
    }
}

void AudioEngine::play()
{
    rebuildTimer.stopTimer();
    flushAllDirtyRebuildsSync();
    master.setPlaying(true);
    silverdaw::log::info("engine", "play (tracks=" + juce::String(static_cast<int>(tracks.size())) +
                                       " pos=" + juce::String(master.getPositionSamples()) + ")");
}

void AudioEngine::pause()
{
    master.setPlaying(false);
    silverdaw::log::info("engine", "pause (pos=" + juce::String(master.getPositionSamples()) + ")");
}

void AudioEngine::stop()
{
    master.setPlaying(false);
    master.setPositionSamples(0);
    for (auto& [id, track] : tracks)
    {
        if (track->transportSource != nullptr)
        {
            track->transportSource->setPosition(trackSeekSecondsFor(*track, 0));
        }
    }
    silverdaw::log::info("engine", "stop");
}

void AudioEngine::setPositionMs(double ms)
{
    const double sr = master.getSampleRate();
    const double clampedMs = juce::jmax(0.0, ms);
    const auto masterSamples = sr > 0.0
                                   ? static_cast<juce::int64>(clampedMs * sr / 1000.0)
                                   : static_cast<juce::int64>(0);
    master.setPositionSamples(masterSamples);

    // Per-track seek: also invalidate the read-ahead prefetch. JUCE's
    // `BufferingAudioSource` only flushes its cached samples when the
    // new position is OUTSIDE the cached range, so a backward seek of
    // less than the buffer's worth of audio (~0.7 s at 32 768 samples /
    // 48 kHz) can leave the stale tail in place. The next audio
    // callback would then play a moment of pre-seek audio before the
    // background prefetch catches up — exactly the "doesn't play at
    // the correct position" bug.
    //
    // Path:
    //   - Paused:  mark `prefetchDirty` and arm the debounce timer.
    //              ~150 ms after the last seek (whether by mouse drag
    //              or single click) the buffering source is rebuilt in
    //              the background, so the user's subsequent Play click
    //              is just a master-gate flip — no synchronous rebuild
    //              cost on the play path. This is the same pattern
    //              `setClipOffsetMs` uses for paused-move + Play.
    //   - Playing: rebuild immediately. There's a brief block-sized
    //              silence while the new source primes, but that's
    //              still better than audibly playing the wrong audio.
    const bool playing = master.isPlaying();
    for (auto& [id, track] : tracks)
    {
        if (track->transportSource == nullptr) continue;
        // Update the position first so the rebuild (or the next play()
        // flush) picks up the new master position via trackSeekSecondsFor.
        track->transportSource->setPosition(trackSeekSecondsFor(*track, masterSamples));
        if (playing)
        {
            rebuildTrackPrefetch(*track);
        }
        else
        {
            track->prefetchDirty = true;
        }
    }
    if (!playing)
    {
        // Arm the debounce timer once for the whole tracks map; it'll
        // call `flushDirtyRebuilds` from the message thread once the
        // user has stopped seeking for ~150 ms.
        rebuildTimer.startTimer(kRebuildDebounceMs);
    }
    silverdaw::log::info("engine", "setPositionMs " + juce::String(clampedMs));
}

bool AudioEngine::setClipOffsetMs(const juce::String& clipId, double offsetMs)
{
    auto it = tracks.find(clipId);
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

    if (master.isPlaying())
    {
        // Mid-playback move: rebuild now so the next block the device
        // pulls is at the new offset. Defer-rebuild isn't viable here
        // because audio is being produced live; the listener would
        // otherwise hear the stale ~0.7 s of pre-move audio.
        rebuildTrackPrefetch(*track);
    }
    else
    {
        // Paused move: mark dirty and arm the debounce timer. Each new
        // setClipOffsetMs call restarts the timer, so a rapid drag
        // collapses to a single rebuild ~150 ms after the user releases.
        // By the time they click Play the rebuilt BufferingAudioSource
        // has had time to fill its ring, and `play()` is just a master
        // gate flip — no synchronous rebuild on the play click.
        track->prefetchDirty = true;
        rebuildTimer.startTimer(kRebuildDebounceMs);
    }

    return true;
}

bool AudioEngine::setClipTrim(const juce::String& clipId, double startMs, double inMs, double clipDurationMs)
{
    auto it = tracks.find(clipId);
    if (it == tracks.end())
    {
        return false;
    }

    auto& track = it->second;
    if (track->offsetSource == nullptr || track->transportSource == nullptr)
    {
        return false;
    }

    const double sr = track->sampleRate;
    const auto offsetSamples =
        static_cast<juce::int64>(juce::jmax(0.0, startMs) * sr / 1000.0);
    const auto inSampleOffset =
        static_cast<juce::int64>(juce::jmax(0.0, inMs) * sr / 1000.0);
    const auto durSamples =
        static_cast<juce::int64>(juce::jmax(0.0, clipDurationMs) * sr / 1000.0);

    // Atomic writes — the next audio block sees all three new values
    // together because the OffsetSource reads them within a single
    // `getNextAudioBlock` invocation.
    track->offsetSource->setOffsetSamples(offsetSamples);
    track->offsetSource->setInSourceSamples(inSampleOffset);
    track->offsetSource->setClipDurationSamples(durSamples);

    // Same rebuild discipline as `setClipOffsetMs`: during playback we
    // must drop the stale prefetch; while paused we debounce.
    if (master.isPlaying())
    {
        rebuildTrackPrefetch(*track);
    }
    else
    {
        track->prefetchDirty = true;
        rebuildTimer.startTimer(kRebuildDebounceMs);
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
    // Report the master's "next read position" raw — i.e. where the
    // engine will pull from on the next audio callback. This is also
    // the position playback will resume from after a pause / seek, so
    // a click-to-seek at X and then Play visibly starts from X.
    //
    // The audible playback (what leaves the speakers) lags this value
    // by the device's output buffer latency, typically ~10-30 ms on
    // Windows WASAPI shared mode and effectively zero on ASIO. We don't
    // subtract that latency here because doing so introduces a visible
    // jump backward at the moment of pressing Play (paused position is
    // raw; playing would suddenly become compensated) and shifts the
    // click-to-seek target left of where the user clicked. The slight
    // visual lead is preferable to either of those discontinuities.
    const auto pos = master.getPositionSamples();
    return (static_cast<double>(pos) / sr) * 1000.0;
}

double AudioEngine::getClipDurationMs(const juce::String& clipId) const
{
    const auto it = tracks.find(clipId);
    if (it == tracks.end() || it->second->readerSource == nullptr)
    {
        return 0.0;
    }
    auto* reader = it->second->readerSource->getAudioFormatReader();
    if (reader == nullptr || reader->sampleRate <= 0.0)
    {
        return 0.0;
    }
    return (static_cast<double>(reader->lengthInSamples) / reader->sampleRate) * 1000.0;
}

} // namespace silverdaw
