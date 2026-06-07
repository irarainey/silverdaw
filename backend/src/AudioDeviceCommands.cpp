#include "AudioDeviceCommands.h"

#include "BridgeServer.h"
#include "Log.h"

#include <juce_events/juce_events.h>

namespace silverdaw
{

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

// AUDIO_DEVICES_LIST broadcasts come from two kinds of source:
//   - Direct responses to AUDIO_DEVICES_REQUEST (and the deferred
//     first-scan completion). Always sent: the renderer is waiting for
//     an answer, including on reconnect.
//   - Spontaneous `audioDeviceListChanged` notifications. Deduped against
//     the last list we sent, so the change message that our own deferred
//     startup scan triggers — JUCE dispatches it asynchronously, after
//     the deferred response already shipped the identical list — doesn't
//     reach the renderer a redundant second time.
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
    // The first scan after boot is the slow step (100–400 ms, dominated
    // by ASIO/Bluetooth driver probing). Audio devices rarely change
    // between launches, so we don't want to block the message thread
    // for it during the renderer's startup window.
    //
    //   - Explicit "Rescan devices" (`refresh: true`): synchronous —
    //     the user is waiting and expects the freshest list.
    //   - Already scanned: just broadcast the cached snapshot.
    //   - First request after boot, no explicit refresh: broadcast
    //     whatever the engine already has (current device + its type,
    //     populated by `initialise()`), then defer the full scan via
    //     `MessageManager::callAsync`. The bridge ships the initial
    //     response before the slow scan runs, and the UI updates a
    //     beat later when the deferred scan broadcasts the full list.
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
    // The fallback notice is one-shot: surface it on this first response,
    // then clear it so the deferred scan below (and later hotplug
    // broadcasts) don't re-warn about the same startup fallback.
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
    // Nullable fields: both null = revert to system default.
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

    // No explicit `AUDIO_DEVICES_LIST` broadcast here: a successful
    // `setAudioDeviceSetup` fires JUCE's `audioDeviceListChanged`
    // callback, which the engine forwards to the renderer via
    // `setDeviceListChangedCallback` (wired up in `runBackend`).
    // Avoiding the duplicate keeps the round-trip lean on a switch.

    silverdaw::log::info("audio",
                         juce::String("device select type=") + typeName + " name=" + deviceName +
                             (err.isEmpty() ? " ok" : " fail: " + err));
}

} // namespace silverdaw