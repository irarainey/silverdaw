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
void handleLibraryRemove(const juce::var& payload, ProjectState& projectState, const ProjectSession& session);
// Delete a removed library item's generated stem/sample files (confined to the
// project's stems/samples artifact trees) and prune any per-source folder the last
// file left empty. Gated by the renderer's "clean up project files" preference.
void handleLibraryDeleteArtifacts(const juce::var& payload, const ProjectSession& session, AudioEngine& engine);
void handleLibraryReanalyse(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                            BridgeServer& bridge, juce::ThreadPool& peakPool, const DecodedCache& decodedCache);
void handleLibraryItemSetAudioType(const juce::var& payload, ProjectState& projectState);
void handleLibraryItemSetManualTempo(const juce::var& payload, AudioEngine& engine,
                                     ProjectState& projectState, BridgeServer& bridge);

} // namespace silverdaw
