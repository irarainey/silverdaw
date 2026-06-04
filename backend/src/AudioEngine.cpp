#include "AudioEngine.h"
#include "AudioConstants.h"
#include "Log.h"

#include <cmath>

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

    // Wire the source player + meter + mixer chain before any device
    // switch so the first audio block from the preferred device flows
    // through the engine's mixer rather than into a dangling source.
    // `masterMeter` wraps `topMixer` to apply the master gain (with a
    // 10 ms smoothing ramp) and tap per-channel peaks for the UI meter.
    topMixer.addInputSource(&master, false);
    sourcePlayer.setSource(&masterMeter);
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

    // The output device is now open and streaming; treat that as the endpoint
    // last being active so a play shortly after launch isn't needlessly delayed
    // by a wake pre-roll. A genuinely idle gap before the first play still
    // ages past kEndpointWarmWindowMs and triggers the pre-roll.
    lastOutputActiveMs = juce::Time::getMillisecondCounterHiRes();

    return {};
}

void AudioEngine::shutdown()
{
    rebuildTimer.stopTimer();
    prerollTimer.stopTimer();
    prerollAction = nullptr;
    outputKeepAlive.setWakePreroll(false);
    stop();
    unloadPreview();
    deviceManager.removeChangeListener(&deviceChangeListener);
    deviceManager.removeAudioCallback(&sourcePlayer);
    sourcePlayer.setSource(nullptr);
    topMixer.removeAllInputs();
    // Tear down the BusGraph's TrackRuntimes (and their inner mixers)
    // BEFORE the clip transports they were pointing at — otherwise an
    // inner mixer could be destroyed while still holding a dangling
    // transport pointer in its input list.
    busGraph.clear();
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

bool AudioEngine::addClip(const juce::String& trackId, const juce::String& clipId, const juce::File& filePath,
                          double initialOffsetMs, double inMs, double clipDurationMs, float initialGain,
                          juce::String* outError)
{
    silverdaw::log::info("engine", "addClip trackId=" + trackId + " id=" + clipId +
                                        " offsetMs=" + juce::String(initialOffsetMs) +
                                        " inMs=" + juce::String(inMs) + " durMs=" + juce::String(clipDurationMs) +
                                        " path=" + filePath.getFileName());
    if (trackId.isEmpty())
    {
        const auto msg = juce::String("addClip requires non-empty trackId");
        silverdaw::log::warn("addClip", msg);
        if (outError != nullptr) *outError = msg;
        return false;
    }
    if (!filePath.existsAsFile())
    {
        const auto msg = "file does not exist: " + filePath.getFullPathName();
        silverdaw::log::warn("addClip", msg);
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
        silverdaw::log::warn("addClip", msg);
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
    // Own the read-ahead BufferingAudioSource explicitly instead of letting
    // AudioTransportSource create a hidden internal one. Owning it is what
    // lets us block-prime to an exact playhead via waitForNextAudioBlockReady
    // (see primeTracksForPlayback) so "press play" is instant from any
    // position. 8192 samples (~186 ms at 44.1 kHz) of read-ahead is plenty
    // for SSD-backed file reads — enough to hide disk-IO latency on a 60 Hz
    // audio callback without the heavy synchronous initial-fill cost a larger
    // buffer paid every time a clip was added (large buffers bit hard when
    // several duplicates of an MP3 source landed in quick succession, each
    // addClip blocking the message thread for ~1 s on a fresh buffer).
    track->bufferingSource = std::make_unique<juce::BufferingAudioSource>(
        track->offsetSource.get(), readAheadThread,
        /*deleteSourceWhenDeleted=*/false,
        kTransportReadAheadSamples, track->numChannels);
    // readAhead=0 / thread=nullptr here: the read-ahead is performed by our
    // owned bufferingSource above, so AudioTransportSource must not wrap it in
    // a second hidden BufferingAudioSource.
    track->transportSource->setSource(track->bufferingSource.get(),
                                      0,       // read-ahead handled by our owned bufferingSource
                                      nullptr, // ditto — no extra reader thread
                                      track->sampleRate, track->numChannels);
    track->transportSource->setGain(juce::jlimit(kMinTrackGain, kMaxTrackGain, initialGain));

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

    // Replace any existing clip with the same id. The replacement
    // must come out of whatever `TrackRuntime` it currently lives on
    // (which may differ from the new `trackId` if the renderer moved
    // a clip between UI tracks while keeping the same `clipId`).
    if (auto it = tracks.find(clipId); it != tracks.end())
    {
        busGraph.detachClip(clipId, it->second->transportSource.get());
        tracks.erase(it);
    }

    // Lazily create the per-UI-track runtime on first clip for this
    // track. The runtime's inner mixer is what the project mixer
    // Route the new clip into its UI track's `TrackRuntime` via the
    // BusGraph. The runtime is created lazily on first clip per
    // `trackId`; the BusGraph also handles `prepareToPlay` if the
    // engine is already running. Clip transports are never added
    // directly to the project root — that would double-pull and
    // bypass the per-track chain (Phase 5 step 1c).
    busGraph.attachClip(trackId, clipId, track->transportSource.get());
    tracks.emplace(clipId, std::move(track));

    if (wasPlaying)
    {
        master.setPlaying(true);
    }

    // Track whether a project has audio content. This now feeds diagnostics
    // only — the keep-alive floor is gated on playback + wake pre-roll, not on
    // a project being loaded, so a loaded-but-stopped project stays silent.
    master.setContentLoaded(! tracks.empty());

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

    // Detach the clip from its TrackRuntime via the BusGraph first so
    // the audio thread stops pulling samples, then release the file
    // reader by clearing the transport's source. The BusGraph tears
    // down the TrackRuntime if this was its last clip — an empty
    // track doesn't keep a stale inner mixer in the project root.
    busGraph.detachClip(clipId, it->second->transportSource.get());
    it->second->transportSource->setSource(nullptr);
    tracks.erase(it);
    // Diagnostic content flag (no longer gates the floor — idle output is
    // always true silence regardless of whether a project is loaded).
    master.setContentLoaded(! tracks.empty());
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
        it->second->transportSource->setGain(juce::jlimit(kMinTrackGain, kMaxTrackGain, gain));
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
    silverdaw::log::info("engine", "invalidate prefetch (pos=" + juce::String(pos) + ")");
    // Force BufferingAudioSource to drop any stale cached blocks after
    // offset/trim changes without tearing down the source chain. A plain
    // setPosition(pos) can be a no-op when the master position did not
    // change, so first jump far outside the current buffer, then return
    // to the real target. Both calls are non-blocking and let the
    // read-ahead thread refill from the new OffsetSource mapping.
    track.transportSource->setPosition(pos + 3600.0);
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
    // Time-budgeted batch rebuild. Each timer tick we drain dirty
    // tracks until either the queue is empty or we have spent more
    // than `kBudgetMs` of message-thread time on the loop, then
    // re-arm the timer at `kFollowupMs` to finish the rest in the
    // next tick. This gives many-track projects (>50 tracks) a
    // responsive UI: a single rebuildTrackPrefetch costs ~0.2–1.5 ms
    // depending on the BufferingAudioSource state, so we get ~3–10
    // tracks per tick instead of the previous one-track-per-10ms
    // (i.e. 50 tracks = 500 ms instead of 50–150 ms).
    //
    // Also called from `setPositionMs` while playing — see comment
    // there. The budgeted form is correct whether the transport is
    // playing or paused.
    constexpr double kBudgetMs = 2.0;
    constexpr int kFollowupMs = 1;

    const auto t0 = juce::Time::getMillisecondCounterHiRes();
    bool anyRemaining = false;
    for (auto& [id, track] : tracks)
    {
        if (!track->prefetchDirty) continue;
        if ((juce::Time::getMillisecondCounterHiRes() - t0) >= kBudgetMs)
        {
            anyRemaining = true;
            break;
        }
        rebuildTrackPrefetch(*track);
    }
    if (anyRemaining)
    {
        // Check if there's anything left after the budget cutoff.
        for (auto& [id, track] : tracks)
        {
            if (track->prefetchDirty)
            {
                rebuildTimer.startTimer(kFollowupMs);
                return;
            }
        }
    }

    // The rebuild has fully settled. After a paused seek, deep block-prime the
    // read-ahead at the new playhead so the first play lands on a buffer hit
    // rather than the cold-cache underrun that otherwise swallows the first
    // ~two plays (cold MP3 decode + warp across tracks sharing one read-ahead
    // thread). This mirrors the load-time prewarm and reuses the same routine.
    // Scoped to seeks (pendingSeekPrewarm) so paused clip edits never pay it,
    // and skipped while playing — audio already flows and the message thread
    // must never stall mid-playback. Bounded by kLoadPrimeBudgetMs so a cold
    // seek can never wedge the thread; the warm case returns in well under a
    // millisecond. This is a latency optimisation only: play() stays the
    // fail-closed correctness gate and re-primes regardless of this result.
    if (pendingSeekPrewarm && ! master.isPlaying())
    {
        pendingSeekPrewarm = false;
        const auto prewarmStart = juce::Time::getMillisecondCounterHiRes();
        const bool warm = primeTracksForPlayback(kLoadPrimeBudgetMs);
        silverdaw::log::info("engine",
                             "prewarm prefetch after seek settle (pos=" +
                                 juce::String(master.getPositionSamples()) + " warm=" +
                                 (warm ? "1" : "0") + " elapsedMs=" +
                                 juce::String(juce::Time::getMillisecondCounterHiRes() - prewarmStart, 1) +
                                 ")");
    }
}

void AudioEngine::startWithWakePreroll(std::function<void()> startFn)
{
    // If output is already flowing — the project transport is playing, a preview
    // is playing, or a wake pre-roll is already waking the endpoint — then the
    // endpoint is warm by definition, so start immediately.
    const bool previewPlaying =
        preview.transportSource != nullptr && preview.transportSource->isPlaying();
    if (master.isPlaying() || previewPlaying)
    {
        startFn();
        return;
    }

    // A pre-roll is already waking the endpoint: supersede its deferred action
    // with this one (last start wins, exactly one thing ends up playing) rather
    // than starting a second now and leaving the first armed to fire later.
    if (outputKeepAlive.isWakePreroll())
    {
        prerollAction = std::move(startFn);
        return;
    }

    const double now = juce::Time::getMillisecondCounterHiRes();
    const bool cold = (now - lastOutputActiveMs) >= static_cast<double>(kEndpointWarmWindowMs);

    // A pre-roll only does anything if the device is actually open (otherwise
    // there is no callback to emit the floor) — fall back to an immediate start
    // when warm or when there is no device.
    if (! cold || master.getSampleRate() <= 0.0)
    {
        startFn();
        return;
    }

    // Cold endpoint: hold content closed, run the floor for the pre-roll window
    // so the wake-up fade lands on the floor, then fire the real start.
    prerollAction = std::move(startFn);
    outputKeepAlive.setWakePreroll(true);
    prerollTimer.startTimer(kWakePrerollMs);
    silverdaw::log::info("engine",
                         "wake pre-roll armed (" + juce::String(kWakePrerollMs) +
                             "ms) — endpoint cold after " +
                             juce::String(now - lastOutputActiveMs, 0) + "ms idle");
}

void AudioEngine::cancelWakePreroll()
{
    if (! prerollTimer.isTimerRunning() && ! outputKeepAlive.isWakePreroll())
        return;
    prerollTimer.stopTimer();
    prerollAction = nullptr;
    outputKeepAlive.setWakePreroll(false);
    silverdaw::log::info("engine", "wake pre-roll cancelled before completion");
}

void AudioEngine::completeWakePreroll()
{
    prerollTimer.stopTimer();
    outputKeepAlive.setWakePreroll(false);
    auto action = std::move(prerollAction);
    prerollAction = nullptr;
    silverdaw::log::info("engine", "wake pre-roll complete — opening content");
    if (action)
        action();
}

void AudioEngine::play()
{
    rebuildTimer.stopTimer();
    // play() does its own fail-closed prime below, so any pending seek prewarm
    // is now redundant — drop it so a later unrelated rebuild settle can't fire
    // a stray block-prime.
    pendingSeekPrewarm = false;
    flushAllDirtyRebuildsSync();
    // Block-prime every track's read-ahead buffer at the current playhead
    // before opening the master gate, so the very first audio block is a
    // buffer hit and playback starts from the very first millisecond. Bounded
    // (kPlayPrimeBudgetMs) so a cold disk or a stalled track can never turn
    // pressing play into an unbounded stall.
    //
    // Fail-closed: only open the master gate once priming reports every track
    // ready. Opening it on an unfilled buffer is exactly what produced the
    // "first play after opening a project is silent, works on retry" bug — the
    // master clock advances while JUCE's BufferingAudioSource drops (does not
    // delay) the cold samples, so the fill cursor never catches the read cursor
    // and the whole clip plays as silence. If priming cannot fill in time
    // (no device, or a genuinely unreadable file) we leave the transport paused
    // rather than advance through silence; the next play retries from warm
    // buffers. In the common case the buffers are already warm (primed at load /
    // after a seek) and this returns near-instantly.
    if (! primeTracksForPlayback(kPlayPrimeBudgetMs))
    {
        silverdaw::log::warn("engine",
                             "play deferred: tracks not ready after prime budget (tracks=" +
                                 juce::String(static_cast<int>(tracks.size())) +
                                 " pos=" + juce::String(master.getPositionSamples()) +
                                 ") — gate kept closed to avoid a silent first play");
        return;
    }
    // Open the master gate now if the endpoint is warm, or after a short wake
    // pre-roll if it may have slept — so a cold endpoint's wake-up fade is spent
    // on the keep-alive floor instead of swallowing the first musical attack.
    startWithWakePreroll([this]() {
        master.setPlaying(true);
        silverdaw::log::info("engine", "play (tracks=" + juce::String(static_cast<int>(tracks.size())) +
                                           " pos=" + juce::String(master.getPositionSamples()) + ")");
    });
}

bool AudioEngine::primeTracksForPlayback(int totalBudgetMs)
{
    // Message-thread only. If no device is open the per-track buffering
    // sources are not prepared and can never fill, so waiting would just
    // burn `kPrimePerTrackTimeoutMs` per track for nothing. Report not-ready
    // so a fail-closed caller (play()) does not open the gate on dead sources.
    if (master.getSampleRate() <= 0.0)
    {
        return false;
    }

    const double deadline = juce::Time::getMillisecondCounterHiRes() +
                            static_cast<double>(juce::jmax(0, totalBudgetMs));
    // Fill a deep cushion (kPrimeReadyTargetSamples) — not just one device
    // block — before opening the master gate. JUCE's BufferingAudioSource drops
    // rather than delays samples on a partial cache miss (it clears the
    // unbuffered tail yet still advances its read cursor), so an underrun during
    // the cold-start transient permanently swallows the start of the audio. A
    // small low-latency output buffer plus many resampled/warped tracks sharing
    // one read-ahead thread is exactly when that transient bites — priming deep
    // here guarantees playback from the very first millisecond.
    //
    // waitForNextAudioBlockReady only inspects info.numSamples and never reads
    // info.buffer, but we back it with a real (stereo) scratch buffer sized to
    // the target so the AudioSourceChannelInfo contract stays clean.
    juce::AudioBuffer<float> scratch(2, kPrimeReadyTargetSamples);

    // Seed the not-ready set with every track that has buffering state, after
    // seeking each to the live master position so the buffering source refills
    // at the right spot (covers the case where a debounced rebuild has not run
    // yet). Readiness is tracked here, independently of `prefetchDirty` — that
    // flag is cleared by a rebuild before the buffer is actually filled, so it
    // cannot stand in for "the cushion is full".
    std::vector<Track*> notReady;
    notReady.reserve(tracks.size());
    for (auto& [id, track] : tracks)
    {
        if (track->transportSource == nullptr || track->bufferingSource == nullptr)
        {
            continue;
        }
        track->transportSource->setPosition(trackSeekSecondsFor(*track, master.getPositionSamples()));
        notReady.push_back(track.get());
    }

    // Multi-pass: keep re-waiting the still-cold tracks until they are all ready
    // or the overall budget expires. A track that needs more than one
    // kPrimePerTrackTimeoutMs slice (cold OS cache, MP3 seek-decode) thus gets
    // the whole remaining budget across passes instead of a single slice.
    while (! notReady.empty())
    {
        const double remaining = deadline - juce::Time::getMillisecondCounterHiRes();
        if (remaining <= 0.0)
        {
            break;
        }

        for (auto it = notReady.begin(); it != notReady.end();)
        {
            Track* track = *it;
            const double passRemaining = deadline - juce::Time::getMillisecondCounterHiRes();
            if (passRemaining <= 0.0)
            {
                break;
            }

            // Never wait for more samples than the clip actually has left at this
            // position — a short clip or a near-EOF seek would otherwise burn the
            // whole per-track timeout waiting for samples that will never exist.
            // A playhead outside the clip's audible window produces instant
            // silence (no file I/O), so such a track reports ready immediately.
            int want = kPrimeReadyTargetSamples;
            const juce::int64 total = track->bufferingSource->getTotalLength();
            if (total > 0)
            {
                const juce::int64 left = total - track->bufferingSource->getNextReadPosition();
                want = static_cast<int>(juce::jlimit<juce::int64>(0, kPrimeReadyTargetSamples, left));
            }
            if (want <= 0)
            {
                // Clip ends at or before the playhead: nothing to buffer here.
                track->prefetchDirty = false;
                it = notReady.erase(it);
                continue;
            }

            const auto perTrack = static_cast<juce::uint32>(
                juce::jmin(passRemaining, static_cast<double>(kPrimePerTrackTimeoutMs)));
            juce::AudioSourceChannelInfo info(&scratch, 0, want);
            if (track->bufferingSource->waitForNextAudioBlockReady(info, perTrack))
            {
                // Cushion filled — clear the dirty flag so a later rebuild does
                // not needlessly re-warm it, and drop it from the retry set.
                track->prefetchDirty = false;
                it = notReady.erase(it);
            }
            else
            {
                ++it;
            }
        }
    }

    // Anything still cold after the whole budget could not be filled in time.
    for (Track* track : notReady)
    {
        for (auto& [id, t] : tracks)
        {
            if (t.get() == track)
            {
                silverdaw::log::warn("engine", "prime incomplete id=" + id);
                break;
            }
        }
    }
    return notReady.empty();
}

void AudioEngine::pause()
{
    // Output is about to go silent — record that the endpoint was active until
    // now (warmth window) and abandon any in-flight wake pre-roll.
    lastOutputActiveMs = juce::Time::getMillisecondCounterHiRes();
    cancelWakePreroll();
    master.setPlaying(false);
    // The transport is paused — the audio thread is guaranteed not
    // to be inside any track's processing chain. Drain any retired
    // WarpProcessors that have been waiting for a quiescent window
    // to be freed. Without this, hot warp-toggling during a session
    // would let retired processors accumulate until the track is
    // removed.
    for (auto& [id, track] : tracks)
    {
        track->retiredWarps.clear();
        track->retiredEnvelopes.clear();
    }
    silverdaw::log::info("engine", "pause (pos=" + juce::String(master.getPositionSamples()) + ")");
}

void AudioEngine::stop()
{
    // Output is about to go silent — record that the endpoint was active until
    // now (warmth window) and abandon any in-flight wake pre-roll.
    lastOutputActiveMs = juce::Time::getMillisecondCounterHiRes();
    cancelWakePreroll();
    master.setPlaying(false);
    master.setPositionSamples(0);
    busGraph.resetSharedFx();
    for (auto& [id, track] : tracks)
    {
        if (track->transportSource != nullptr)
        {
            track->transportSource->setPosition(trackSeekSecondsFor(*track, 0));
        }
        // Transport is stopped — safe to drain (see pause()).
        track->retiredWarps.clear();
        track->retiredEnvelopes.clear();
    }
    silverdaw::log::info("engine", "stop");
}

void AudioEngine::setMasterGain(float gain)
{
    // Clamp to the user-facing [0, 1] range. `MeteringSource` applies
    // the new value with a 10 ms LinearSmoothedValue ramp on the audio
    // thread, so calls during active playback don't produce zipper
    // noise. We do NOT also call `sourcePlayer.setGain` — the player
    // is left at unity so the meter sees the same level the user
    // hears (post-gain peaks).
    const float clamped = juce::jlimit(0.0F, 1.0F, gain);
    masterMeter.setTargetGain(clamped);
}

void AudioEngine::consumeMasterPeaks(float& outL, float& outR)
{
    masterMeter.consumePeaks(outL, outR);
}

bool AudioEngine::consumeTrackPeaks(const juce::String& trackId, float& outL, float& outR)
{
    return busGraph.consumeTrackPeaks(trackId, outL, outR);
}

void AudioEngine::setTrackTone(const juce::String& trackId,
                               float bassDb, float midDb, float trebleDb, bool lowCut,
                               bool highCut, bool snap)
{
    busGraph.setTrackTone(trackId, bassDb, midDb, trebleDb, lowCut, highCut, snap);
}

void AudioEngine::setTrackLeveler(const juce::String& trackId, float amount, bool snap)
{
    busGraph.setTrackLeveler(trackId, amount, snap);
}

void AudioEngine::setTrackSends(const juce::String& trackId, float reverbSend, float delaySend)
{
    busGraph.setTrackSends(trackId, reverbSend, delaySend);
}

void AudioEngine::setTrackPan(const juce::String& trackId, float pan)
{
    busGraph.setTrackPan(trackId, pan);
}

void AudioEngine::setProjectReverb(float size, float decay, float tone, float mix, bool snap)
{
    busGraph.setProjectReverb(size, decay, tone, mix, snap);
}

void AudioEngine::setProjectDelay(double delayMs, float feedback, float tone, float mix, bool snap)
{
    // Stage the delay TIME while the transport is playing (it takes effect
    // on the next stop/seek), but apply it immediately when stopped so a
    // stationary preview hears the change at once (§7.9.4).
    busGraph.setProjectDelay(delayMs, feedback, tone, mix, snap,
                             /*applyTimeNow*/ ! master.isPlaying());
}

void AudioEngine::drainAllTrackPeaks(std::vector<BusGraph::TrackPeakSnapshot>& out)
{
    busGraph.drainAllTrackPeaks(out);
}

void AudioEngine::setPositionMs(double ms)
{
    const double sr = master.getSampleRate();
    const double clampedMs = juce::jmax(0.0, ms);
    const auto masterSamples = sr > 0.0
                                   ? static_cast<juce::int64>(clampedMs * sr / 1000.0)
                                   : static_cast<juce::int64>(0);
    master.setPositionSamples(masterSamples);

    // Seeking starts the shared Reverb / Delay from cold state — wipe any
    // ringing tail so it doesn't bleed across the jump (§7.10).
    busGraph.resetSharedFx();
    // Per-track seek: also invalidate the read-ahead prefetch. JUCE's
    // `BufferingAudioSource` only flushes its cached samples when the
    // new position is OUTSIDE the cached range, so a backward seek of
    // less than the buffer's worth of audio (~0.7 s at 32 768 samples /
    // 48 kHz) can leave the stale tail in place. The next audio
    // callback would then play a moment of pre-seek audio before the
    // background prefetch catches up — exactly the "doesn't play at
    // the correct position" bug.
    //
    // Path (both playing and paused — unified):
    //   - Mark every track `prefetchDirty` and arm the budgeted timer.
    //     The timer's `flushDirtyRebuilds` runs in time-bounded chunks
    //     so even very many tracks rebuild in a couple of ticks
    //     without ever blocking the message thread for more than
    //     ~2 ms at a time. The transport keeps playing during the
    //     rebuild window; some tracks may briefly emit stale audio
    //     (worst case ~0.7 s) before their fresh prefetch lands, but
    //     that's preferable to a long synchronous stall that would
    //     hold up websocket-message processing, UI redraws and the
    //     next seek the user issues.
    //   - We still call `transportSource->setPosition` immediately on
    //     every track (cheap, correctness-relevant) so the master
    //     position and per-track transport positions stay coherent
    //     for `getPosition`/`getTimeInfo` queries from the UI.
    for (auto& [id, track] : tracks)
    {
        if (track->transportSource == nullptr) continue;
        track->transportSource->setPosition(trackSeekSecondsFor(*track, masterSamples));
        track->prefetchDirty = true;
    }
    // While playing we want the rebuild as soon as possible (single
    // tick); while paused the existing debounce gives drag-seeks a
    // chance to coalesce.
    rebuildTimer.startTimer(master.isPlaying() ? 1 : kRebuildDebounceMs);
    // On a paused seek, arm a one-shot prewarm so the rebuild settle deep-fills
    // the read-ahead at the new playhead — the first play after a seek is then
    // a buffer hit, not a cold-cache underrun. Coalesced by the debounce so
    // scrubbing only primes once the user settles. Not armed while playing
    // (audio already flows; never stall the message thread mid-playback).
    if (! master.isPlaying())
    {
        pendingSeekPrewarm = true;
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
    track->offsetSource->requestWarpReseek();

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

bool AudioEngine::commitClipOffset(const juce::String& clipId)
{
    auto it = tracks.find(clipId);
    if (it == tracks.end()) return false;
    rebuildTrackPrefetch(*it->second);
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

    // Atomic writes — `setClipWindowAtomic` bumps a seqlock around
    // the three field writes so the audio thread sees all three
    // values as one snapshot (drag-trim updates them together and
    // the old per-field setters could be observed half-applied,
    // briefly producing audio with a new offset but the old
    // duration / inSource).
    track->offsetSource->setClipWindowAtomic(offsetSamples, inSampleOffset, durSamples);

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

bool AudioEngine::setClipEnvelope(const juce::String& clipId, const juce::Array<juce::var>& points)
{
    auto it = tracks.find(clipId);
    if (it == tracks.end())
    {
        return false;
    }
    auto& track = it->second;
    if (track->offsetSource == nullptr)
    {
        return false;
    }

    // Compile the immutable snapshot off the audio thread. An empty /
    // single-point shape is treated as "no envelope" — publish nullptr.
    auto snapshot = EnvelopeSnapshot::fromVarArray(points);
    const EnvelopeSnapshot* published = snapshot->isEmpty() ? nullptr : snapshot.get();

    // Publish the new pointer (release) BEFORE retiring the old object,
    // so the audio thread either sees the previous snapshot (still alive
    // in `retiredEnvelopes`) or the new one — never a freed pointer.
    track->offsetSource->setEnvelopeSnapshot(published);
    if (track->envelopeSnapshot != nullptr)
    {
        track->retiredEnvelopes.push_back(std::move(track->envelopeSnapshot));
    }
    track->envelopeSnapshot = (published != nullptr) ? std::move(snapshot) : nullptr;
    return true;
}

namespace
{
// Build a freshly-prepared WarpProcessor with optional tempo and pitch
// pre-applied. Shared between the per-clip and preview-voice rebuild
// paths so they cannot drift in how they translate (mode, semitones,
// cents, tempoRatio) into a constructed processor.
std::unique_ptr<WarpProcessor> makeWarpProcessor(
    int channels, double sampleRate, int blockSize,
    const juce::String& mode,
    std::optional<double> tempoRatio,
    std::optional<double> semitones,
    std::optional<double> cents)
{
    // Use the canonical helper from WarpProcessor.h so live, mixdown
    // and preview never drift in how they map mode strings to flags.
    const auto options = parseWarpMode(mode);
    auto wp = std::make_unique<WarpProcessor>(juce::jmax(1, channels),
                                              sampleRate > 0 ? sampleRate : 44100.0,
                                              options);
    wp->prepareToPlay(juce::jmax(64, blockSize));
    if (tempoRatio.has_value() && *tempoRatio > 0.0) wp->setTempoRatio(*tempoRatio);
    if (semitones.has_value() || cents.has_value())
    {
        const double s = semitones.value_or(0.0);
        const double c = cents.value_or(0.0);
        wp->setPitchScale(std::pow(2.0, (s + c / 100.0) / 12.0));
    }
    return wp;
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
        // the WarpProcessor is logically retired — but the audio
        // thread may still be inside `pullThroughWarp` having just
        // loaded the raw pointer before the swap. We move the old
        // unique_ptr into `retiredWarps` (drained on track unload
        // when the audio thread is quiescent) instead of destroying
        // it immediately; otherwise we have a use-after-free window
        // on the audio thread.
        track->offsetSource->setWarpProcessor(nullptr);
        if (track->warp != nullptr)
        {
            track->retiredWarps.push_back(std::move(track->warp));
        }
        // B3: disabling warp changes the timeline-to-source mapping
        // (no more tempo stretch), so any prefetched audio in the
        // BufferingAudioSource is now at the wrong position. Match
        // the rebuild path's discipline: rebuild immediately while
        // playing, debounce while paused. Without this, disabling
        // warp during playback let the listener hear up to ~0.7 s
        // of stale warp-output before the prefetch caught up.
        if (master.isPlaying())
        {
            rebuildTrackPrefetch(*track);
        }
        else
        {
            track->prefetchDirty = true;
            rebuildTimer.startTimer(kRebuildDebounceMs);
        }
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
        const auto& dm = deviceManager.getAudioDeviceSetup();
        auto wp = makeWarpProcessor(track->numChannels, track->sampleRate,
                                    static_cast<int>(dm.bufferSize), modeStr,
                                    tempoRatio, semitones, cents);
        // Retire the previous processor (if any) into the deferred
        // free-list rather than destroying it inline — the audio
        // thread may still be holding the raw pointer it loaded
        // from `OffsetSource::warp` just before the swap below.
        if (track->warp != nullptr)
        {
            track->retiredWarps.push_back(std::move(track->warp));
        }
        track->warp = std::move(wp);
        track->offsetSource->setWarpProcessor(track->warp.get());
        track->offsetSource->requestWarpReseek();
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

bool AudioEngine::isContentLoaded() const
{
    return master.isContentLoaded();
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
                              juce::String* outError,
                              std::optional<bool> initialWarpEnabled,
                              std::optional<juce::String> initialWarpMode,
                              std::optional<double> initialTempoRatio,
                              std::optional<double> initialSemitones,
                              std::optional<double> initialCents)
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

    if (initialWarpEnabled.value_or(false))
    {
        const auto modeStr = initialWarpMode.value_or(juce::String("rhythmic"));
        preview.warpMode = modeStr;
        const int channels = preview.readerSource ? preview.readerSource->getAudioFormatReader()->numChannels : 2;
        const auto& dm = deviceManager.getAudioDeviceSetup();
        auto wp = makeWarpProcessor(channels, preview.sampleRate,
                                    static_cast<int>(dm.bufferSize), modeStr,
                                    initialTempoRatio, initialSemitones, initialCents);
        [[maybe_unused]] auto oldWarp = std::move(preview.warp);
        preview.warp = std::move(wp);
        preview.offsetSource->setWarpProcessor(preview.warp.get());
        preview.offsetSource->requestWarpReseek();
    }

    preview.transportSource = std::make_unique<juce::AudioTransportSource>();
    // Match the per-track readahead size (8192) rather than the JUCE
    // default 32768. The bigger buffer was inherited from an earlier
    // no-warp preview path; with Rubber Band stretching in the chain,
    // a 32k-sample readahead on a single background reader thread can
    // underrun visibly when the user is auditioning warped material
    // (audible as a "stuttered/chopped" playback). Tracks have always
    // used 8192 with warp and play cleanly, so align preview with the
    // proven track-side discipline. ~85ms at 96kHz, still well above
    // the audio block size.
    preview.transportSource->setSource(preview.offsetSource.get(),
                                       /*readAheadBufferSize=*/kTransportReadAheadSamples,
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
    // Abandon any in-flight wake pre-roll first: its deferred start would
    // otherwise fire against a torn-down or replaced preview transport (e.g.
    // loadPreview() unloads the old clip mid-pre-roll), starting a clip the
    // user never asked to play.
    cancelWakePreroll();
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
    preview.retiredWarps.clear();
    preview.envelopeSnapshot.reset();
    preview.retiredEnvelopes.clear();
    preview.readerSource.reset();
    preview.inMs = 0.0;
    preview.durationMs = 0.0;
    preview.sourceDurationMs = 0.0;
    preview.warpMode = "rhythmic";
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
        if (preview.warp != nullptr) preview.retiredWarps.push_back(std::move(preview.warp));
        return true;
    }
    const juce::String requestedMode = mode.has_value() ? *mode : preview.warpMode;
    const bool needRebuild = (preview.warp == nullptr) || (requestedMode != preview.warpMode);
    if (needRebuild)
    {
        const int channels = preview.readerSource ? preview.readerSource->getAudioFormatReader()->numChannels : 2;
        const auto& dm = deviceManager.getAudioDeviceSetup();
        auto wp = makeWarpProcessor(channels, preview.sampleRate,
                                    static_cast<int>(dm.bufferSize), requestedMode,
                                    tempoRatio, semitones, cents);
        auto oldWarp = std::move(preview.warp);
        preview.warp = std::move(wp);
        preview.warpMode = requestedMode;
        preview.offsetSource->setWarpProcessor(preview.warp.get());
        if (oldWarp != nullptr) preview.retiredWarps.push_back(std::move(oldWarp));
        preview.offsetSource->requestWarpReseek();
        return true;
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

bool AudioEngine::setPreviewEnvelope(const juce::Array<juce::var>& points)
{
    if (preview.offsetSource == nullptr) return false;

    // Compile the immutable snapshot off the audio thread; an empty /
    // single-point shape is "no envelope" → publish nullptr. Publish the
    // new pointer (release) BEFORE retiring the old object so the audio
    // thread only ever sees a live snapshot or nullptr — never a freed
    // pointer. Mirrors `setClipEnvelope`.
    auto snapshot = EnvelopeSnapshot::fromVarArray(points);
    const EnvelopeSnapshot* published = snapshot->isEmpty() ? nullptr : snapshot.get();
    preview.offsetSource->setEnvelopeSnapshot(published);
    if (preview.envelopeSnapshot != nullptr)
    {
        preview.retiredEnvelopes.push_back(std::move(preview.envelopeSnapshot));
    }
    preview.envelopeSnapshot = (published != nullptr) ? std::move(snapshot) : nullptr;
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
    // Start now if the endpoint is warm, or after a short wake pre-roll if it
    // may have slept, so a cold preview's first attack isn't swallowed.
    startWithWakePreroll([this]() {
        if (preview.transportSource != nullptr)
            preview.transportSource->start();
    });
}

void AudioEngine::pausePreview()
{
    if (preview.transportSource == nullptr) return;
    lastOutputActiveMs = juce::Time::getMillisecondCounterHiRes();
    cancelWakePreroll();
    preview.transportSource->stop();
}

void AudioEngine::stopPreview()
{
    if (preview.transportSource == nullptr) return;
    lastOutputActiveMs = juce::Time::getMillisecondCounterHiRes();
    cancelWakePreroll();
    preview.transportSource->stop();
    preview.transportSource->setPosition(0.0);
}

void AudioEngine::setPreviewPositionMs(double ms)
{
    if (preview.transportSource == nullptr) return;
    const double clamped = juce::jlimit(0.0, juce::jmax(0.0, preview.durationMs), ms);
    const double ratio = preview.warp != nullptr && preview.warp->isActive()
                             ? preview.warp->getTempoRatio()
                             : 1.0;
    preview.transportSource->setPosition((clamped / juce::jmax(1.0e-9, ratio)) / 1000.0);
}

double AudioEngine::getPreviewPositionMs() const
{
    if (preview.transportSource == nullptr) return 0.0;
    const double ratio = preview.warp != nullptr && preview.warp->isActive()
                             ? preview.warp->getTempoRatio()
                             : 1.0;
    return preview.transportSource->getCurrentPosition() * 1000.0 * ratio;
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
