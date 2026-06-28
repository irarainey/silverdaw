#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;

// View settings stay dirty-suppressed; project edits remain undoable.

void handleProjectSetView(const juce::var& payload, ProjectState& projectState);
void handleProjectSetBpm(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                         BridgeServer& bridge);
void handleProjectSetLength(const juce::var& payload, ProjectState& projectState);
void handleProjectSetAudioOutput(const juce::var& payload, ProjectState& projectState);
void handleProjectSetTargetSampleRate(const juce::var& payload, ProjectState& projectState);
void handleProjectSetExportSettings(const juce::var& payload, ProjectState& projectState);
void handleProjectSetMasterVolume(const juce::var& payload, AudioEngine& engine, ProjectState& projectState);
void handleProjectSetBarCounterStart(const juce::var& payload, ProjectState& projectState);
void handleProjectSetMixdownStartBar(const juce::var& payload, ProjectState& projectState);
void handleProjectSetMetronome(const juce::var& payload, AudioEngine& engine, ProjectState& projectState);

} // namespace silverdaw
