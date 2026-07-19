#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;

// Shared FX changes persist canonical values before gliding the live bus.

void handleProjectSetReverb(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                            BridgeServer& bridge);
void handleProjectSetDelay(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                           BridgeServer& bridge);
void handleProjectSetMixGlue(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                             BridgeServer& bridge);

} // namespace silverdaw
