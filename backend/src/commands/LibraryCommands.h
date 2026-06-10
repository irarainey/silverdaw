#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;
class DecodedCache;
struct ProjectSession;

// LibraryAnalysis owns background analysis; handlers own mutation + scheduling.

void handleLibraryItemRelink(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                             BridgeServer& bridge, const ProjectSession& session, juce::ThreadPool& peakPool,
                             const DecodedCache& decodedCache);
void handleLibraryAdd(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                      BridgeServer& bridge, juce::ThreadPool& peakPool, const DecodedCache& decodedCache);
void handleLibraryRemove(const juce::var& payload, ProjectState& projectState);
void handleLibraryReanalyse(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                            BridgeServer& bridge, juce::ThreadPool& peakPool, const DecodedCache& decodedCache);
void handleLibraryItemSetSampleMode(const juce::var& payload, ProjectState& projectState);
void handleLibraryItemSetManualTempo(const juce::var& payload, AudioEngine& engine,
                                     ProjectState& projectState, BridgeServer& bridge);

} // namespace silverdaw
