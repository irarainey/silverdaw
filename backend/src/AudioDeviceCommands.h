#pragma once

#include "AudioEngine.h"

#include <juce_core/juce_core.h>

namespace silverdaw
{

class BridgeServer;

// Audio output device control. Extracted from Main.cpp so the dispatcher and the
// JUCE `audioDeviceListChanged` hotplug callback in runBackend share one place
// for building and broadcasting the device list.
//
// Renderer-facing envelopes:
//   AUDIO_DEVICES_REQUEST { refresh? }   → AUDIO_DEVICES_LIST
//   AUDIO_DEVICE_SELECT   { typeName, deviceName }
//                                        → AUDIO_DEVICE_CHANGED (+ list on ok)

/** Serialise a device snapshot into the AUDIO_DEVICES_LIST envelope shape. */
juce::var buildAudioDevicesListEnvelope(const AudioEngine::AudioDevicesSnapshot& snap,
                                        bool scanInProgress = false);

/** Broadcast an AUDIO_DEVICES_LIST envelope. `dedupe` suppresses a spontaneous
 *  hotplug notification identical to the last list already sent. */
void broadcastAudioDevicesList(BridgeServer& bridge, const juce::var& envelope, bool dedupe);

void handleAudioDevicesRequest(const juce::var& payload, AudioEngine& engine, BridgeServer& bridge);
void handleAudioDeviceSelect(const juce::var& payload, AudioEngine& engine, BridgeServer& bridge);

// File-header probe used by the renderer's import flow to detect a
// sample-rate mismatch before adding a clip. Reader construction runs on
// `peakPool` so the message thread keeps draining transport ticks; the
// result acks via AUDIO_FILE_PROBED with the round-tripped `requestId`.
void handleAudioFileProbe(const juce::var& payload, AudioEngine& engine, BridgeServer& bridge,
                          juce::ThreadPool& peakPool);

} // namespace silverdaw
