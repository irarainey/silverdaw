#include "AudioEngine.h"
#include "AudioConstants.h"
#include "AudioEngineWarpFactory.h"
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
        track->retiredEdgeFades.clear();
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
        track->retiredEdgeFades.clear();
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

} // namespace silverdaw
