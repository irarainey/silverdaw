#pragma once

#include "ProjectSession.h"

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;
class DecodedCache;

// Coalesces high-rate gestures into one UndoManager transaction.

bool isUndoableEnvelopeType(const juce::String& type) noexcept;

void beginUndoTransactionIfNeeded(const juce::String& type, const juce::var& payload,
                                  ProjectState& projectState);

void endUndoTransactionIfNeeded(const juce::String& type, const juce::var& payload) noexcept;

// Explicit multi-command undo grouping: a compound user action (split, duplicate, paste, a
// clip-editor save that touches every linked clip, …) brackets its bridge sends with
// EDIT_GROUP_BEGIN/END so every undoable command in between folds into ONE transaction and a
// single Undo reverses the whole action. Nestable via an internal depth counter; while a group is
// open, per-command `beginUndoTransactionIfNeeded` is suppressed.
void beginUndoGroup(const juce::String& label, ProjectState& projectState);
void endUndoGroup() noexcept;

void handleEditUndo(AudioEngine& engine, ProjectState& projectState, BridgeServer& bridge,
                    ProjectSession& session, juce::ThreadPool& peakPool, const DecodedCache& decodedCache);
void handleEditRedo(AudioEngine& engine, ProjectState& projectState, BridgeServer& bridge,
                    ProjectSession& session, juce::ThreadPool& peakPool, const DecodedCache& decodedCache);

} // namespace silverdaw
