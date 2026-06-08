#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;

// TRANSPORT_* command handlers — project (timeline) playback. Kept out of the
// Main.cpp dispatcher; each drives the engine's main transport and keeps the
// persisted playhead in step.

// `mixdownInProgress` gates playback so transport can't audibly start mid-render.
void handleTransportPlay(AudioEngine& engine, bool mixdownInProgress);
void handleTransportPause(AudioEngine& engine);
void handleTransportStop(AudioEngine& engine, ProjectState& projectState);
void handleTransportSeek(const juce::var& payload, AudioEngine& engine, ProjectState& projectState);

} // namespace silverdaw
