#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;

// Project-wide settings command handlers. Each applies one PROJECT_SET_*
// envelope to the project tree (some also push the change live to the
// engine). View preferences are dirty-suppressed; tempo / length /
// master-volume edits flip the dirty flag and are undoable.

void handleProjectSetView(const juce::var& payload, ProjectState& projectState);
void handleProjectSetBpm(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                         BridgeServer& bridge);
void handleProjectSetLength(const juce::var& payload, ProjectState& projectState);
void handleProjectSetAudioOutput(const juce::var& payload, ProjectState& projectState);
void handleProjectSetTargetSampleRate(const juce::var& payload, ProjectState& projectState);
void handleProjectSetExportSettings(const juce::var& payload, ProjectState& projectState);
void handleProjectSetMasterVolume(const juce::var& payload, AudioEngine& engine, ProjectState& projectState);

} // namespace silverdaw
