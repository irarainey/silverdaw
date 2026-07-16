#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class BridgeServer;
class AudioEngine;

// Builds the MIDI_DEVICES_LIST envelope from the current MIDI input devices.
juce::var buildMidiDevicesListEnvelope();

// Enumerates connected MIDI input devices and broadcasts MIDI_DEVICES_LIST.
void handleMidiDevicesRequest(BridgeServer& bridge);

// Opens exactly the requested connected MIDI inputs, then broadcasts their state.
void handleMidiInputsSet(const juce::var& payload, BridgeServer& bridge);
void handleMidiDeckSelectionSet(const juce::var& payload, BridgeServer& bridge);
void handleMidiScratchSettingsSet(const juce::var& payload);
void setMidiScratchEngine(AudioEngine& engine);

// Mirrors the selected track peak to supported enabled controller channel meters.
void sendMidiSelectedTrackMeter(float peakL, float peakR, bool playing);
void sendMidiTransportPlaying(bool playing);
void sendMidiMarkerLights(bool cueActive, int markerCount);

} // namespace silverdaw
