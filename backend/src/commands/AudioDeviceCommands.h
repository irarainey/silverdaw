#pragma once

#include "AudioEngine.h"

#include <juce_core/juce_core.h>

namespace silverdaw
{

class BridgeServer;
class DecodedCache;

// Dispatcher and JUCE hotplug callback share device-list broadcasting here.

juce::var buildAudioDevicesListEnvelope(const AudioEngine::AudioDevicesSnapshot& snap,
                                        bool scanInProgress = false);

// `dedupe` suppresses duplicate spontaneous hotplug notifications.
void broadcastAudioDevicesList(BridgeServer& bridge, const juce::var& envelope, bool dedupe);

void handleAudioDevicesRequest(const juce::var& payload, AudioEngine& engine, BridgeServer& bridge);
void handleAudioDeviceSelect(const juce::var& payload, AudioEngine& engine, BridgeServer& bridge);
void handleAudioKeepAwakeSet(const juce::var& payload, AudioEngine& engine);
void handleSetBrakeSettings(const juce::var& payload, AudioEngine& engine);
void handleSetBackspinSettings(const juce::var& payload, AudioEngine& engine);
void handleScratchRealismSet(const juce::var& payload, AudioEngine& engine);

// Reader construction runs on `peakPool` so transport ticks keep draining.
// MP3 is probed through `decodedCache`, because JUCE's MP3 reader mis-sizes some
// files and would report a wrong duration (ADR 0029).
void handleAudioFileProbe(const juce::var& payload, AudioEngine& engine, BridgeServer& bridge,
                          juce::ThreadPool& peakPool, const DecodedCache& decodedCache);

} // namespace silverdaw
