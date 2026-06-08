#pragma once

#include "ProjectSession.h"

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;
class DecodedCache;

// Project-lifecycle command handlers — new / load / save / save-as /
// view-state save / rename / autosave / crash-recovery load, plus
// library-item relink. Each owns its ProjectFile I/O + PROJECT_STATE
// (or PROJECT_*) broadcast; the shared snapshot/rebuild helpers live in
// ProjectSession.

void handleLibraryItemRelink(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                             BridgeServer& bridge, const ProjectSession& session, juce::ThreadPool& peakPool,
                             const DecodedCache& decodedCache);
void handleProjectNew(AudioEngine& engine, ProjectState& projectState, BridgeServer& bridge,
                      ProjectSession& session);
void handleProjectLoad(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                       BridgeServer& bridge, ProjectSession& session, juce::ThreadPool& peakPool,
                       const DecodedCache& decodedCache);
void handleProjectSave(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                       BridgeServer& bridge, ProjectSession& session, bool isSaveAs);
void handleProjectSaveViewState(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                                BridgeServer& bridge, const ProjectSession& session);
void handleProjectRename(const juce::var& payload, ProjectState& projectState, BridgeServer& bridge);
void handleProjectAutosave(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                           BridgeServer& bridge);
void handleProjectLoadRecovery(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                               BridgeServer& bridge, ProjectSession& session, juce::ThreadPool& peakPool,
                               const DecodedCache& decodedCache);

} // namespace silverdaw
