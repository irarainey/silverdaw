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

void handleEditUndo(AudioEngine& engine, ProjectState& projectState, BridgeServer& bridge,
                    ProjectSession& session, juce::ThreadPool& peakPool, const DecodedCache& decodedCache);
void handleEditRedo(AudioEngine& engine, ProjectState& projectState, BridgeServer& bridge,
                    ProjectSession& session, juce::ThreadPool& peakPool, const DecodedCache& decodedCache);

} // namespace silverdaw
