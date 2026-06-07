#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{
class AudioEngine;
class ProjectState;
class BridgeServer;
class PeaksCache;
class DecodedCache;
struct ProjectSession;

// Central bridge-message router. Owns the undo-transaction prologue/epilogue,
// transition reconciliation, and undo-state broadcast that wrap every
// project-mutating envelope; each `type` branch delegates to a focused
// command-domain handler. Lives in its own translation unit so Main.cpp stays
// a thin entry point rather than a routing god file.
void dispatchBridgeMessage(const juce::String& type, const juce::var& payload, AudioEngine& engine,
                           ProjectState& projectState, BridgeServer& bridge, juce::ThreadPool& peakPool,
                           const PeaksCache& cache, const DecodedCache& decodedCache, ProjectSession& session);
} // namespace silverdaw
