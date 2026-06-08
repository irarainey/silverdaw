#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;
class PeaksCache;

// Sample export renders on the worker pool; project mutation and broadcast return to the message thread.

void handleClipSaveAsSample(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                            BridgeServer& bridge, juce::ThreadPool& peakPool, const PeaksCache& cache);
void handleLibraryItemSaveAsSample(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                                   BridgeServer& bridge, juce::ThreadPool& peakPool, const PeaksCache& cache);

} // namespace silverdaw
