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

// Root of the per-session temporary workspace for an unsaved project's generated
// artifacts (separated stems, exported samples). Everything beneath it is
// discarded when the project is saved or a new project is started.
juce::File tempArtifactsRoot();

// Base directory for a generated-artifact category (e.g. "stems", "samples"):
// <projectDir>/<subdir> once the project is saved, else the temp workspace so
// unsaved work never lands outside the disposable temp area.
juce::File projectArtifactsBaseDir(const juce::String& projectPath, const juce::String& subdir);

// Relocate an unsaved project's temporary generated artifacts into its newly
// saved folder: move the temp Stems/Samples trees beside the project file,
// rewrite the project's absolute paths to the new locations, rebuild the engine
// from those paths, and purge the temp workspace. No-op when the temp workspace
// holds no artifacts. Call before serialising on the first save.
void migrateTempArtifactsIntoProject(const juce::String& projectFilePath, AudioEngine& engine,
                                     ProjectState& projectState, juce::ThreadPool& peakPool,
                                     const DecodedCache& decodedCache);

// `reset` tells the renderer to discard optimistic local state before applying this snapshot.
juce::var buildProjectStateEnvelope(const ProjectSession& session, const ProjectState& projectState, bool reset);

// Undo/redo uses softReplace to reconcile removed entities without resetting renderer-local state.
juce::var buildSoftReplaceProjectStateEnvelope(const ProjectSession& session, ProjectState& projectState);

// Caller must drop existing engine clips before rebuilding from project state.
void rebuildEngineFromProject(AudioEngine& engine, ProjectState& projectState,
                              juce::ThreadPool& peakPool, const DecodedCache& decodedCache);

} // namespace silverdaw
