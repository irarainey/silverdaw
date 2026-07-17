// Device lifecycle: initialise, open, select, refresh, snapshots, latency, keep-awake, change
// callback. All methods are message-thread-only unless noted.
#include "AudioEngine.h"
#include "Log.h"

namespace silverdaw
{

juce::String AudioEngine::initialise(const juce::String& preferredTypeName,
                                     const juce::String& preferredDeviceName,
                                     bool* outFellBackToDefault)
{
    initialiseGraph();
    return openAudioDevice(preferredTypeName, preferredDeviceName, outFellBackToDefault);
}

void AudioEngine::initialiseGraph()
{
    // Fast, device-independent setup so the bridge can come up and accept project/graph
    // commands before the (potentially slow) audio device is opened.
    // Windows Media Foundation support comes from JUCE built-in format registration.
    formatManager.registerBasicFormats();

    // Deep read-ahead priming avoids JUCE BufferingAudioSource dropping cold samples at play
    // start.
    readAheadThread.startThread();

    // Apply master gain before metering; inject keep-alive after gain so the endpoint floor is
    // volume-independent. Wiring the source graph needs no open device.
    topMixer.addInputSource(&master, false);
    topMixer.addInputSource(&scratchSource, false);
    topMixer.addInputSource(&backingSource, false);
    sourcePlayer.setSource(&masterMeter);
}

juce::String AudioEngine::openAudioDevice(const juce::String& preferredTypeName,
                                          const juce::String& preferredDeviceName,
                                          bool* outFellBackToDefault)
{
    bool fellBack = false;
    const auto err = openAudioDeviceBlocking(preferredTypeName, preferredDeviceName, fellBack);
    if (outFellBackToDefault != nullptr) *outFellBackToDefault = fellBack;
    if (err.isNotEmpty()) return err;
    finaliseAudioDevice(fellBack);
    return {};
}

juce::String AudioEngine::openAudioDeviceBlocking(const juce::String& preferredTypeName,
                                                  const juce::String& preferredDeviceName,
                                                  bool& outFellBack)
{
    const double tOpenStart = juce::Time::getMillisecondCounterHiRes();

    // Single blocking open: a pinned device is opened DIRECTLY (avoids the
    // open-default-then-switch double open); otherwise the system default.
    outFellBack = false;
    juce::String err;
    if (preferredTypeName.isNotEmpty() && preferredDeviceName.isNotEmpty())
    {
        err = selectOutputDeviceBlocking(preferredTypeName, preferredDeviceName);
        if (err.isNotEmpty())
        {
            silverdaw::log::warn("audio",
                                 juce::String("preferred device '") + preferredDeviceName + "' ("
                                     + preferredTypeName + ") not available: " + err
                                     + "; using system default");
            outFellBack = true;
            err = openDefaultOutputOnly();
        }
    }
    else
    {
        err = openDefaultOutputOnly();
    }
    silverdaw::log::info("audio",
                         juce::String("audio device open took ")
                             + juce::String(juce::Time::getMillisecondCounterHiRes() - tOpenStart, 1)
                             + " ms"
                             + (err.isNotEmpty() ? (juce::String(" (error: ") + err + ")") : juce::String{}));
    return err;
}

void AudioEngine::finaliseAudioDevice(bool fellBack)
{
    deviceManager.addAudioCallback(&sourcePlayer);
    deviceManager.addChangeListener(&deviceChangeListener);

    // Avoid full device scans on startup; ASIO probing can block for hundreds of ms.
    rebuildDevicesSnapshot(/*rescan*/ false);
    devicesSnapshot.fellBackToDefault = fellBack;

    // Full device inventory + chosen-endpoint report so a field log shows exactly what the
    // engine saw and opened, without needing a repro.
    for (const auto& t : devicesSnapshot.types)
    {
        silverdaw::log::info("audio",
                             "device type '" + t.typeName + "': "
                                 + juce::String(t.deviceNames.size()) + " output device(s)"
                                 + (t.deviceNames.isEmpty()
                                        ? juce::String{}
                                        : (" [" + t.deviceNames.joinIntoString(", ") + "]")));
    }
    silverdaw::log::info("audio",
                         "open endpoint: type='" + devicesSnapshot.currentTypeName + "' name='"
                             + devicesSnapshot.currentDeviceName
                             + "' sr=" + juce::String(devicesSnapshot.currentSampleRate, 0)
                             + " buffer=" + juce::String(devicesSnapshot.currentBufferSize)
                             + " outCh=" + juce::String(devicesSnapshot.currentOutputChannels)
                             + " bits=" + juce::String(devicesSnapshot.currentBitDepth)
                             + " outLatencyMs=" + juce::String(devicesSnapshot.outputLatencyMs, 1)
                             + (fellBack ? " (fell back to default)" : ""));

    // Publish readiness last so any thread that observes it sees the finalised device state.
    audioReady.store(true, std::memory_order_release);
}

juce::String AudioEngine::openDefaultOutputOnly()
{
    // Request the default output with NO input endpoint: an empty input device plus
    // useDefaultInputChannels=false stops JUCE opening the default capture client,
    // which is the tens-of-seconds stall on a problematic default mic.
    juce::AudioDeviceManager::AudioDeviceSetup outputOnly;
    outputOnly.inputDeviceName = {};
    outputOnly.inputChannels.clear();
    outputOnly.useDefaultInputChannels = false;
    outputOnly.useDefaultOutputChannels = true;
    return deviceManager.initialise(/*numInputChannelsNeeded*/ 0,
                                    /*numOutputChannelsNeeded*/ 2,
                                    /*savedState*/ nullptr,
                                    /*selectDefaultDeviceOnFailure*/ true,
                                    /*preferredDefaultDeviceName*/ {},
                                    /*preferredSetupOptions*/ &outputOnly);
}

void AudioEngine::shutdown()
{
    rebuildTimer.stopTimer();
    trackBypassTimer.stopTimer();
    pendingTrackBypasses.clear();
    stop();
    unloadPreview();
    deviceManager.removeChangeListener(&deviceChangeListener);
    deviceManager.removeAudioCallback(&sourcePlayer);
    sourcePlayer.setSource(nullptr);
    topMixer.removeAllInputs();
    busGraph.clear();
    automationCurrent.clear();
    retiredAutomation.clear();
    tracks.clear();
    trackAudibility.clear();
    deviceManager.closeAudioDevice();
    readAheadThread.stopThread(1000);
}

void AudioEngine::refreshAudioDevices()
{
    rebuildDevicesSnapshot(/*rescan*/ true);
}

juce::String AudioEngine::selectOutputDevice(const juce::String& typeName, const juce::String& deviceName)
{
    const bool needsInitialisation = ! isAudioReady();
    const auto err = selectOutputDeviceBlocking(typeName, deviceName);
    if (err.isEmpty() && needsInitialisation)
    {
        finaliseAudioDevice(/*fellBack*/ false);
    }
    return err;
}

juce::String AudioEngine::selectOutputDeviceBlocking(const juce::String& typeName,
                                                      const juce::String& deviceName)
{
    if (typeName.isEmpty() && deviceName.isEmpty())
    {
        const auto err = openDefaultOutputOnly();
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
        // Output-only: never open a capture endpoint (see openDefaultOutputOnly()).
        setup.inputDeviceName = {};
        setup.inputChannels.clear();
        setup.useDefaultInputChannels = false;
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
        snap.currentOutputChannels = dev->getActiveOutputChannels().countNumberOfSetBits();
        snap.currentBitDepth = dev->getCurrentBitDepth();
    }
    snap.outputLatencyMs = getOutputLatencyMs();
    snap.heuristicExtraLatencyMs = getHeuristicExtraLatencyMs();
    snap.fellBackToDefault = devicesSnapshot.fellBackToDefault;
    devicesSnapshot = std::move(snap);
}

void AudioEngine::setKeepAwakeEnabled(bool enabled)
{
    // Keep-awake is an explicit per-device user choice (default off): when enabled, the
    // keep-alive dither + first-play wake keep a sleep-prone USB output from clipping the
    // first beat. The renderer resolves the open device's setting and pushes it here.
    outputKeepAlive.setKeepAwakeEnabled(enabled);
    silverdaw::log::info("audio",
                         juce::String("keep-awake ") + (enabled ? "on" : "off"));
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
        openDefaultOutputOnly();
        rebuildDevicesSnapshot(/*rescan*/ false);
    }

    if (deviceListChangedCallback)
    {
        deviceListChangedCallback();
    }
}

} // namespace silverdaw
