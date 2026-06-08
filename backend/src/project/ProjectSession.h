#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class DecodedCache;

/**
 * Per-process project-lifecycle state. Owned by `runBackend`, captured by
 * reference into every project-mutating handler. `currentPath` is empty
 * for a project that has never been saved (the renderer shows the name
 * "Untitled" alongside).
 */
struct ProjectSession
{
    juce::String currentPath;
};

/** Walk every clip in `projectState` and gather their ids in tree order. */
juce::StringArray collectClipIds(const ProjectState& projectState);

/**
 * Build the PROJECT_STATE envelope payload. `reset` is added (as `true`)
 * when the snapshot is a hard replacement (PROJECT_NEW / PROJECT_LOAD)
 * so the renderer wipes optimistic local state first; on the connect
 * path the snapshot is purely additive and `reset` is omitted.
 */
juce::var buildProjectStateEnvelope(const ProjectSession& session, const ProjectState& projectState, bool reset);

/**
 * Build a PROJECT_STATE envelope with the `softReplace` flag set — used by
 * undo / redo to authoritatively reconcile the renderer's mirror (so removed
 * tracks/clips actually vanish) without rotating projectId, marking clean, or
 * clearing the renderer's clipboard / selection. The dirty state is
 * communicated separately via a follow-up PROJECT_DIRTY broadcast.
 */
juce::var buildSoftReplaceProjectStateEnvelope(const ProjectSession& session, ProjectState& projectState);

/**
 * Replace the engine's playable sources with one per clip described in
 * `projectState`. Caller is responsible for first dropping every clip the
 * engine currently holds — `handleProjectLoad` / `handleProjectNew` do that
 * immediately before invoking this.
 */
void rebuildEngineFromProject(AudioEngine& engine, ProjectState& projectState,
                              juce::ThreadPool& peakPool, const DecodedCache& decodedCache);

} // namespace silverdaw
