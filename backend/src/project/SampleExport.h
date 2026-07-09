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
                            BridgeServer& bridge, juce::ThreadPool& peakPool, const PeaksCache& cache,
                            const juce::String& projectPath);
void handleClipSliceToSamples(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                              BridgeServer& bridge, juce::ThreadPool& peakPool, const PeaksCache& cache,
                              const juce::String& projectPath);
void handleLibraryItemSaveAsSample(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                                   BridgeServer& bridge, juce::ThreadPool& peakPool, const PeaksCache& cache,
                                   const juce::String& projectPath);

// Split a clip's stereo source into one or both channels: each requested channel is
// written as a new stereo WAV (that channel duplicated to both L+R) and announced via
// CHANNEL_SPLIT_READY so the renderer imports it and drops it on a new track.
void handleClipSplitChannels(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                             BridgeServer& bridge, juce::ThreadPool& peakPool, const PeaksCache& cache,
                             const juce::String& projectPath);

} // namespace silverdaw
