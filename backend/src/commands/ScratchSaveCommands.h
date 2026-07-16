#pragma once

#include <juce_core/juce_core.h>

namespace juce
{
class ThreadPool;
}

namespace silverdaw
{

class AudioEngine;
class BridgeServer;
class PeaksCache;
class ProjectState;
struct ProjectSession;

// SCRATCH_SAVE_AS_SAMPLE: bakes the recorded scratch pattern into a frozen WAV
// sample (kind="sample", audioType="simple") that can be dragged onto the
// timeline like any other sample, while preserving the notation (in the project
// ValueTree) and a self-contained copy of the source-audio window so the scratch
// can be re-opened and edited later. Off-thread bake on peakPool; library
// registration + broadcasts happen back on the message thread.
void handleScratchSaveAsSample(const juce::var& payload, AudioEngine& engine,
                               ProjectState& projectState, BridgeServer& bridge,
                               juce::ThreadPool& peakPool, const PeaksCache& cache,
                               const ProjectSession& session);

} // namespace silverdaw
