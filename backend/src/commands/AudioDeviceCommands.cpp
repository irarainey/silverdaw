#include "AudioDeviceCommands.h"

#include "BridgeServer.h"
#include "Log.h"
#include "PayloadHelpers.h"

#include <memory>

#include <juce_events/juce_events.h>

namespace silverdaw
{

using silverdaw::bridge::tryGetRequiredString;

juce::var buildAudioDevicesListEnvelope(const silverdaw::AudioEngine::AudioDevicesSnapshot& snap,
                                        bool scanInProgress)
{
    auto* obj = new juce::DynamicObject();
    juce::Array<juce::var> types;
    for (const auto& t : snap.types)
    {
        auto* typeObj = new juce::DynamicObject();
        typeObj->setProperty("name", t.typeName);
        juce::Array<juce::var> devices;
        for (const auto& d : t.deviceNames)
        {
            devices.add(d);
        }
        typeObj->setProperty("devices", juce::var(devices));
        types.add(juce::var(typeObj));
    }
    obj->setProperty("types", juce::var(types));
    obj->setProperty("currentTypeName", snap.currentTypeName.isEmpty() ? juce::var() : juce::var(snap.currentTypeName));
    obj->setProperty("currentDeviceName",
                     snap.currentDeviceName.isEmpty() ? juce::var() : juce::var(snap.currentDeviceName));
    if (snap.currentSampleRate > 0.0)
    {
        obj->setProperty("currentSampleRate", snap.currentSampleRate);
    }
    if (snap.currentBufferSize > 0)
    {
        obj->setProperty("currentBufferSize", snap.currentBufferSize);
    }
    if (snap.outputLatencyMs > 0.0)
    {
        obj->setProperty("outputLatencyMs", snap.outputLatencyMs);
    }
    if (snap.heuristicExtraLatencyMs > 0.0)
    {
        obj->setProperty("heuristicExtraLatencyMs", snap.heuristicExtraLatencyMs);
    }
    if (snap.fellBackToDefault)
    {
        obj->setProperty("fellBackToDefault", true);
    }
    if (scanInProgress)
    {
        obj->setProperty("scanInProgress", true);
    }
    return juce::var(obj);
}

// Dedupes spontaneous JUCE hotplug callbacks after the deferred startup scan.
void broadcastAudioDevicesList(silverdaw::BridgeServer& bridge, const juce::var& envelope, bool dedupe)
{
    static juce::String lastSentJson;
    const auto json = juce::JSON::toString(envelope, true);
    if (dedupe && json == lastSentJson)
    {
        return;
    }
    lastSentJson = json;
    bridge.broadcast("AUDIO_DEVICES_LIST", envelope);
}

void handleAudioDevicesRequest(const juce::var& payload, silverdaw::AudioEngine& engine,
                               silverdaw::BridgeServer& bridge)
{
    const bool refresh = static_cast<bool>(payload.getProperty("refresh", false));
    // First full device scan can block startup, so defer it unless explicitly requested.
    if (refresh)
    {
        engine.refreshAudioDevices();
        broadcastAudioDevicesList(bridge, buildAudioDevicesListEnvelope(engine.getAudioDevicesSnapshot()),
                                  /*dedupe*/ false);
        return;
    }

    const bool needsFirstScan = !engine.hasScannedAllDevices();
    broadcastAudioDevicesList(bridge,
                              buildAudioDevicesListEnvelope(engine.getAudioDevicesSnapshot(),
                                                            /*scanInProgress*/ needsFirstScan),
                              /*dedupe*/ false);
    // Fallback notice is one-shot; later scans must not re-warn.
    engine.clearFellBackToDefault();

    if (needsFirstScan)
    {
        juce::MessageManager::callAsync(
            [enginePtr = &engine, bridgePtr = &bridge]()
            {
                enginePtr->refreshAudioDevices();
                broadcastAudioDevicesList(
                    *bridgePtr, buildAudioDevicesListEnvelope(enginePtr->getAudioDevicesSnapshot()),
                    /*dedupe*/ false);
            });
    }
}

void handleAudioDeviceSelect(const juce::var& payload, silverdaw::AudioEngine& engine,
                             silverdaw::BridgeServer& bridge)
{
    // Both null reverts to system default.
    const auto typeVar = payload.getProperty("typeName", juce::var());
    const auto deviceVar = payload.getProperty("deviceName", juce::var());
    const juce::String typeName = typeVar.isString() ? typeVar.toString() : juce::String();
    const juce::String deviceName = deviceVar.isString() ? deviceVar.toString() : juce::String();

    const auto err = engine.selectOutputDevice(typeName, deviceName);

    auto* p = new juce::DynamicObject();
    p->setProperty("typeName", typeName.isEmpty() ? juce::var() : juce::var(typeName));
    p->setProperty("deviceName", deviceName.isEmpty() ? juce::var() : juce::var(deviceName));
    p->setProperty("ok", err.isEmpty());
    if (err.isNotEmpty()) p->setProperty("error", err);
    bridge.broadcast("AUDIO_DEVICE_CHANGED", juce::var(p));

    if (err.isEmpty())
    {
        broadcastAudioDevicesList(bridge,
                                  buildAudioDevicesListEnvelope(engine.getAudioDevicesSnapshot()),
                                  /*dedupe*/ true);
    }

    auto* status = new juce::DynamicObject();
    status->setProperty("state", engine.isAudioReady() ? "ready" : "no_device");
    bridge.broadcast("ENGINE_AUDIO_STATUS", juce::var(status));

    // JUCE fires `audioDeviceListChanged` after a successful switch.

    silverdaw::log::info("audio",
                         juce::String("device select type=") + typeName + " name=" + deviceName +
                             (err.isEmpty() ? " ok" : " fail: " + err));
}

void handleAudioKeepAwakeSet(const juce::var& payload, silverdaw::AudioEngine& engine)
{
    const bool enabled = static_cast<bool>(payload.getProperty("enabled", false));
    engine.setKeepAwakeEnabled(enabled);
    silverdaw::log::info("audio", juce::String("keep-awake set to ") + (enabled ? "on" : "off"));
}

void handleSetBrakeSettings(const juce::var& payload, silverdaw::AudioEngine& engine)
{
    const double seconds =
        static_cast<double>(payload.getProperty("seconds", BrakeSnapshot::kPlatterStopSeconds));
    const double curve =
        static_cast<double>(payload.getProperty("curve", BrakeSnapshot::kDefaultCurvePower));
    const auto message = juce::String("recv BRAKE_SETTINGS_SET seconds=") + juce::String(seconds, 3) +
                         " curve=" + juce::String(curve, 3);
    silverdaw::log::info("bridge", message);
    engine.setBrakeDefaults(seconds, curve);
}

void handleSetBackspinSettings(const juce::var& payload, silverdaw::AudioEngine& engine)
{
    const double seconds =
        static_cast<double>(payload.getProperty("seconds", BackspinSnapshot::kDefaultSpinSeconds));
    const double speed =
        static_cast<double>(payload.getProperty("speed", BackspinSnapshot::kDefaultSpinSpeed));
    const double curve =
        static_cast<double>(payload.getProperty("curve", BackspinSnapshot::kDefaultCurvePower));
    const auto message = juce::String("recv BACKSPIN_SETTINGS_SET seconds=") +
                         juce::String(seconds, 3) +
                         " speed=" + juce::String(speed, 3) +
                         " curve=" + juce::String(curve, 3);
    silverdaw::log::info("bridge", message);
    engine.setBackspinDefaults(seconds, speed, curve);
}

void handleScratchRealismSet(const juce::var& payload, silverdaw::AudioEngine& engine)
{
    const auto level = payload.getProperty("level", juce::var()).toString();
    if (level == "off")
        engine.setScratchRealismLevel(scratch::ScratchRealismLevel::off);
    else if (level == "medium")
        engine.setScratchRealismLevel(scratch::ScratchRealismLevel::medium);
    else if (level == "high")
        engine.setScratchRealismLevel(scratch::ScratchRealismLevel::high);
    else
        return;

    silverdaw::log::info("bridge", "recv SCRATCH_REALISM_SET level=" + level);
}

void handleAudioFileProbe(const juce::var& payload, silverdaw::AudioEngine& engine,
                          silverdaw::BridgeServer& bridge, juce::ThreadPool& peakPool)
{
    // `requestId` round-trips so batched import probes don't collide.
    const auto requestId = tryGetRequiredString(payload, "requestId").value_or(juce::String{});
    const auto filePath = tryGetRequiredString(payload, "filePath").value_or(juce::String{});
    if (requestId.isEmpty() || filePath.isEmpty())
    {
        silverdaw::log::warn("bridge", "AUDIO_FILE_PROBE missing requestId/filePath");
        return;
    }

    silverdaw::log::debug("bridge", "recv AUDIO_FILE_PROBE id=" + requestId + " path=" + filePath);
    // Reader construction stays off the message thread to keep 60 Hz transport ticks draining.
    peakPool.addJob([requestId, filePath, &engine, &bridge]() {
        const juce::File file(filePath);
        std::unique_ptr<juce::AudioFormatReader> reader(
            engine.getFormatManager().createReaderFor(file));
        juce::MessageManager::callAsync([requestId, filePath, &bridge,
                                         reader = std::shared_ptr<juce::AudioFormatReader>(std::move(reader))]() {
            auto* obj = new juce::DynamicObject();
            obj->setProperty("requestId", requestId);
            obj->setProperty("filePath", filePath);
            if (reader && reader->sampleRate > 0.0 && reader->lengthInSamples > 0)
            {
                obj->setProperty("ok", true);
                obj->setProperty("sampleRate", static_cast<int>(reader->sampleRate));
                obj->setProperty("channelCount", static_cast<int>(reader->numChannels));
                obj->setProperty(
                    "durationMs",
                    (static_cast<double>(reader->lengthInSamples) / reader->sampleRate) * 1000.0);
                silverdaw::log::info(
                    "bridge",
                    "probe ok id=" + requestId + " path=" + filePath
                        + " sampleRate=" + juce::String(static_cast<int>(reader->sampleRate))
                        + "Hz ch=" + juce::String(static_cast<int>(reader->numChannels))
                        + " lengthSamples=" + juce::String(reader->lengthInSamples));
            }
            else
            {
                obj->setProperty("ok", false);
                obj->setProperty("error",
                                 juce::String("could not decode header for ") + filePath);
                silverdaw::log::warn(
                    "bridge",
                    "probe fail id=" + requestId + " path=" + filePath
                        + " (reader=" + juce::String(reader ? "ok" : "null") + ")");
            }
            bridge.broadcast("AUDIO_FILE_PROBED", juce::var(obj));
        });
    });
}

} // namespace silverdaw