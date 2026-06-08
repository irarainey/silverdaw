#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class BridgeServer;
class ProjectState;
struct ProjectSession;

// §12.1 clip-transition command handlers + their shared epilogue. Kept out of
// Main.cpp (already an oversized god file) so the dispatcher only routes to
// them. The `apply*` mutators apply one TRANSITION_* envelope to the project
// tree and return whether the tree actually changed; the epilogue helpers own
// the reconcile + edge-fade sync + PROJECT_STATE rebroadcast.
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

// Shared epilogue for the discrete TRANSITION_* edits: re-derive every clip's
// edge-fade, drop any transition the edit invalidated (folding into the same
// open undo step), then rebroadcast the authoritative PROJECT_STATE. The
// renderer has no bespoke ack — the snapshot IS the ack — so we always
// rebroadcast, even when the mutation was rejected, to re-sync the client.
void finishTransitionEdit(AudioEngine& engine, ProjectState& projectState, BridgeServer& bridge,
                          ProjectSession& session);

// True for geometry edits that can move / resize a clip (or change its
// warp-scaled footprint) and therefore break a transition's sanctioned
// overlap. Undo / redo / load reconcile separately via rebuildEngineFromProject
// and are intentionally excluded.
bool transitionGeometryMayHaveChanged(const juce::String& type) noexcept;

// Re-derive edge-fades after a geometry edit and auto-delete any transition
// whose invariants broke. Gated on the project actually carrying a transition
// so a transition-free project keeps a byte-for-byte unchanged hot path. Only
// rebroadcasts PROJECT_STATE when a transition was removed, so a 60 Hz
// move/trim drag does not spam full snapshots.
void reconcileTransitionsAfterGeometryEdit(AudioEngine& engine, ProjectState& projectState,
                                           BridgeServer& bridge, ProjectSession& session);

} // namespace silverdaw
