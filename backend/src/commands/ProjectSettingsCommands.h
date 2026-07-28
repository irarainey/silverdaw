#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;

// View settings stay dirty-suppressed; project edits remain undoable.

void handleProjectSetView(const juce::var& payload, AudioEngine& engine, ProjectState& projectState);

/** Arms the engine's transport loop from the stored timeline-selection view state. Call
 *  after anything that changes that state (a view command, a project load) so the engine's
 *  loop range never drifts from the project's. */
void syncTimelineLoop(AudioEngine& engine, const ProjectState& projectState);
void handleProjectSetBpm(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                         BridgeServer& bridge);
void handleProjectSetLength(const juce::var& payload, ProjectState& projectState);
void handleProjectSetAudioOutput(const juce::var& payload, ProjectState& projectState);
void handleProjectSetTargetSampleRate(const juce::var& payload, ProjectState& projectState);
void handleProjectSetExportSettings(const juce::var& payload, ProjectState& projectState);
void handleProjectSetMasterVolume(const juce::var& payload, AudioEngine& engine, ProjectState& projectState);
void handleProjectSetSafetyLimiter(const juce::var& payload, AudioEngine& engine,
                                   ProjectState& projectState);
void handleProjectSetBarCounterStart(const juce::var& payload, ProjectState& projectState);
void handleProjectSetMixdownStartBar(const juce::var& payload, ProjectState& projectState);
void handleProjectSetMetronome(const juce::var& payload, AudioEngine& engine, ProjectState& projectState);

// App-level preference (default on): whether the first clip seeds the project tempo.
void handleSetSeedProjectTempoPref(const juce::var& payload, ProjectState& projectState);

} // namespace silverdaw
