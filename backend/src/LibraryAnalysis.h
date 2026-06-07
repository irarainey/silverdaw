#pragma once

#include <juce_core/juce_core.h>
#include <memory>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;
class DecodedCache;

// Shared library-analysis infrastructure: decoded-WAV caching, worker-thread BPM
// detection, and the project-tempo seed. Lives in its own TU because both the
// LIBRARY_* handlers and the clip-ingest path schedule this background work.

// CLIP_WARP_APPLIED payload for `clipId` (effective warp + timing snapshot).
std::unique_ptr<juce::DynamicObject> buildClipWarpAppliedPayload(ProjectState& projectState,
                                                                 const juce::String& clipId);

// Seed the project BPM from a freshly-analysed library item, subject to the
// gates (clips present, no other seeded item, sample-classification). Idempotent.
void maybeSeedProjectBpmFor(const juce::String& itemId, ProjectState& projectState, BridgeServer& bridge);

// Idempotent BPM-detection scheduler: no-op when the matching library item
// already has a BPM (or none exists); otherwise queues a worker-pool job.
void ensureBpmDetection(const juce::String& filePath, AudioEngine& engine, ProjectState& projectState,
                        BridgeServer& bridge, juce::ThreadPool& peakPool, const DecodedCache& decodedCache);

// Force a re-analysis of `itemId`, clearing any prior result first.
void forceLibraryItemAnalysis(const juce::String& itemId, const juce::String& filePath, AudioEngine& engine,
                              ProjectState& projectState, BridgeServer& bridge, juce::ThreadPool& peakPool,
                              const DecodedCache& decodedCache);

// Ensure a decoded-WAV cache exists for `sourceFilePath`, scheduling a
// background decode when missing so later playback reads cheap PCM.
void ensureDecodedCache(const juce::String& sourceFilePath, AudioEngine& engine, ProjectState& projectState,
                        juce::ThreadPool& peakPool, const DecodedCache& decodedCache);

} // namespace silverdaw
