#include "AudioEngine.h"
#include "Log.h"

#include <cmath>
#include <iostream>

namespace silverdaw
{

AudioEngine::AudioEngine() = default;

AudioEngine::~AudioEngine()
{
    shutdown();
}

juce::String AudioEngine::initialise(const juce::String& preferredTypeName,
                                     const juce::String& preferredDeviceName,
                                     bool* outFellBackToDefault)
{
    // Register all built-in audio formats. On Windows this includes
    // WindowsMediaAudioFormat (gated by JUCE_USE_WINDOWS_MEDIA_FORMAT)
    // for MP3/M4A/WMA support via Media Foundation.
    formatManager.registerBasicFormats();

    // Background thread must be running before any track's read-ahead
    // buffer is created in addClip(), otherwise the buffer stays empty
    // and the audio thread only ever sees silence.
    readAheadThread.startThread();

    // Default: no inputs, stereo output, JUCE-chosen sample rate /
    // buffer size. We always do the default init first so the
    // engine has a working device even when the saved-preference
    // path fails — switching mid-init from "no device" to "preferred
    // device" via `setAudioDeviceSetup` is what JUCE actually
    // supports, and it cleanly handles backends that don't carry the
    // saved device.
    const auto err = deviceManager.initialiseWithDefaultDevices(0, 2);
    if (err.isNotEmpty())
    {
        return err;
    }

    // Wire the source player + mixer chain before any device switch
    // so the first audio block from the preferred device flows
    // through the engine's mixer rather than into a dangling source.
    topMixer.addInputSource(&master, false);
    sourcePlayer.setSource(&topMixer);
    deviceManager.addAudioCallback(&sourcePlayer);

    // Try to honour the persisted device preference. Any failure
    // along the way is non-fatal — we leave the default device live
    // and tell the caller via `outFellBackToDefault`.
    bool didFallBack = false;
    if (preferredTypeName.isNotEmpty() && preferredDeviceName.isNotEmpty())
    {
        const auto switchErr = selectOutputDevice(preferredTypeName, preferredDeviceName);
        if (switchErr.isNotEmpty())
        {
            silverdaw::log::warn("audio",
                                 juce::String("preferred device '") + preferredDeviceName +
                                     "' (" + preferredTypeName + ") not available: " + switchErr +
                                     "; using system default");
            didFallBack = true;
        }
    }
    if (outFellBackToDefault) *outFellBackToDefault = didFallBack;

    // Subscribe to device-list changes (USB plug / unplug, Windows
    // audio config reload). The listener fires on the message thread.
    deviceManager.addChangeListener(&deviceChangeListener);

    // Seed the cached snapshot WITHOUT scanning every device type —
    // JUCE already scanned the active device type during
    // `initialiseWithDefaultDevices`, so the current selection is
    // populated. Other types (DirectSound, ASIO, …) are scanned
    // lazily on the renderer's first `AUDIO_DEVICES_REQUEST` after
    // bridge-ready. Skipping the full scan here shaves 100–400 ms
    // off backend startup, dominated by ASIO driver probing.
    rebuildDevicesSnapshot(/*rescan*/ false);
    devicesSnapshot.fellBackToDefault = didFallBack;

    return {};
}

void AudioEngine::shutdown()
{
    rebuildTimer.stopTimer();
    stop();
    unloadPreview();
    deviceManager.removeChangeListener(&deviceChangeListener);
    deviceManager.removeAudioCallback(&sourcePlayer);
    sourcePlayer.setSource(nullptr);
    topMixer.removeAllInputs();
    mixer.removeAllInputs();
    tracks.clear();
    deviceManager.closeAudioDevice();
    readAheadThread.stopThread(1000);
}

void AudioEngine::refreshAudioDevices()
{
    rebuildDevicesSnapshot(/*rescan*/ true);
}

juce::String AudioEngine::selectOutputDevice(const juce::String& typeName, const juce::String& deviceName)
{
    // Empty + empty = "revert to system default".
    if (typeName.isEmpty() && deviceName.isEmpty())
    {
        // Re-run the JUCE default init. On the success path the
        // existing audio callback is kept attached — we don't
        // remove/re-add `sourcePlayer` because JUCE's device
        // manager rebinds callbacks across a setup change.
        const auto err = deviceManager.initialiseWithDefaultDevices(0, 2);
        rebuildDevicesSnapshot(/*rescan*/ false);
        devicesSnapshot.fellBackToDefault = false;
        return err;
    }

    if (typeName.isEmpty() || deviceName.isEmpty())
    {
        return juce::String("typeName and deviceName must both be supplied (or both empty)");
    }

    // Capture the current setup so we can roll back if the switch fails.
    auto previousSetup = deviceManager.getAudioDeviceSetup();
    auto* previousType = deviceManager.getCurrentDeviceTypeObject();
    const juce::String previousTypeName = previousType != nullptr ? previousType->getTypeName() : juce::String();

    auto attempt = [&](const juce::String& wantType, const juce::String& wantDevice) -> juce::String
    {
        // Switch device type if needed. `setCurrentAudioDeviceType`
        // doesn't itself open the device — that happens via the
        // follow-up `setAudioDeviceSetup` call. Pass
        // `treatAsChosenDevice=false` so JUCE doesn't immediately
        // pick + open a default device for the new type (we'd just
        // close it again 1 ms later when `setAudioDeviceSetup`
        // applies the user's actual choice) — avoiding that
        // double-open shaves a few hundred ms off cross-type
        // switches on Windows.
        auto* currentType = deviceManager.getCurrentDeviceTypeObject();
        const auto currentTypeName = currentType != nullptr ? currentType->getTypeName() : juce::String();
        if (wantType != currentTypeName)
        {
            // Confirm the requested type exists on this platform
            // before asking JUCE to switch — otherwise JUCE will
            // silently keep the current type but the caller thinks
            // the switch succeeded.
            const auto& types = deviceManager.getAvailableDeviceTypes();
            bool foundType = false;
            for (auto* t : types)
            {
                if (t != nullptr && t->getTypeName() == wantType)
                {
                    foundType = true;
                    break;
                }
            }
            if (!foundType)
            {
                return juce::String("Audio device type '") + wantType + "' not found";
            }
            deviceManager.setCurrentAudioDeviceType(wantType, /*treatAsChosenDevice*/ false);
        }

        auto setup = deviceManager.getAudioDeviceSetup();
        setup.outputDeviceName = wantDevice;
        // Keep inputs disabled (Silverdaw is output-only today). Use
        // whatever defaults the new device type picks for sample rate
        // / buffer size; the master clock recomputes on each
        // prepareToPlay so we don't need to force a value here.
        setup.inputDeviceName = {};
        setup.useDefaultInputChannels = true;
        setup.useDefaultOutputChannels = true;
        return deviceManager.setAudioDeviceSetup(setup, /*treatAsChosenDevice*/ true);
    };

    auto err = attempt(typeName, deviceName);
    if (err.isNotEmpty())
    {
        // Roll back to the previous setup. We attempt this even when
        // `previousTypeName` is empty (first init failed) so JUCE at
        // least lands somewhere sensible. A failed rollback is
        // logged but not surfaced — the caller's error message
        // already explains why playback is silent.
        if (previousTypeName.isNotEmpty())
        {
            auto* currentType = deviceManager.getCurrentDeviceTypeObject();
            const auto currentTypeName = currentType != nullptr ? currentType->getTypeName() : juce::String();
            if (currentTypeName != previousTypeName)
            {
                deviceManager.setCurrentAudioDeviceType(previousTypeName, true);
            }
            const auto rollbackErr = deviceManager.setAudioDeviceSetup(previousSetup, true);
            if (rollbackErr.isNotEmpty())
            {
                silverdaw::log::warn("audio",
                                     juce::String("rollback to previous device failed: ") + rollbackErr);
            }
        }
        rebuildDevicesSnapshot(/*rescan*/ false);
        return err;
    }

    rebuildDevicesSnapshot(/*rescan*/ false);
    devicesSnapshot.fellBackToDefault = false;
    return {};
}

void AudioEngine::rebuildDevicesSnapshot(bool rescan)
{
    AudioDevicesSnapshot snap;
    const auto& types = deviceManager.getAvailableDeviceTypes();
    for (auto* type : types)
    {
        if (type == nullptr) continue;
        if (rescan) type->scanForDevices();
        DeviceTypeListing entry;
        entry.typeName = type->getTypeName();
        entry.deviceNames = type->getDeviceNames(/*wantInputNames*/ false);
        snap.types.add(std::move(entry));
    }
    if (rescan) hasFullyScanned = true;
    if (auto* currentType = deviceManager.getCurrentDeviceTypeObject())
    {
        snap.currentTypeName = currentType->getTypeName();
    }
    const auto setup = deviceManager.getAudioDeviceSetup();
    snap.currentDeviceName = setup.outputDeviceName;
    if (auto* dev = deviceManager.getCurrentAudioDevice())
    {
        snap.currentSampleRate = dev->getCurrentSampleRate();
        snap.currentBufferSize = dev->getCurrentBufferSizeSamples();
    }
    snap.outputLatencyMs = getOutputLatencyMs();
    snap.heuristicExtraLatencyMs = getHeuristicExtraLatencyMs();
    // Preserve the `fellBackToDefault` flag from the previous snapshot
    // — it's a one-shot startup notice that the caller (Main.cpp)
    // clears once it has surfaced the warning to the renderer.
    snap.fellBackToDefault = devicesSnapshot.fellBackToDefault;
    devicesSnapshot = std::move(snap);
}

/**
 * Heuristic: does the given device name look like a Bluetooth headset?
 *
 * Conservative substring match. False positives are worse than false
 * negatives — overcompensating latency on a wired device causes a
 * visible play/pause snap; missing a BT device just falls back to the
 * pre-existing "barely-noticeable visual lead" behaviour. Patterns are
 * chosen to match common Windows device names without catching
 * obviously-wired devices like "Headphones (Realtek HD Audio)".
 */
static bool looksLikeBluetoothDevice(const juce::String& deviceName)
{
    if (deviceName.isEmpty()) return false;
    const auto lower = deviceName.toLowerCase();
    return lower.contains("bluetooth") || lower.contains(" bt ") || lower.endsWith(" bt") ||
           lower.startsWith("bt ") || lower.contains("airpods") || lower.contains("hands-free") ||
           lower.contains("hands free") || lower.contains("hfp") || lower.contains("a2dp") ||
           lower.contains("wireless head") || lower.contains("wireless earbud") ||
           lower.contains("earbuds");
}

double AudioEngine::getHeuristicExtraLatencyMs() const
{
    // Windows can route a single BT headset over either A2DP (music)
    // or HFP/Hands-Free (call). HFP uses a low-bitrate codec with much
    // more buffering/processing latency than A2DP, and the device
    // name carries the hint — "Hands-Free" / "HFP" is the call
    // profile, anything else is A2DP. Pick a baseline that matches
    // the typical end-to-end delay Windows doesn't measure (radio
    // queue + headset DSP + headset DAC):
    //
    //   - Hands-Free / HFP:      ≈400 ms (low-bitrate call codec)
    //   - Generic A2DP / SBC:    ≈250 ms (common Windows default)
    //
    // Slight over-compensation is preferred to under-compensation:
    // a small visual *lag* (~50 ms) is far less noticeable than the
    // sustained visual *lead* the user otherwise sees on Bluetooth.
    static constexpr double kHandsFreeLatencyMs = 400.0;
    static constexpr double kA2dpLatencyMs = 250.0;

    const auto setup = deviceManager.getAudioDeviceSetup();
    if (!looksLikeBluetoothDevice(setup.outputDeviceName)) return 0.0;

    const auto lower = setup.outputDeviceName.toLowerCase();
    if (lower.contains("hands-free") || lower.contains("hands free") || lower.contains("hfp"))
    {
        return kHandsFreeLatencyMs;
    }
    return kA2dpLatencyMs;
}

double AudioEngine::getOutputLatencyMs() const
{
    auto* dev = deviceManager.getCurrentAudioDevice();
    if (dev == nullptr) return 0.0;
    const double sr = dev->getCurrentSampleRate();
    if (sr <= 0.0) return 0.0;
    const auto driverSamples = juce::jmax(0, dev->getOutputLatencyInSamples());
    const double driverMs = (static_cast<double>(driverSamples) / sr) * 1000.0;
    return driverMs + getHeuristicExtraLatencyMs();
}

void AudioEngine::onDeviceListChanged()
{
    // JUCE fires `audioDeviceListChanged` on every USB plug / unplug,
    // Windows-audio reconfig, sample-rate change, etc. Refresh the
    // snapshot without a full rescan — that's already what the
    // device manager has done internally — and detect the
    // "current device removed" case.
    rebuildDevicesSnapshot(/*rescan*/ false);

    // Was the previously-active device dropped? `getCurrentAudioDevice`
    // returns null when the device manager couldn't reopen the device
    // after a list change. Fall back to default so audio keeps
    // flowing; persistence is the renderer's job and isn't cleared.
    if (deviceManager.getCurrentAudioDevice() == nullptr)
    {
        silverdaw::log::warn("audio", "current output device disappeared; falling back to default");
        deviceManager.initialiseWithDefaultDevices(0, 2);
        rebuildDevicesSnapshot(/*rescan*/ false);
    }

    if (deviceListChangedCallback)
    {
        deviceListChangedCallback();
    }
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

namespace
{
// Translate a renderer-side mode label into Rubber Band engine flags.
// `'complex'` selects R3 / Finer (highest quality, highest CPU); the
// other two share the R2 / Faster engine but differ in the auto-
// curve / transient-handling preset Rubber Band picks internally.
RubberBand::RubberBandStretcher::Options parseWarpMode(const juce::String& mode)
{
    using O = RubberBand::RubberBandStretcher;
    if (mode == "complex") return O::OptionEngineFiner;
    if (mode == "tonal")
        return O::OptionEngineFaster | O::OptionTransientsSmooth | O::OptionWindowLong;
    // Default — rhythmic. Suits drums and most general material.
    return O::OptionEngineFaster | O::OptionTransientsCrisp;
}
} // namespace

bool AudioEngine::setClipWarp(const juce::String& clipId,
                              std::optional<bool> enabled,
                              std::optional<juce::String> mode,
                              std::optional<double> tempoRatio,
                              std::optional<double> semitones,
                              std::optional<double> cents)
{
    auto it = tracks.find(clipId);
    if (it == tracks.end()) return false;
    auto& track = it->second;
    if (track->offsetSource == nullptr) return false;

    const bool wantEnabled = enabled.value_or(track->warp != nullptr);

    if (!wantEnabled)
    {
        // Disable / teardown. The audio thread sees nullptr via
        // `setWarpProcessor(nullptr)` on the next read, after which
        // it's safe to destroy the WarpProcessor itself. JUCE's
        // graph plumbing never holds raw pointers to internal nodes
        // across audio callbacks, so the publish-then-destroy
        // sequence is sufficient — no need for an extra spin or fence.
        track->offsetSource->setWarpProcessor(nullptr);
        track->warp.reset();
        silverdaw::log::info("engine", "clip warp disabled " + clipId);
        return true;
    }

    // Enable / configure. If we already have a processor and the mode
    // wasn't explicitly changed, just push the new parameters to it
    // via its atomic publishers (no allocation, no audio glitch). If
    // the mode IS changing — Rubber Band can't switch engines on a
    // live instance — we tear down and rebuild.
    const bool needRebuild = (track->warp == nullptr) || mode.has_value();
    if (needRebuild)
    {
        const auto modeStr = mode.value_or(juce::String("rhythmic"));
        const auto options = parseWarpMode(modeStr);
        const int channels = juce::jmax(1, track->numChannels);
        const double sr = track->sampleRate > 0 ? track->sampleRate : 44100.0;
        auto wp = std::make_unique<WarpProcessor>(channels, sr, options);
        // Pre-size the processor for the engine's current block size
        // so the first audio block doesn't have to grow buffers.
        const auto& dm = deviceManager.getAudioDeviceSetup();
        const int blockSize = juce::jmax(64, static_cast<int>(dm.bufferSize));
        wp->prepareToPlay(blockSize);
        // Park the engine's audio thread at nullptr before swapping
        // — same publish-then-replace discipline as the disable path.
        track->offsetSource->setWarpProcessor(nullptr);
        track->warp = std::move(wp);
        track->offsetSource->setWarpProcessor(track->warp.get());
        silverdaw::log::info("engine",
            "clip warp built " + clipId + " mode=" + modeStr);
    }

    if (auto* w = track->warp.get())
    {
        if (tempoRatio.has_value() && *tempoRatio > 0.0)
        {
            w->setTempoRatio(*tempoRatio);
        }
        if (semitones.has_value() || cents.has_value())
        {
            const double s = semitones.value_or(0.0);
            const double c = cents.value_or(0.0);
            const double scale = std::pow(2.0, (s + c / 100.0) / 12.0);
            w->setPitchScale(scale);
        }
    }

    // Whether we built a fresh processor or just nudged its parameters,
    // the BufferingAudioSource's read-ahead may now hold ~186 ms of
    // audio prefetched through the OLD warp settings (or no warp at
    // all). Drop it: a play-from-cold pull would otherwise serve a
    // few hundred ms of stale audio before the fresh prefetch caught
    // up — heard as a noticeable discontinuity at the very start of
    // playback. Use the same rebuild discipline as `setClipOffsetMs`
    // — sync rebuild while playing, debounced while paused.
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

// -----------------------------------------------------------------------------
// Preview voice
// -----------------------------------------------------------------------------

bool AudioEngine::loadPreview(const juce::File& filePath, double inMs, double durationMs,
                              juce::String* outError)
{
    // Always start from a clean slate. unloadPreview() handles the case
    // where nothing is currently loaded.
    unloadPreview();

    if (!filePath.existsAsFile())
    {
        if (outError != nullptr) *outError = "file does not exist: " + filePath.getFullPathName();
        return false;
    }

    auto* reader = formatManager.createReaderFor(filePath);
    if (reader == nullptr)
    {
        if (outError != nullptr) *outError = "could not decode: " + filePath.getFullPathName();
        return false;
    }

    preview.sampleRate = reader->sampleRate > 0.0 ? reader->sampleRate : 44100.0;
    preview.sourceDurationMs =
        (static_cast<double>(reader->lengthInSamples) / preview.sampleRate) * 1000.0;
    preview.inMs = juce::jmax(0.0, juce::jmin(inMs, preview.sourceDurationMs));
    const double remaining = juce::jmax(0.0, preview.sourceDurationMs - preview.inMs);
    preview.durationMs = durationMs > 0.0 ? juce::jmin(durationMs, remaining) : remaining;

    preview.readerSource = std::make_unique<juce::AudioFormatReaderSource>(reader, /*deleteReader=*/true);

    preview.offsetSource = std::make_unique<OffsetSource>(preview.readerSource.get());
    preview.offsetSource->setOffsetSamples(0);
    preview.offsetSource->setInSourceSamples(
        static_cast<juce::int64>((preview.inMs / 1000.0) * preview.sampleRate));
    preview.offsetSource->setClipDurationSamples(
        static_cast<juce::int64>((preview.durationMs / 1000.0) * preview.sampleRate));

    preview.transportSource = std::make_unique<juce::AudioTransportSource>();
    preview.transportSource->setSource(preview.offsetSource.get(), /*readAheadBufferSize=*/32768,
                                       &readAheadThread, preview.sampleRate);
    preview.transportSource->setPosition(0.0);

    topMixer.addInputSource(preview.transportSource.get(), false);
    previewGeneration.fetch_add(1, std::memory_order_acq_rel);
    silverdaw::log::info("preview", "loaded " + filePath.getFullPathName().toStdString()
                                        + " inMs=" + std::to_string(preview.inMs)
                                        + " durationMs=" + std::to_string(preview.durationMs));
    return true;
}

void AudioEngine::unloadPreview()
{
    if (preview.transportSource == nullptr) return;
    preview.transportSource->stop();
    topMixer.removeInputSource(preview.transportSource.get());
    preview.transportSource->setSource(nullptr);
    preview.transportSource.reset();
    if (preview.offsetSource != nullptr)
    {
        preview.offsetSource->setWarpProcessor(nullptr);
    }
    preview.offsetSource.reset();
    preview.warp.reset();
    preview.readerSource.reset();
    preview.inMs = 0.0;
    preview.durationMs = 0.0;
    preview.sourceDurationMs = 0.0;
    previewGeneration.fetch_add(1, std::memory_order_acq_rel);
}

bool AudioEngine::setPreviewWarp(std::optional<bool> enabled,
                                 std::optional<juce::String> mode,
                                 std::optional<double> tempoRatio,
                                 std::optional<double> semitones,
                                 std::optional<double> cents)
{
    if (preview.offsetSource == nullptr) return false;
    const bool wantEnabled = enabled.value_or(preview.warp != nullptr);
    if (!wantEnabled)
    {
        preview.offsetSource->setWarpProcessor(nullptr);
        preview.warp.reset();
        return true;
    }
    const bool needRebuild = (preview.warp == nullptr) || mode.has_value();
    if (needRebuild)
    {
        const auto modeStr = mode.value_or(juce::String("rhythmic"));
        const auto options = parseWarpMode(modeStr);
        const int channels = preview.readerSource ? preview.readerSource->getAudioFormatReader()->numChannels : 2;
        const double sr = preview.sampleRate > 0 ? preview.sampleRate : 44100.0;
        auto wp = std::make_unique<WarpProcessor>(juce::jmax(1, channels), sr, options);
        const auto& dm = deviceManager.getAudioDeviceSetup();
        const int blockSize = juce::jmax(64, static_cast<int>(dm.bufferSize));
        wp->prepareToPlay(blockSize);
        preview.offsetSource->setWarpProcessor(nullptr);
        preview.warp = std::move(wp);
        preview.offsetSource->setWarpProcessor(preview.warp.get());
    }
    if (auto* w = preview.warp.get())
    {
        if (tempoRatio.has_value() && *tempoRatio > 0.0) w->setTempoRatio(*tempoRatio);
        if (semitones.has_value() || cents.has_value())
        {
            const double s = semitones.value_or(0.0);
            const double c = cents.value_or(0.0);
            w->setPitchScale(std::pow(2.0, (s + c / 100.0) / 12.0));
        }
    }
    return true;
}

void AudioEngine::playPreview()
{
    if (preview.transportSource == nullptr) return;
    // If the playhead is at or past the end of the window, restart from 0.
    if (getPreviewPositionMs() >= preview.durationMs - 1.0)
    {
        preview.transportSource->setPosition(0.0);
    }
    preview.transportSource->start();
}

void AudioEngine::pausePreview()
{
    if (preview.transportSource == nullptr) return;
    preview.transportSource->stop();
}

void AudioEngine::stopPreview()
{
    if (preview.transportSource == nullptr) return;
    preview.transportSource->stop();
    preview.transportSource->setPosition(0.0);
}

void AudioEngine::setPreviewPositionMs(double ms)
{
    if (preview.transportSource == nullptr) return;
    const double clamped = juce::jlimit(0.0, juce::jmax(0.0, preview.durationMs), ms);
    preview.transportSource->setPosition(clamped / 1000.0);
}

double AudioEngine::getPreviewPositionMs() const
{
    if (preview.transportSource == nullptr) return 0.0;
    return preview.transportSource->getCurrentPosition() * 1000.0;
}

double AudioEngine::getPreviewDurationMs() const
{
    return preview.durationMs;
}

bool AudioEngine::isPreviewPlaying() const
{
    return preview.transportSource != nullptr && preview.transportSource->isPlaying();
}

bool AudioEngine::isPreviewLoaded() const
{
    return preview.transportSource != nullptr;
}

juce::int64 AudioEngine::getPreviewGeneration() const
{
    return previewGeneration.load(std::memory_order_acquire);
}

} // namespace silverdaw
