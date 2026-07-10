#include "WaveformCommands.h"

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "DecodedCache.h"
#include "EnginePlaybackPath.h"
#include "LibraryAnalysis.h"
#include "Log.h"
#include "PeakJobCoordinator.h"
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

struct PendingPeakJobCleanup
{
    PeakJobCoordinator& coordinator;
    const std::string& key;
    bool active = true;

    ~PendingPeakJobCleanup()
    {
        if (active)
        {
            coordinator.takeWaiters(key);
        }
    }
};

void broadcastPeaksReady(const PeakJobWaiter& waiter, const juce::File& cacheFile,
                         const silverdaw::waveform::PeaksResult& result, silverdaw::BridgeServer& bridge)
{
    auto* obj = new juce::DynamicObject();
    if (waiter.target == PeakResponseTarget::timelineClip)
    {
        obj->setProperty("clipId", waiter.id);
    }
    else
    {
        obj->setProperty("libraryItemId", waiter.id);
    }
    obj->setProperty("cachePath", cacheFile.getFullPathName());
    obj->setProperty("peakCount", result.bucketsPerLane());
    obj->setProperty("laneCount", result.laneCount);
    obj->setProperty("peaksPerSecond", effectivePeaksPerSecond(result));
    obj->setProperty("sampleRate", result.sampleRate);
    bridge.broadcast(waiter.target == PeakResponseTarget::timelineClip ? "WAVEFORM_READY"
                                                                       : "CLIP_EDITOR_PEAKS_READY",
                     juce::var(obj));
}

void broadcastPeaksFailed(const PeakJobWaiter& waiter, silverdaw::BridgeServer& bridge)
{
    if (waiter.target != PeakResponseTarget::timelineClip)
    {
        return;
    }
    auto* obj = new juce::DynamicObject();
    obj->setProperty("clipId", waiter.id);
    obj->setProperty("error", "Waveform peaks could not be produced");
    bridge.broadcast("WAVEFORM_FAILED", juce::var(obj));
}

// Worker-only disk I/O; WebSocket carries cache paths, never bulk peaks.
void produceAndBroadcastPeaks(const std::string& jobKey, const juce::File& filePath, int peaksPerSecond,
                              silverdaw::AudioEngine& engine, const silverdaw::PeaksCache& cache,
                              silverdaw::BridgeServer& bridge, PeakJobCoordinator& peakJobs)
{
    PendingPeakJobCleanup cleanup{peakJobs, jobKey};
    silverdaw::log::info("peaksjob", "start file=" + filePath.getFileName() +
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
    auto waiters = peakJobs.takeWaiters(jobKey);
    cleanup.active = false;
    if (result.peaks.empty())
    {
        silverdaw::log::warn("peaksjob", "no peaks produced for " + filePath.getFileName());
        for (const auto& waiter : waiters)
        {
            broadcastPeaksFailed(waiter, bridge);
        }
        return;
    }

    const auto cacheFile = cache.getCacheFilePath(filePath, peaksPerSecond);
    for (const auto& waiter : waiters)
    {
        broadcastPeaksReady(waiter, cacheFile, result, bridge);
    }
    silverdaw::log::info("peaksjob", "done file=" + filePath.getFileName() +
                                          " peaks=" + juce::String(result.bucketsPerLane()) +
                                          " waiters=" + juce::String(static_cast<int>(waiters.size())) +
                                          (fromCache ? " (cache hit)" : " (computed)"));
}

void enqueuePeakJob(PeakJobWaiter waiter, const juce::File& filePath, int peaksPerSecond,
                    silverdaw::AudioEngine& engine, const silverdaw::PeaksCache& cache,
                    silverdaw::BridgeServer& bridge, juce::ThreadPool& peakPool,
                    PeakJobCoordinator& peakJobs)
{
    auto ticket = peakJobs.addWaiter(filePath, peaksPerSecond, std::move(waiter));
    if (!ticket.startsJob)
    {
        silverdaw::log::debug("peaksjob", "coalesced file=" + filePath.getFileName() +
                                              " ppS=" + juce::String(peaksPerSecond));
        return;
    }
    peakPool.addJob(
        [key = std::move(ticket.key), filePath, peaksPerSecond, &engine, &cache, &bridge, &peakJobs]
        { produceAndBroadcastPeaks(key, filePath, peaksPerSecond, engine, cache, bridge, peakJobs); });
}

} // namespace

void handleClipAdd(const juce::var& payload, silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                   silverdaw::BridgeServer& bridge, juce::ThreadPool& peakPool, const silverdaw::PeaksCache& cache,
                   const silverdaw::DecodedCache& decodedCache, PeakJobCoordinator& peakJobs)
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
        enqueuePeakJob({PeakResponseTarget::timelineClip, clipId}, juce::File(engineFilePath),
                       silverdaw::waveform::kDefaultPeaksPerSecond, engine, cache, bridge, peakPool, peakJobs);
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
                           const silverdaw::DecodedCache& decodedCache, PeakJobCoordinator& peakJobs)
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

    enqueuePeakJob({PeakResponseTarget::timelineClip, clipId}, juce::File(engineFilePath),
                   silverdaw::waveform::kDefaultPeaksPerSecond, engine, cache, bridge, peakPool, peakJobs);
}

void handleClipEditorPeaksRequest(const juce::var& payload, silverdaw::AudioEngine& engine,
                                  silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                                  juce::ThreadPool& peakPool, const silverdaw::PeaksCache& cache,
                                  const silverdaw::DecodedCache& decodedCache, PeakJobCoordinator& peakJobs)
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
    enqueuePeakJob({PeakResponseTarget::clipEditor, libraryItemId}, juce::File(engineFilePath),
                   peaksPerSecond, engine, cache, bridge, peakPool, peakJobs);
}

} // namespace silverdaw
