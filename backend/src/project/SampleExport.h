#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;
class PeaksCache;

// Sample-export command handlers. CLIP_SAVE_AS_SAMPLE / LIBRARY_ITEM_SAVE_AS_SAMPLE
// render the selected clip/library-item window (optionally time/pitch-warped) to a
// fresh WAV on disk and register it back as a library item. The heavy decode/render
// runs on the peak worker pool; the library mutation + SAMPLE_SAVED broadcast happen
// back on the message thread.

void handleClipSaveAsSample(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                            BridgeServer& bridge, juce::ThreadPool& peakPool, const PeaksCache& cache);
void handleLibraryItemSaveAsSample(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                                   BridgeServer& bridge, juce::ThreadPool& peakPool, const PeaksCache& cache);

} // namespace silverdaw
