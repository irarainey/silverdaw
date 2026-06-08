#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class DecodedCache;

// Per-process project path state; empty means the project has never been saved.
struct ProjectSession
{
    juce::String currentPath;
};

juce::StringArray collectClipIds(const ProjectState& projectState);

// `reset` tells the renderer to discard optimistic local state before applying this snapshot.
juce::var buildProjectStateEnvelope(const ProjectSession& session, const ProjectState& projectState, bool reset);

// Undo/redo uses softReplace to reconcile removed entities without resetting renderer-local state.
juce::var buildSoftReplaceProjectStateEnvelope(const ProjectSession& session, ProjectState& projectState);

// Caller must drop existing engine clips before rebuilding from project state.
void rebuildEngineFromProject(AudioEngine& engine, ProjectState& projectState,
                              juce::ThreadPool& peakPool, const DecodedCache& decodedCache);

} // namespace silverdaw
