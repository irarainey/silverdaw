#pragma once

#include "AudioEngine.h"

#include <juce_core/juce_core.h>

namespace silverdaw
{

class BridgeServer;

// Dispatcher and JUCE hotplug callback share device-list broadcasting here.

juce::var buildAudioDevicesListEnvelope(const AudioEngine::AudioDevicesSnapshot& snap,
                                        bool scanInProgress = false);

// `dedupe` suppresses duplicate spontaneous hotplug notifications.
void broadcastAudioDevicesList(BridgeServer& bridge, const juce::var& envelope, bool dedupe);

void handleAudioDevicesRequest(const juce::var& payload, AudioEngine& engine, BridgeServer& bridge);
void handleAudioDeviceSelect(const juce::var& payload, AudioEngine& engine, BridgeServer& bridge);
void handleAudioKeepAwakeSet(const juce::var& payload, AudioEngine& engine);

// Reader construction runs on `peakPool` so transport ticks keep draining.
void handleAudioFileProbe(const juce::var& payload, AudioEngine& engine, BridgeServer& bridge,
                          juce::ThreadPool& peakPool);

} // namespace silverdaw
