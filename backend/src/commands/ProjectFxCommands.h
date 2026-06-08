#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;

// Project-shared FX send-bus commands (Reverb / Delay). Extracted from Main.cpp
// so the dispatcher only routes to them. Each reads a partial-update envelope,
// persists the canonical values to ProjectState, glides the live engine bus, and
// acks the stored shape.

void handleProjectSetReverb(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                            BridgeServer& bridge);
void handleProjectSetDelay(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                           BridgeServer& bridge);

} // namespace silverdaw
