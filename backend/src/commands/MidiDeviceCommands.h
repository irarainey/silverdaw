#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class BridgeServer;

// Builds the MIDI_DEVICES_LIST envelope from the current MIDI input devices.
juce::var buildMidiDevicesListEnvelope();

// Enumerates connected MIDI input devices and broadcasts MIDI_DEVICES_LIST.
void handleMidiDevicesRequest(BridgeServer& bridge);

// Opens exactly the requested connected MIDI inputs, then broadcasts their state.
void handleMidiInputsSet(const juce::var& payload, BridgeServer& bridge);

} // namespace silverdaw
