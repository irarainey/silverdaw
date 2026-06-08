#pragma once

#include <juce_core/juce_core.h>
#include <memory>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;
class DecodedCache;

// Shared worker-path analysis used by library handlers and clip ingest.

// CLIP_WARP_APPLIED payload for `clipId` (effective warp + timing snapshot).
std::unique_ptr<juce::DynamicObject> buildClipWarpAppliedPayload(ProjectState& projectState,
                                                                 const juce::String& clipId);

// Project BPM seeding is gated to avoid library-only or non-musical sources.
void maybeSeedProjectBpmFor(const juce::String& itemId, ProjectState& projectState, BridgeServer& bridge);

// Idempotent scheduler: queues analysis only while a matching item lacks BPM.
void ensureBpmDetection(const juce::String& filePath, AudioEngine& engine, ProjectState& projectState,
                        BridgeServer& bridge, juce::ThreadPool& peakPool, const DecodedCache& decodedCache);

// Force a re-analysis of `itemId`, clearing any prior result first.
void forceLibraryItemAnalysis(const juce::String& itemId, const juce::String& filePath, AudioEngine& engine,
                              ProjectState& projectState, BridgeServer& bridge, juce::ThreadPool& peakPool,
                              const DecodedCache& decodedCache);

// Background-decodes missing WAV caches so playback can use cheap PCM.
void ensureDecodedCache(const juce::String& sourceFilePath, AudioEngine& engine, ProjectState& projectState,
                        juce::ThreadPool& peakPool, const DecodedCache& decodedCache);

} // namespace silverdaw
