#pragma once

#include "MidiControllerMapping.h"
#include "scratch/ScratchProtocol.h"

#include <juce_core/juce_core.h>

#include <map>

namespace silverdaw
{

class AudioEngine;
class BridgeServer;

// Per-device scratch routing state; stored inline in ActiveMidiInput.
struct MidiScratchDeviceState
{
    bool touchPressed[2]{false, false};
    juce::int64 movementReleaseDeadlineMs[2]{0, 0};
    bool reverseCrossfader = false;
    // True when the controller has a capacitive platter (jog-touch binding). When
    // set, touch state is authoritative: jog movement received while the platter
    // is not touched (a lift-off nudge or pitch-bend) is ignored so it cannot
    // re-claim the deck or re-arm the movement-release deadline.
    bool hasJogTouch = false;
    // Relative ticks that equal one physical platter revolution for scratch.
    // Set from the controller profile; defaults to 512 (ordinary 7-bit relative).
    int scratchTicksPerTurn = 512;
};

// Encapsulates scratch-specific MIDI routing logic and shared state, extracted
// from MidiInputMonitor so device monitoring and scratch semantics stay independent.
class MidiScratchRouter
{
public:
    void setEngine(AudioEngine& engine);

    // Store a crossfader direction preference for a device.
    void setSetting(const juce::String& identifier, bool reverseCrossfader);
    // Returns the stored direction for a device, or false if not set.
    bool lookupReverseCrossfader(const juce::String& identifier) const;

    // Release all scratch ownership held by a device (e.g. on device close).
    void releaseAllOwners(const juce::String& identifier);
    // Release scratch ownership for one deck (e.g. on deck disable).
    void releaseDeckOwner(const juce::String& identifier, scratch::DeckSide deck);

    // Route an absolute/button event to the scratch engine.
    void routeImmediate(const juce::String& identifier,
                        MidiScratchDeviceState& state,
                        juce::int64 timestampMs,
                        const MidiControllerEvent& event,
                        BridgeServer* bridge);

    // Route a relative (platter movement) event to the scratch engine.
    // const-qualified so it can be called from a const MidiInputMonitor context;
    // mutates state through the non-const ref parameter only.
    void routeRelative(const juce::String& identifier,
                       MidiScratchDeviceState& state,
                       juce::int64 timestampMs,
                       const MidiControllerEvent& event) const;

    // Release movement-only ownership whose idle deadline has passed.
    void checkExpiredOwners(const juce::String& identifier,
                            MidiScratchDeviceState& state,
                            juce::int64 nowMs,
                            BridgeServer* bridge);

    AudioEngine* engine() const { return scratchEngine; }

private:
    AudioEngine* scratchEngine = nullptr;
    std::map<juce::String, bool> crossfaderDirections;
};

} // namespace silverdaw
