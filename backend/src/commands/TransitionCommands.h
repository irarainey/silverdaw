#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class BridgeServer;
class ProjectState;
struct ProjectSession;

// Transition edits run inside the dispatcher's open undo transaction.

// The backend mints transition ids to avoid caller-chosen collisions.
bool applyTransitionCreate(const juce::var& payload, ProjectState& projectState);

bool applyTransitionDelete(const juce::var& payload, ProjectState& projectState);

bool applyTransitionSetRecipe(const juce::var& payload, ProjectState& projectState);

// PROJECT_STATE is the transition-edit ack, even for rejected edits.
void finishTransitionEdit(AudioEngine& engine, ProjectState& projectState, BridgeServer& bridge,
                          ProjectSession& session);

// Undo, redo, and load reconcile separately via rebuildEngineFromProject.
bool transitionGeometryMayHaveChanged(const juce::String& type) noexcept;

// Avoid full PROJECT_STATE spam during 60 Hz geometry drags.
void reconcileTransitionsAfterGeometryEdit(AudioEngine& engine, ProjectState& projectState,
                                           BridgeServer& bridge, ProjectSession& session);

} // namespace silverdaw
