#pragma once

#include <juce_core/juce_core.h>
#include <cstdint>
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

// What a re-derive pass did, and what it deliberately left alone. The exclusions are
// the user's own earlier choices, not failures, and ADR 0027 requires them to be
// reported as such rather than passed over in silence.
struct ClipTempoRederiveReport
{
    int clipsUpdated = 0;
    int clipsPinnedExcluded = 0;
    int clipsUnwarpedExcluded = 0;
};

/**
 * Re-derive the warp ratio of every clip that follows `ownerItemId`'s tempo.
 *
 * When a source tempo moves, every clip that follows the project tempo is silently
 * wrong: nothing about such a clip is stored, so its persisted state still says only
 * "follow the project", while the engine holds the ratio built from the old BPM and the
 * renderer holds the matching effective timing — and its beat grid recomputes live from
 * the new one. Left alone, the markers come out spaced at `newSpacing / oldRatio`, the
 * clip keeps its old drawn width, and playback keeps the old stretch.
 *
 * Shared by tempo analysis and by a tempo correction so the two cannot drift: they are
 * the same reconciliation, differing only in what moved the tempo (ADR 0016).
 *
 * Membership is decided by tempo OWNERSHIP, not by derivation — see the implementation.
 * Broadcasts `CLIP_WARP_APPLIED` per updated clip. Runs on the message thread.
 */
ClipTempoRederiveReport rederiveClipsForTempoOwner(const juce::String& ownerItemId,
                                                   AudioEngine& engine, ProjectState& projectState,
                                                   BridgeServer& bridge);

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
// Returns what the shared clip re-derive pass did, so a caller that has to report
// the outcome can. Runs on the message thread.
//
// Pass `allowProjectBpmSeeding=false` for a tempo correction: seeding would move the
// project tempo as a side effect of fixing a source tempo, and ADR 0027 requires that to
// be the user's explicit answer rather than an inference.
ClipTempoRederiveReport applyManualTempo(const juce::String& itemId, double bpm, double beatAnchorSec,
                                         AudioEngine& engine, ProjectState& projectState,
                                         BridgeServer& bridge, bool allowProjectBpmSeeding = true);

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

// --- Tempo authority generation (ADR 0027) -----------------------------------------
//
// A detection job runs on a worker thread and applies its result later, on the message
// thread. If the user corrects the item's tempo by hand in between, the result that
// finally lands is stale and must be dropped: the automatic path writes DERIVED,
// non-dirtying, non-undoable metadata, so a correction it overwrote could not be
// recovered with undo — nothing was pushed onto the undo stack to undo.
//
// Each item carries a generation, bumped by `applyManualTempo`. A job captures the
// generation when it is ENQUEUED (not when it starts running, so a correction wins even
// while the job sits in the pool queue) and discards itself if it no longer matches.
//
// These two are exposed for tests, which cannot reach the guard inside the detection
// job itself: it depends on real audio decoding and on message-thread delivery.

/** The item's current tempo authority generation. Zero for an item never corrected. */
std::uint64_t getTempoAuthorityGeneration(const juce::String& itemId);

/** Whether a detection result captured at `startGeneration` has since been superseded
 *  by a hand-set tempo, and so must not be applied. */
bool tempoDetectionResultIsStale(const juce::String& itemId, std::uint64_t startGeneration);

} // namespace silverdaw
