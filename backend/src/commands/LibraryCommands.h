#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;
class DecodedCache;

// LIBRARY_* command handlers — library-item lifecycle (import, removal,
// re-analysis, sample classification). Background analysis is delegated to
// LibraryAnalysis; these handlers own the ProjectState mutation + scheduling.

void handleLibraryAdd(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                      BridgeServer& bridge, juce::ThreadPool& peakPool, const DecodedCache& decodedCache);
void handleLibraryRemove(const juce::var& payload, ProjectState& projectState);
void handleLibraryReanalyse(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                            BridgeServer& bridge, juce::ThreadPool& peakPool, const DecodedCache& decodedCache);
void handleLibraryItemSetSampleMode(const juce::var& payload, ProjectState& projectState);

} // namespace silverdaw
