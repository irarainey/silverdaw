#pragma once

#include "ProjectSession.h"

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;
class DecodedCache;

// Project lifecycle handlers own file I/O; snapshot/rebuild helpers stay in ProjectSession.

void handleProjectNew(AudioEngine& engine, ProjectState& projectState, BridgeServer& bridge,
                      ProjectSession& session);
void handleProjectLoad(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                       BridgeServer& bridge, ProjectSession& session, juce::ThreadPool& peakPool,
                       const DecodedCache& decodedCache);
void handleProjectSave(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                       BridgeServer& bridge, ProjectSession& session, bool isSaveAs,
                       juce::ThreadPool& peakPool, const DecodedCache& decodedCache);
void handleProjectSaveViewState(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                                BridgeServer& bridge, const ProjectSession& session);
void handleProjectRename(const juce::var& payload, ProjectState& projectState, BridgeServer& bridge);
void handleProjectAutosave(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                           BridgeServer& bridge);
void handleProjectLoadRecovery(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                               BridgeServer& bridge, ProjectSession& session, juce::ThreadPool& peakPool,
                               const DecodedCache& decodedCache);
void handleProjectImportSourceInspect(const juce::var& payload, ProjectState& projectState,
                                      BridgeServer& bridge, const ProjectSession& session);
void handleProjectImportAssets(const juce::var& payload, ProjectState& projectState,
                               BridgeServer& bridge, const ProjectSession& session);

} // namespace silverdaw
