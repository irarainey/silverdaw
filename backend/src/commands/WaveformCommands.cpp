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

// Worker-only disk I/O; WebSocket carries cache paths, never bulk peaks.
// Empty peak results are not broadcast so the renderer keeps its placeholder.
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

    // `peakCount` is per lane and matches the PeaksCache on-disk layout.
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

// PeaksCache keys by resolution, so editor high-res peaks coexist with defaults.
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

    // Library item is the single source of truth for clip source path.
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

    // Apply initial offset with load to avoid an audio-thread blip at 0.
    const juce::var posVar = payload.getProperty("positionMs", juce::var());
    const double initialOffsetMs =
        (posVar.isDouble() || posVar.isInt() || posVar.isInt64()) ? juce::jmax(0.0, static_cast<double>(posVar)) : 0.0;

    const juce::var inVar = payload.getProperty("inMs", juce::var());
    const double inMs =
        (inVar.isDouble() || inVar.isInt() || inVar.isInt64()) ? juce::jmax(0.0, static_cast<double>(inVar)) : 0.0;
    const juce::var durVar = payload.getProperty("durationMs", juce::var());
    const double payloadDurationMs =
        (durVar.isDouble() || durVar.isInt() || durVar.isInt64()) ? juce::jmax(0.0, static_cast<double>(durVar)) : 0.0;

    const juce::var colorVar = payload.getProperty("colorIndex", juce::var());
    const int payloadColorIndex =
        (colorVar.isInt() || colorVar.isInt64()) ? static_cast<int>(colorVar) : -1;

    // Idempotent for older clients that never sent TRACK_ADD.
    projectState.addTrack(trackId);

    // Prefer decoded-WAV cache so compressed sources don't stall clip-boundary reads.
    const juce::String engineFilePath =
        silverdaw::resolveEnginePlaybackPath(filePath, projectState, decodedCache);
    // Decode cache miss in the background for future clip adds.
    if (engineFilePath == filePath)
    {
        silverdaw::ensureDecodedCache(filePath, engine, projectState, peakPool, decodedCache);
    }

    juce::String errorMsg;
    // Seed effective gain at addClip to avoid a pre-mute/solo gain blip.
    const auto effectiveGain = projectState.getEffectiveTrackGain(trackId);
    bool ok = engine.addClip(trackId, clipId, juce::File(engineFilePath), initialOffsetMs, inMs, payloadDurationMs,
                             effectiveGain, &errorMsg);
    if (ok)
    {
        // Persist engine-discovered duration so reconnects can rebuild geometry.
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
        // All peak/analysis I/O reads the decoded WAV; the source is only ever
        // read to produce that WAV. engineFilePath is the resolved playable WAV
        // (or the source itself when it is already a readable WAV).
        peakPool.addJob(
            [clipId, file = juce::File(engineFilePath), &engine, &cache, &bridge]
            { produceAndBroadcastPeaks(clipId, file, engine, cache, bridge); });
        // Covers deduped or missing LIBRARY_ADD before this clip arrives.
        silverdaw::ensureBpmDetection(filePath, engine, projectState, bridge, peakPool, decodedCache);
        // Re-check project BPM seeding once the first clip exists.
        silverdaw::maybeSeedProjectBpmFor(libraryItemId, projectState, bridge);
        // Keep the monitoring metronome in time if seeding just set the project tempo.
        engine.setMetronomeBpm(projectState.getBpm());
    }
}

void handleWaveformRequest(const juce::var& payload, silverdaw::AudioEngine& engine,
                           silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                           juce::ThreadPool& peakPool, const silverdaw::PeaksCache& cache,
                           const silverdaw::DecodedCache& decodedCache)
{
    const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
    if (clipId.isEmpty())
    {
        return;
    }
    // Backend remains the authority for clipId-to-file resolution.
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

    // Peaks are always computed from the decoded WAV; the source is only read to
    // produce it. Build the decoded cache if a compressed source hasn't been
    // decoded yet, then peaks compute off the WAV on a later request.
    const juce::String engineFilePath =
        silverdaw::resolveEnginePlaybackPath(filePath, projectState, decodedCache);
    if (engineFilePath == filePath)
    {
        silverdaw::ensureDecodedCache(filePath, engine, projectState, peakPool, decodedCache);
    }

    peakPool.addJob(
        [clipId, file = juce::File(engineFilePath), &engine, &cache, &bridge]
        { produceAndBroadcastPeaks(clipId, file, engine, cache, bridge); });
}

void handleClipEditorPeaksRequest(const juce::var& payload, silverdaw::AudioEngine& engine,
                                  silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                                  juce::ThreadPool& peakPool, const silverdaw::PeaksCache& cache,
                                  const silverdaw::DecodedCache& decodedCache)
{
    const juce::String libraryItemId = tryGetRequiredString(payload, "libraryItemId").value_or(juce::String{});
    const int peaksPerSecond =
        juce::jmax(silverdaw::waveform::kDefaultPeaksPerSecond,
                   juce::jmin(20000, static_cast<int>(payload.getProperty("peaksPerSecond", 0))));
    if (libraryItemId.isEmpty()) return;
    const auto filePath = projectState.getLibraryItemFilePath(libraryItemId);
    if (filePath.isEmpty()) return;
    // Editor peaks, like every other read, come from the decoded WAV.
    const juce::String engineFilePath =
        silverdaw::resolveEnginePlaybackPath(filePath, projectState, decodedCache);
    if (engineFilePath == filePath)
    {
        silverdaw::ensureDecodedCache(filePath, engine, projectState, peakPool, decodedCache);
    }
    peakPool.addJob(
        [libraryItemId, file = juce::File(engineFilePath), peaksPerSecond, &engine, &cache, &bridge]
        { produceAndBroadcastEditorPeaks(libraryItemId, file, peaksPerSecond, engine, cache, bridge); });
}

} // namespace silverdaw
