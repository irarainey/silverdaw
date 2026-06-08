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
    // Windows Media Foundation support comes from JUCE built-in format registration.
    formatManager.registerBasicFormats();

    // Deep read-ahead priming avoids JUCE BufferingAudioSource dropping cold samples at play
    // start.
    readAheadThread.startThread();

    const auto err = deviceManager.initialiseWithDefaultDevices(0, 2);
    if (err.isNotEmpty())
    {
        return err;
    }

    // Apply master gain before metering; inject keep-alive after gain so the endpoint floor is
    // volume-independent.
    topMixer.addInputSource(&master, false);
    sourcePlayer.setSource(&masterMeter);
    deviceManager.addAudioCallback(&sourcePlayer);

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

    deviceManager.addChangeListener(&deviceChangeListener);

    // Avoid full device scans on startup; ASIO probing can block for hundreds of ms.
    rebuildDevicesSnapshot(/*rescan*/ false);
    devicesSnapshot.fellBackToDefault = didFallBack;

    // Wake pre-roll spends endpoint fade-in on the keep-alive floor, not the first content
    // attack.
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
    if (typeName.isEmpty() && deviceName.isEmpty())
    {
        const auto err = deviceManager.initialiseWithDefaultDevices(0, 2);
        rebuildDevicesSnapshot(/*rescan*/ false);
        devicesSnapshot.fellBackToDefault = false;
        return err;
    }

    if (typeName.isEmpty() || deviceName.isEmpty())
    {
        return juce::String("typeName and deviceName must both be supplied (or both empty)");
    }

    auto previousSetup = deviceManager.getAudioDeviceSetup();
    auto* previousType = deviceManager.getCurrentDeviceTypeObject();
    const juce::String previousTypeName = previousType != nullptr ? previousType->getTypeName() : juce::String();

    auto attempt = [&](const juce::String& wantType, const juce::String& wantDevice) -> juce::String
    {
        auto* currentType = deviceManager.getCurrentDeviceTypeObject();
        const auto currentTypeName = currentType != nullptr ? currentType->getTypeName() : juce::String();
        if (wantType != currentTypeName)
        {
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
        setup.inputDeviceName = {};
        setup.useDefaultInputChannels = true;
        setup.useDefaultOutputChannels = true;
        return deviceManager.setAudioDeviceSetup(setup, /*treatAsChosenDevice*/ true);
    };

    auto err = attempt(typeName, deviceName);
    if (err.isNotEmpty())
    {
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
    snap.fellBackToDefault = devicesSnapshot.fellBackToDefault;
    devicesSnapshot = std::move(snap);
}

// Windows under-reports Bluetooth endpoint latency, so known headset names get a conservative
// visual offset.
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
    // Rescale sample positions on device-rate changes to preserve wall-clock time.
    rebuildDevicesSnapshot(/*rescan*/ false);

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
    const bool previewPlaying =
        preview.transportSource != nullptr && preview.transportSource->isPlaying();
    if (master.isPlaying() || previewPlaying)
    {
        startFn();
        return;
    }

    if (outputKeepAlive.isWakePreroll())
    {
        prerollAction = std::move(startFn);
        return;
    }

    const double now = juce::Time::getMillisecondCounterHiRes();
    const bool cold = (now - lastOutputActiveMs) >= static_cast<double>(kEndpointWarmWindowMs);

    if (! cold || master.getSampleRate() <= 0.0)
    {
        startFn();
        return;
    }

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
    pendingSeekPrewarm = false;
    flushAllDirtyRebuildsSync();
    if (! primeTracksForPlayback(kPlayPrimeBudgetMs))
    {
        silverdaw::log::warn("engine",
                             "play deferred: tracks not ready after prime budget (tracks=" +
                                 juce::String(static_cast<int>(tracks.size())) +
                                 " pos=" + juce::String(master.getPositionSamples()) +
                                 ") — gate kept closed to avoid a silent first play");
        return;
    }
    // Keep-alive only wakes sleep-prone endpoints; idle output remains true digital silence.
    startWithWakePreroll([this]() {
        master.setPlaying(true);
        silverdaw::log::info("engine", "play (tracks=" + juce::String(static_cast<int>(tracks.size())) +
                                           " pos=" + juce::String(master.getPositionSamples()) + ")");
    });
}

bool AudioEngine::primeTracksForPlayback(int totalBudgetMs)
{
    if (master.getSampleRate() <= 0.0)
    {
        return false;
    }

    const double deadline = juce::Time::getMillisecondCounterHiRes() +
                            static_cast<double>(juce::jmax(0, totalBudgetMs));
    juce::AudioBuffer<float> scratch(2, kPrimeReadyTargetSamples);

    // Rebuild stale JUCE read-ahead buffers after timeline changes so playback starts at the
    // new position.
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

            int want = kPrimeReadyTargetSamples;
            const juce::int64 total = track->bufferingSource->getTotalLength();
            if (total > 0)
            {
                const juce::int64 left = total - track->bufferingSource->getNextReadPosition();
                want = static_cast<int>(juce::jlimit<juce::int64>(0, kPrimeReadyTargetSamples, left));
            }
            if (want <= 0)
            {
                track->prefetchDirty = false;
                it = notReady.erase(it);
                continue;
            }

            const auto perTrack = static_cast<juce::uint32>(
                juce::jmin(passRemaining, static_cast<double>(kPrimePerTrackTimeoutMs)));
            juce::AudioSourceChannelInfo info(&scratch, 0, want);
            if (track->bufferingSource->waitForNextAudioBlockReady(info, perTrack))
            {
                track->prefetchDirty = false;
                it = notReady.erase(it);
            }
            else
            {
                ++it;
            }
        }
    }

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
    lastOutputActiveMs = juce::Time::getMillisecondCounterHiRes();
    cancelWakePreroll();
    master.setPlaying(false);
    // Retire replaced snapshots/processors until the audio thread is quiescent.
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
        track->retiredWarps.clear();
        track->retiredEnvelopes.clear();
        track->retiredEdgeFades.clear();
    }
    silverdaw::log::info("engine", "stop");
}

void AudioEngine::setMasterGain(float gain)
{
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
