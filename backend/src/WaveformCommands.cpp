#include "WaveformCommands.h"

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "DecodedCache.h"
#include "EnginePlaybackPath.h"
#include "LibraryAnalysis.h"
#include "Log.h"
#include "PayloadHelpers.h"
#include "PeaksCache.h"
#include "ProjectState.h"
#include "Waveform.h"

namespace silverdaw
{

using silverdaw::bridge::tryGetRequiredString;

double effectivePeaksPerSecond(const silverdaw::waveform::PeaksResult& result)
{
    if (result.sampleRate <= 0.0 || result.peaksPerSecond <= 0) return static_cast<double>(result.peaksPerSecond);
    const int samplesPerPeak = juce::jmax(1, static_cast<int>(result.sampleRate / result.peaksPerSecond));
    return result.sampleRate / static_cast<double>(samplesPerPeak);
}

namespace
{

/**
 * Compute or load peaks for `filePath` and notify clients that a fresh
 * cache file is on disk via a tiny `WAVEFORM_READY` text envelope. The
 * renderer reads the on-disk bytes via main's IPC — bulk data never
 * crosses the WebSocket. This is the architectural counterpart to how
 * the design plan already treats audio files / stems / mixdowns:
 * "Disk only: the backend sends file paths; the frontend never receives
 * raw audio data over the socket."
 *
 * Designed to be called from a `juce::ThreadPool` job — disk I/O only,
 * never touches the message thread, and `BridgeServer::broadcast` is
 * mutex-guarded internally.
 *
 * Cache lookup first; on miss, compute + persist. An empty result
 * (decode failure) is NOT broadcast — silent failure means the renderer
 * keeps drawing the empty placeholder until the user retries or the
 * file becomes readable.
 */
void produceAndBroadcastPeaks(const juce::String& clipId, const juce::File& filePath,
                              silverdaw::AudioEngine& engine, const silverdaw::PeaksCache& cache,
                              silverdaw::BridgeServer& bridge)
{
    constexpr int kPeaksPerSecond = silverdaw::waveform::kDefaultPeaksPerSecond;
    silverdaw::log::info("peaksjob", "start clipId=" + clipId + " file=" + filePath.getFileName());
    auto result = cache.tryLoad(filePath, kPeaksPerSecond);
    const bool fromCache = !result.peaks.empty();
    if (!fromCache)
    {
        result = silverdaw::waveform::computePeaks(filePath, engine.getFormatManager(), kPeaksPerSecond);
        if (!result.peaks.empty())
        {
            cache.store(filePath, result);
        }
    }
    if (result.peaks.empty())
    {
        silverdaw::log::warn("peaksjob", "no peaks produced for clipId=" + clipId);
        return;
    }

    // Build a small JSON envelope. `peakCount` is the number of (min,max)
    // pairs PER LANE — the renderer reads `peakCount * laneCount * 2 *
    // sizeof(float)` bytes from the file after the 28-byte header. Same
    // layout the cache itself uses (see `PeaksCache.cpp`).
    const auto cacheFile = cache.getCacheFilePath(filePath, kPeaksPerSecond);
    auto* obj = new juce::DynamicObject();
    obj->setProperty("clipId", clipId);
    obj->setProperty("cachePath", cacheFile.getFullPathName());
    obj->setProperty("peakCount", result.bucketsPerLane());
    obj->setProperty("laneCount", result.laneCount);
    obj->setProperty("peaksPerSecond", effectivePeaksPerSecond(result));
    obj->setProperty("sampleRate", result.sampleRate);
    bridge.broadcast("WAVEFORM_READY", juce::var(obj));

    silverdaw::log::info("peaksjob", "done clipId=" + clipId + " peaks=" +
                                          juce::String(result.bucketsPerLane()) +
                                          (fromCache ? " (cache hit)" : " (computed)"));
}

// Variant of `produceAndBroadcastPeaks` that targets a library item id
// at a caller-specified resolution. Used by the Clip Editor's
// `CLIP_EDITOR_PEAKS_REQUEST` flow: when the user zooms past the
// detail level that the default-resolution peaks can resolve, the
// renderer asks for a high-res rebuild (typically 2000+ peaks/sec) of
// the source file. PeaksCache keys on `(filePath, peaksPerSecond)`,
// so the high-res result lives alongside the default-res one and
// every saved-clip sharing the source reuses it.
void produceAndBroadcastEditorPeaks(const juce::String& libraryItemId, const juce::File& filePath,
                                    int peaksPerSecond, silverdaw::AudioEngine& engine,
                                    const silverdaw::PeaksCache& cache, silverdaw::BridgeServer& bridge)
{
    silverdaw::log::info("peaksjob", "editor start libId=" + libraryItemId +
                                          " file=" + filePath.getFileName() +
                                          " ppS=" + juce::String(peaksPerSecond));
    auto result = cache.tryLoad(filePath, peaksPerSecond);
    const bool fromCache = !result.peaks.empty();
    if (!fromCache)
    {
        result = silverdaw::waveform::computePeaks(filePath, engine.getFormatManager(), peaksPerSecond);
        if (!result.peaks.empty())
        {
            cache.store(filePath, result);
        }
    }
    if (result.peaks.empty())
    {
        silverdaw::log::warn("peaksjob", "editor no peaks libId=" + libraryItemId);
        return;
    }
    const auto cacheFile = cache.getCacheFilePath(filePath, peaksPerSecond);
    auto* obj = new juce::DynamicObject();
    obj->setProperty("libraryItemId", libraryItemId);
    obj->setProperty("cachePath", cacheFile.getFullPathName());
    obj->setProperty("peakCount", result.bucketsPerLane());
    obj->setProperty("laneCount", result.laneCount);
    obj->setProperty("peaksPerSecond", effectivePeaksPerSecond(result));
    obj->setProperty("sampleRate", result.sampleRate);
    bridge.broadcast("CLIP_EDITOR_PEAKS_READY", juce::var(obj));
    silverdaw::log::info("peaksjob", "editor done libId=" + libraryItemId + " peaks=" +
                                          juce::String(result.bucketsPerLane()) +
                                          (fromCache ? " (cache hit)" : " (computed)"));
}

} // namespace

void handleClipAdd(const juce::var& payload, silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                   silverdaw::BridgeServer& bridge, juce::ThreadPool& peakPool, const silverdaw::PeaksCache& cache,
                   const silverdaw::DecodedCache& decodedCache)
{
    const juce::String trackId = tryGetRequiredString(payload, "trackId").value_or(juce::String{});
    const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
    const juce::String libraryItemId = tryGetRequiredString(payload, "libraryItemId").value_or(juce::String{});
    if (trackId.isEmpty() || clipId.isEmpty() || libraryItemId.isEmpty())
    {
        silverdaw::log::warn("bridge", "CLIP_ADD missing trackId / clipId / libraryItemId");
        return;
    }

    // Resolve the source file through the linked library item. A clip
    // is now a pure window into a library item; the library is the
    // single source of truth for the underlying file path.
    const juce::String filePath = projectState.getLibraryItemFilePath(libraryItemId);
    if (filePath.isEmpty())
    {
        silverdaw::log::warn("bridge", "CLIP_ADD libraryItemId=" + libraryItemId + " has no filePath in library");
        auto* err = new juce::DynamicObject();
        err->setProperty("trackId", trackId);
        err->setProperty("clipId", clipId);
        err->setProperty("libraryItemId", libraryItemId);
        err->setProperty("ok", false);
        err->setProperty("error", juce::String("Unknown library item"));
        bridge.broadcast("CLIP_ADD_FAILED", juce::var(err));
        return;
    }

    // Pull the initial offset out of the payload up front so addClip can
    // apply it atomically with the load — otherwise a separate
    // setClipOffsetMs call would race against the audio thread, briefly
    // playing the clip at offset 0.
    const juce::var posVar = payload.getProperty("positionMs", juce::var());
    const double initialOffsetMs =
        (posVar.isDouble() || posVar.isInt() || posVar.isInt64()) ? juce::jmax(0.0, static_cast<double>(posVar)) : 0.0;

    // Optional trim window: split / duplicate send these so the new
    // clip plays a subset of the source file. Absent (== 0) means
    // "play the whole file from the start" — the un-trimmed default.
    const juce::var inVar = payload.getProperty("inMs", juce::var());
    const double inMs =
        (inVar.isDouble() || inVar.isInt() || inVar.isInt64()) ? juce::jmax(0.0, static_cast<double>(inVar)) : 0.0;
    const juce::var durVar = payload.getProperty("durationMs", juce::var());
    const double payloadDurationMs =
        (durVar.isDouble() || durVar.isInt() || durVar.isInt64()) ? juce::jmax(0.0, static_cast<double>(durVar)) : 0.0;

    // Optional per-clip colour override. Negative / absent means "inherit
    // from track" — the renderer-side default. Clamped on the renderer
    // side; we trust the value here because the bridge wire format is
    // type-checked.
    const juce::var colorVar = payload.getProperty("colorIndex", juce::var());
    const int payloadColorIndex =
        (colorVar.isInt() || colorVar.isInt64()) ? static_cast<int>(colorVar) : -1;

    // Auto-create the parent track in the ValueTree if the renderer didn't
    // (e.g. older clients that never send TRACK_ADD). Idempotent.
    projectState.addTrack(trackId);

    // Always read from the decoded-WAV cache: compressed sources
    // (MP3, M4A, …) are too slow to seek for the read-ahead buffer to
    // hide latency at clip boundaries. `resolveEnginePlaybackPath`
    // prefers the cache file when it exists and keeps the persisted
    // `playbackFilePath` in sync so subsequent loads pick it up.
    const juce::String engineFilePath =
        silverdaw::resolveEnginePlaybackPath(filePath, projectState, decodedCache);
    // Kick off a background decode if the cache is missing. The first
    // play of a freshly-imported file still uses the original (the only
    // option until decoding completes), but every subsequent CLIP_ADD
    // of the same source picks up the cache.
    if (engineFilePath == filePath)
    {
        silverdaw::ensureDecodedCache(filePath, engine, projectState, peakPool, decodedCache);
    }

    juce::String errorMsg;
    // Pass the effective gain (post-mute/solo) to `addClip` directly
    // so a brand-new clip starts at the audible level the rest of
    // the timeline is playing at — no brief blip at the user volume
    // before the explicit `setClipGain` below clamps it down.
    const auto effectiveGain = projectState.getEffectiveTrackGain(trackId);
    bool ok = engine.addClip(trackId, clipId, juce::File(engineFilePath), initialOffsetMs, inMs, payloadDurationMs,
                             effectiveGain, &errorMsg);
    if (ok)
    {
        // For un-trimmed clips fall back to the engine-discovered source
        // duration so PROJECT_STATE on reconnect can rebuild the clip
        // block geometry without re-reading the file from the renderer.
        // For trimmed clips (durationMs > 0) trust the renderer.
        const double effectiveDurationMs =
            payloadDurationMs > 0.0 ? payloadDurationMs : engine.getClipDurationMs(clipId);
        if (!projectState.addClip(trackId, clipId, libraryItemId, initialOffsetMs, effectiveDurationMs, inMs,
                                   payloadColorIndex))
        {
            engine.removeClip(clipId);
            ok = false;
            errorMsg = "duplicate clipId or unknown trackId";
        }
        else
        {
            engine.setClipGain(clipId, effectiveGain);
        }
    }

    auto* p = new juce::DynamicObject();
    p->setProperty("trackId", trackId);
    p->setProperty("clipId", clipId);
    p->setProperty("libraryItemId", libraryItemId);
    p->setProperty("ok", ok);
    if (!ok)
    {
        p->setProperty("error", errorMsg);
    }
    bridge.broadcast(ok ? "CLIP_ADDED" : "CLIP_ADD_FAILED", juce::var(p));

    if (ok)
    {
        // Kick off peaks generation on the worker pool. The job is fire-and-
        // forget from the message thread's perspective; clients receive the
        // waveform as a separate binary frame whenever the worker finishes
        // (or instantly if the disk cache already has an entry for this file).
        peakPool.addJob(
            [clipId, file = juce::File(filePath), &engine, &cache, &bridge]
            { produceAndBroadcastPeaks(clipId, file, engine, cache, bridge); });
        // Also schedule BPM detection for the source file if the
        // matching library item has no BPM yet. Belt-and-braces: covers
        // the case where the renderer deduplicates a LIBRARY_ADD (so
        // detection wouldn't otherwise have a chance to start) and the
        // case where a clip arrives without a preceding LIBRARY_ADD.
        // The same worker job also writes the decoded-WAV cache for
        // future clip adds.
        silverdaw::ensureBpmDetection(filePath, engine, projectState, bridge, peakPool, decodedCache);
        // If the matching library item already has a known BPM (e.g.
        // the user imported the file to the library earlier and is
        // only now placing it on a track), re-evaluate the seed
        // gates now that the project has a clip.
        silverdaw::maybeSeedProjectBpmFor(libraryItemId, projectState, bridge);
    }
}

void handleWaveformRequest(const juce::var& payload, silverdaw::AudioEngine& engine,
                           silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                           juce::ThreadPool& peakPool, const silverdaw::PeaksCache& cache)
{
    const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
    if (clipId.isEmpty())
    {
        return;
    }
    // Find the file the backend has on record for this clip. The renderer
    // never sends the path on a WAVEFORM_REQUEST — the backend is the
    // authority over what file each clipId resolves to.
    const auto trackId = projectState.getClipTrackId(clipId);
    if (trackId.isEmpty())
    {
        silverdaw::log::warn("bridge", "WAVEFORM_REQUEST for unknown clipId " + clipId);
        return;
    }
    const auto filePath = projectState.getClipFilePath(clipId);
    if (filePath.isEmpty())
    {
        return;
    }

    peakPool.addJob(
        [clipId, file = juce::File(filePath), &engine, &cache, &bridge]
        { produceAndBroadcastPeaks(clipId, file, engine, cache, bridge); });
}

void handleClipEditorPeaksRequest(const juce::var& payload, silverdaw::AudioEngine& engine,
                                  silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                                  juce::ThreadPool& peakPool, const silverdaw::PeaksCache& cache)
{
    const juce::String libraryItemId = tryGetRequiredString(payload, "libraryItemId").value_or(juce::String{});
    const int peaksPerSecond =
        juce::jmax(silverdaw::waveform::kDefaultPeaksPerSecond,
                   juce::jmin(20000, static_cast<int>(payload.getProperty("peaksPerSecond", 0))));
    if (libraryItemId.isEmpty()) return;
    const auto filePath = projectState.getLibraryItemFilePath(libraryItemId);
    if (filePath.isEmpty()) return;
    peakPool.addJob(
        [libraryItemId, file = juce::File(filePath), peaksPerSecond, &engine, &cache, &bridge]
        { produceAndBroadcastEditorPeaks(libraryItemId, file, peaksPerSecond, engine, cache, bridge); });
}

} // namespace silverdaw
