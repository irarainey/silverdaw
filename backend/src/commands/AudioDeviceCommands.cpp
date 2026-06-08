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

void handleAudioFileProbe(const juce::var& payload, silverdaw::AudioEngine& engine,
                          silverdaw::BridgeServer& bridge, juce::ThreadPool& peakPool)
{
    // Synchronous-ish file-rate probe used by the renderer's import
    // flow to decide whether to prompt about a sample-rate
    // mismatch. Opens the file via the existing AudioFormatManager,
    // reads the header (sample rate / channel count / total length),
    // acks via `AUDIO_FILE_PROBED`. `requestId` round-trips so
    // concurrent probes from a batched import don't collide.
    const auto requestId = tryGetRequiredString(payload, "requestId").value_or(juce::String{});
    const auto filePath = tryGetRequiredString(payload, "filePath").value_or(juce::String{});
    if (requestId.isEmpty() || filePath.isEmpty())
    {
        silverdaw::log::warn("bridge", "AUDIO_FILE_PROBE missing requestId/filePath");
        return;
    }

    silverdaw::log::debug("bridge", "recv AUDIO_FILE_PROBE id=" + requestId + " path=" + filePath);
    // Heavy work (reader construction; on Windows the JUCE
    // codec call can take a few ms for compressed formats) is
    // dispatched onto the existing peak-pool so the message
    // thread keeps draining 60 Hz transport ticks.
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