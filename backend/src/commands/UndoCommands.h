#pragma once

#include "ProjectSession.h"

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;
class DecodedCache;

// Undo / redo plumbing. The backend's juce::UndoManager collects every
// `&undoManager`-tracked ValueTree mutation; these helpers wrap each
// bridge envelope in exactly one transaction (with a coalescing window
// for 60Hz drags) and drive EDIT_UNDO / EDIT_REDO snapshot rebuilds.

// True for envelope types whose handlers mutate undo-tracked state.
bool isUndoableEnvelopeType(const juce::String& type) noexcept;

// Open (or coalesce into) the undo transaction for a mutating envelope.
// Call before the handler runs.
void beginUndoTransactionIfNeeded(const juce::String& type, const juce::var& payload,
                                  ProjectState& projectState);

// Close the coalesce window after a terminal `gestureEnd` event. Call
// after the handler runs.
void endUndoTransactionIfNeeded(const juce::String& type, const juce::var& payload) noexcept;

void handleEditUndo(AudioEngine& engine, ProjectState& projectState, BridgeServer& bridge,
                    ProjectSession& session, juce::ThreadPool& peakPool, const DecodedCache& decodedCache);
void handleEditRedo(AudioEngine& engine, ProjectState& projectState, BridgeServer& bridge,
                    ProjectSession& session, juce::ThreadPool& peakPool, const DecodedCache& decodedCache);

} // namespace silverdaw
