#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class ProjectState;

// §12.1 clip-transition command handlers. Kept out of Main.cpp (already an
// oversized god file) so the dispatcher only routes to them. Each applies one
// TRANSITION_* envelope to the project tree and returns whether the tree
// actually changed. The dispatcher owns the shared epilogue (reconcile +
// edge-fade sync + PROJECT_STATE rebroadcast) because that needs the
// Main.cpp-local envelope builder; these stay pure project-state mutations.
//
// An undo transaction is already open (the dispatcher's undo prologue) when
// these run, so every mutation folds into one undoable step.

/** Create a transition over the sanctioned overlap of two adjacent clips.
 *  The transition id is minted here (the wire payload carries none). Returns
 *  true if a transition was added. */
bool applyTransitionCreate(const juce::var& payload, ProjectState& projectState);

/** Delete a transition by id. Returns true if it existed. */
bool applyTransitionDelete(const juce::var& payload, ProjectState& projectState);

/** Swap the recipe on an existing transition. Returns true if it changed. */
bool applyTransitionSetRecipe(const juce::var& payload, ProjectState& projectState);

} // namespace silverdaw
