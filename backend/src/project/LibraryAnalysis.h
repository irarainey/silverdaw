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

// Stems share their source's beat grid: copy the source item's analysis onto the
// stem and broadcast it, instead of re-analysing (slow and inaccurate for sparse stems).
void inheritAnalysisFromSource(const juce::String& itemId, const juce::String& sourceItemId,
                               AudioEngine& engine, ProjectState& projectState, BridgeServer& bridge);

// Force a re-analysis of `itemId`, clearing any prior result first.
void forceLibraryItemAnalysis(const juce::String& itemId, const juce::String& filePath, AudioEngine& engine,
                              ProjectState& projectState, BridgeServer& bridge, juce::ThreadPool& peakPool,
                              const DecodedCache& decodedCache);

// Apply a user-supplied manual tempo to a source item: builds a rigid beat grid
// from (bpm, beatAnchorSec) across the item's duration, clears the variable /
// low-confidence flags (a manual tempo is treated as confident music), persists
// it, and broadcasts LIBRARY_ITEM_ANALYSIS so all clients redraw the grid.
// Runs on the message thread.
void applyManualTempo(const juce::String& itemId, double bpm, double beatAnchorSec,
                      AudioEngine& engine, ProjectState& projectState, BridgeServer& bridge);

// Record how many whole beats of music a derived item's window contains, measured
// against the tempo of the item it was cut from. Returns the recorded count, or 0
// when nothing was recorded — the window was not a whole number of beats (within a
// tolerance that keeps the implied stretch under ~1%), or a count is already stored.
//
// This is what keeps a clip cut to a number of bars at that number of bars whatever
// its BPM later says: reanalysing a two-bar excerpt sees only about eight beats and
// lands a few percent out, and the resulting clip no longer warps onto the grid. The
// count is a measurement of the audio, so it outranks that opinion — see ADR 0024.
// Never overwrites an existing count; the first writer measured the true window.
// Runs on the message thread.
int recordMusicalLength(const juce::String& itemId, double sourceBpm, double windowDurationMs,
                        ProjectState& projectState);

// Background-decodes missing WAV caches so playback can use cheap PCM.
void ensureDecodedCache(const juce::String& sourceFilePath, AudioEngine& engine, ProjectState& projectState,
                        juce::ThreadPool& peakPool, const DecodedCache& decodedCache);

} // namespace silverdaw
