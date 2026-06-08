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

// Keeps command routing out of Main.cpp; wraps project mutations with undo/dirty housekeeping.
void dispatchBridgeMessage(const juce::String& type, const juce::var& payload, AudioEngine& engine,
                           ProjectState& projectState, BridgeServer& bridge, juce::ThreadPool& peakPool,
                           const PeaksCache& cache, const DecodedCache& decodedCache, ProjectSession& session);
} // namespace silverdaw
