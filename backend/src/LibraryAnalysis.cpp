#include "LibraryAnalysis.h"

#include "AudioEngine.h"
#include "BpmDetector.h"
#include "BridgeServer.h"
#include "DecodedCache.h"
#include "EnginePlaybackPath.h"
#include "Log.h"
#include "ProjectState.h"

#include <juce_events/juce_events.h>

#include <cmath>
#include <mutex>
#include <set>

namespace silverdaw
{

namespace
{
// Dedupe guard: at most one in-flight analysis job per library item id.
std::mutex bpmJobsMutex;
std::set<juce::String> bpmJobsInFlight;
} // namespace

std::unique_ptr<juce::DynamicObject> buildClipWarpAppliedPayload(ProjectState& projectState,
                                                                 const juce::String& clipId)
{
    auto obj = std::make_unique<juce::DynamicObject>();
    obj->setProperty("clipId", clipId);
    projectState.forEachWarpClip(
        [&](const silverdaw::ProjectState::WarpClipInfo& info)
        {
            if (info.clipId != clipId) return;
            obj->setProperty("warpEnabled", info.warpEnabled);
            obj->setProperty("warpMode", info.warpMode);
            obj->setProperty("tempoRatio", info.tempoRatioPinned ? juce::var(info.tempoRatio) : juce::var());
            obj->setProperty("semitones", info.semitones);
            obj->setProperty("cents", info.cents);
            obj->setProperty("pendingAutoWarp", info.pendingAutoWarp);
        });
    const auto timing = projectState.getClipEffectiveTiming(clipId);
    obj->setProperty("effectiveDurationMs", timing.durationMs);
    obj->setProperty("effectiveTempoRatio", timing.tempoRatio);
    obj->setProperty("effectiveWarpActive", timing.warpActive);
    return obj;
}

void maybeSeedProjectBpmFor(const juce::String& itemId, ProjectState& projectState, BridgeServer& bridge)
{
    silverdaw::log::info("bpmjob", "seed check for itemId=" + itemId);
    const auto& tree = projectState.getTree();
    // Find the library item + its stored BPM. Bail if either is
    // missing — only useful when the analysis has actually landed.
    const auto library = tree.getChildWithName(juce::Identifier{"LIBRARY"});
    if (!library.isValid())
    {
        silverdaw::log::info("bpmjob", "seed skipped (no library tree)");
        return;
    }
    double itemBpm = 0.0;
    bool itemFound = false;
    bool itemLowConfidence = false;
    juce::String itemSampleMode;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(juce::Identifier{"id"}).toString() == itemId)
        {
            itemFound = true;
            if (!item.hasProperty(juce::Identifier{"bpm"}))
            {
                silverdaw::log::info("bpmjob",
                                     "seed skipped for itemId=" + itemId + " (item has no BPM yet)");
                return;
            }
            itemBpm = static_cast<double>(item.getProperty(juce::Identifier{"bpm"}, 0.0));
            itemLowConfidence = static_cast<bool>(item.getProperty(juce::Identifier{"lowConfidence"}, false));
            itemSampleMode = item.getProperty(juce::Identifier{"sampleMode"}, juce::var("")).toString();
            break;
        }
    }
    if (!itemFound)
    {
        silverdaw::log::info("bpmjob", "seed skipped — itemId=" + itemId + " not in library tree");
        return;
    }
    if (itemBpm <= 0.0)
    {
        silverdaw::log::info("bpmjob", "seed skipped for itemId=" + itemId + " (itemBpm=0)");
        return;
    }
    // Effective sample classification: user override wins; otherwise
    // fall back to the auto-detected low-confidence flag. Non-musical
    // samples must never drag the project tempo — skip the seed.
    const bool effectivelySample =
        itemSampleMode == "sample" || (itemSampleMode != "music" && itemLowConfidence);
    if (effectivelySample)
    {
        silverdaw::log::info(
            "bpmjob",
            "seed skipped for itemId=" + itemId
                + " (treated as sample — sampleMode='" + itemSampleMode
                + "' lowConfidence=" + (itemLowConfidence ? "true" : "false") + ")");
        return;
    }

    // Gate 1: at least one clip must be on a track. Library-only imports don't seed.
    int totalClips = 0;
    for (int t = 0; t < tree.getNumChildren(); ++t)
    {
        const auto track = tree.getChild(t);
        if (!track.hasType(juce::Identifier{"TRACK"})) continue;
        for (int c = 0; c < track.getNumChildren(); ++c)
        {
            if (track.getChild(c).hasType(juce::Identifier{"CLIP"}))
            {
                ++totalClips;
            }
        }
    }
    if (totalClips < 1)
    {
        silverdaw::log::info("bpmjob", "seed skipped for itemId=" + itemId + " (no clips on tracks yet)");
        return;
    }

    // Gate 2: no other library item should already have a BPM (the seed
    // has effectively run on an earlier import).
    int otherItemsWithBpm = 0;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(juce::Identifier{"id"}).toString() == itemId) continue;
        if (item.hasProperty(juce::Identifier{"bpm"}))
        {
            ++otherItemsWithBpm;
        }
    }
    if (otherItemsWithBpm > 0)
    {
        silverdaw::log::info("bpmjob",
                             "seed skipped for itemId=" + itemId +
                                 " (other library items already have BPM: " +
                                 juce::String(otherItemsWithBpm) + ")");
        return;
    }

    // Gate 3: don't re-broadcast if the project BPM is already in sync.
    if (std::abs(projectState.getBpm() - itemBpm) < 1e-6)
    {
        return;
    }

    projectState.setBpm(itemBpm);
    auto* bpmObj = new juce::DynamicObject();
    bpmObj->setProperty("bpm", itemBpm);
    bridge.broadcast("PROJECT_BPM_APPLIED", juce::var(bpmObj));
    silverdaw::log::info("bpmjob", "seeded project BPM from " + itemId + ": " + juce::String(itemBpm, 4));
}

namespace
{
// Decode → analyse on a worker thread, then marshal the ValueTree writes +
// broadcasts back to the message thread via MessageManager::callAsync.
void runBpmDetection(const juce::String& itemId, const juce::File& filePath,
                     AudioEngine& engine, ProjectState& projectState,
                     BridgeServer& bridge, const DecodedCache& decodedCache,
                     bool recreateDecodedCache = false)
{
    silverdaw::log::info("bpmjob", "start itemId=" + itemId + " file=" + filePath.getFileName());

    // Step 1: decode the whole source into a 16-bit PCM WAV cache (no-op if a
    // cache entry already exists). The engine reads this cheap PCM for all
    // subsequent CLIP_ADDs of the file instead of decoding on every block.
    const auto cachedFile = recreateDecodedCache
                                ? decodedCache.recreateDecoded(filePath, engine.getFormatManager())
                                : decodedCache.ensureDecoded(filePath, engine.getFormatManager());
    const juce::String cachedPath = cachedFile.existsAsFile() ? cachedFile.getFullPathName() : juce::String();

    // Step 2: analyse. Prefer the cached WAV — faster to decode AND identical
    // to what the engine plays, so reported beat times line up with playback.
    const juce::File analysisFile = cachedFile.existsAsFile() ? cachedFile : filePath;
    silverdaw::BpmDetector detector;
    const silverdaw::BpmAnalysis analysis = detector.analyse(analysisFile, engine.getFormatManager());
    if (analysis.bpm <= 0.0)
    {
        silverdaw::log::info("bpmjob", "no plausible BPM for itemId=" + itemId);
        // Still surface the decoded-cache path so future CLIP_ADDs use the
        // cheap WAV: broadcast a minimal zero-BPM analysis envelope.
        if (cachedPath.isNotEmpty() || recreateDecodedCache)
        {
            juce::MessageManager::callAsync(
                [itemId, cachedPath, &projectState, &bridge]
                {
                    projectState.clearLibraryItemAnalysis(itemId);
                    projectState.setLibraryItemPlaybackPath(itemId, cachedPath);
                    auto* p = new juce::DynamicObject();
                    p->setProperty("itemId", itemId);
                    p->setProperty("bpm", 0.0);
                    p->setProperty("beatAnchorSec", 0.0);
                    p->setProperty("beats", juce::var(juce::Array<juce::var>{}));
                    p->setProperty("variableTempo", false);
                    p->setProperty("playbackFilePath", cachedPath);
                    bridge.broadcast("LIBRARY_ITEM_ANALYSIS", juce::var(p));
                });
        }
        {
            std::lock_guard<std::mutex> lock(bpmJobsMutex);
            bpmJobsInFlight.erase(itemId);
        }
        return;
    }
    juce::MessageManager::callAsync(
        [itemId, analysis, cachedPath, &projectState, &bridge, &engine]
        {
            // Item may have been removed while we were busy.
            if (!projectState.setLibraryItemBpm(itemId, analysis.bpm))
            {
                silverdaw::log::warn("bpmjob",
                                     "library item " + itemId + " gone before BPM applied");
                {
                    std::lock_guard<std::mutex> lock(bpmJobsMutex);
                    bpmJobsInFlight.erase(itemId);
                }
                return;
            }
            projectState.setLibraryItemBeats(itemId, analysis.beatTimesSec);
            projectState.setLibraryItemBeatAnchor(itemId, analysis.beatAnchorSec);
            projectState.setLibraryItemVariableTempo(itemId, analysis.variableTempo);
            projectState.setLibraryItemLowConfidence(itemId, analysis.lowConfidence);
            if (cachedPath.isNotEmpty())
            {
                projectState.setLibraryItemPlaybackPath(itemId, cachedPath);
            }

            auto* p = new juce::DynamicObject();
            p->setProperty("itemId", itemId);
            p->setProperty("bpm", analysis.bpm);
            p->setProperty("beatAnchorSec", analysis.beatAnchorSec);
            juce::Array<juce::var> beatArr;
            beatArr.ensureStorageAllocated(static_cast<int>(analysis.beatTimesSec.size()));
            for (double t : analysis.beatTimesSec) beatArr.add(juce::var(t));
            p->setProperty("beats", juce::var(beatArr));
            p->setProperty("variableTempo", analysis.variableTempo);
            p->setProperty("lowConfidence", analysis.lowConfidence);
            if (cachedPath.isNotEmpty())
            {
                p->setProperty("playbackFilePath", cachedPath);
            }
            bridge.broadcast("LIBRARY_ITEM_ANALYSIS", juce::var(p));

            // Late auto-warp: clips dropped before this item's BPM was known
            // carry `pendingAutoWarp`. With a stable BPM (skip variable-tempo
            // and low-confidence cases), flip warp on so the user gets the
            // intent they signalled at drop time without further action.
            DBG("[warp/late-flip] LIBRARY_ITEM_ANALYSIS itemId=" + itemId
                + " bpm=" + juce::String(analysis.bpm)
                + " variableTempo=" + (analysis.variableTempo ? "true" : "false")
                + " lowConfidence=" + (analysis.lowConfidence ? "true" : "false")
                + " projectBpm=" + juce::String(projectState.getBpm()));
            if (!analysis.variableTempo && !analysis.lowConfidence && analysis.bpm > 0.0)
            {
                const double projectBpm = projectState.getBpm();
                int scanned = 0;
                int flipped = 0;
                projectState.forEachWarpClip(
                    [&](const silverdaw::ProjectState::WarpClipInfo& info)
                    {
                        if (info.libraryItemId != itemId) return;
                        ++scanned;
                        DBG("[warp/late-flip]   candidate clip=" + info.clipId
                            + " pendingAutoWarp=" + (info.pendingAutoWarp ? "true" : "false")
                            + " warpEnabled=" + (info.warpEnabled ? "true" : "false"));
                        if (info.pendingAutoWarp && projectBpm > 0.0)
                        {
                            const double ratio = projectBpm / analysis.bpm;
                            projectState.setClipWarp(info.clipId,
                                /*enabled=*/true,
                                juce::String("rhythmic"),
                                /*tempoRatio=*/std::nullopt,
                                /*tempoRatioClear=*/false,
                                std::nullopt, std::nullopt,
                                /*pendingAutoWarp=*/false);
                            engine.setClipWarp(info.clipId, true,
                                juce::String("rhythmic"), ratio, std::nullopt, std::nullopt);
                            auto wp = buildClipWarpAppliedPayload(projectState, info.clipId);
                            bridge.broadcast("CLIP_WARP_APPLIED", juce::var(wp.release()));
                            ++flipped;
                            DBG("[warp/late-flip]   → ENGAGED clip=" + info.clipId
                                + " ratio=" + juce::String(ratio));
                        }
                    });
                DBG("[warp/late-flip] itemId=" + itemId + " scanned=" + juce::String(scanned)
                    + " flipped=" + juce::String(flipped));
            }

            // Seed the project BPM (the helper checks its own gates).
            maybeSeedProjectBpmFor(itemId, projectState, bridge);
            {
                std::lock_guard<std::mutex> lock(bpmJobsMutex);
                bpmJobsInFlight.erase(itemId);
            }
        });
}
} // namespace

void ensureBpmDetection(const juce::String& filePath, AudioEngine& engine, ProjectState& projectState,
                        BridgeServer& bridge, juce::ThreadPool& peakPool, const DecodedCache& decodedCache)
{
    if (filePath.isEmpty()) return;
    const juce::String itemId = findLibraryItemIdForPath(projectState, filePath);
    if (itemId.isEmpty()) return; // No library item to attach BPM to.
    if (projectState.getLibraryItemBpmForPath(filePath) > 0.0) return; // Already known.
    {
        std::lock_guard<std::mutex> lock(bpmJobsMutex);
        if (bpmJobsInFlight.find(itemId) != bpmJobsInFlight.end())
        {
            silverdaw::log::debug("bpmjob", "skip duplicate in-flight itemId=" + itemId);
            return;
        }
        bpmJobsInFlight.insert(itemId);
    }
    peakPool.addJob(
        [itemId, file = juce::File(filePath), &engine, &projectState, &bridge, &decodedCache]
        { runBpmDetection(itemId, file, engine, projectState, bridge, decodedCache); });
}

void forceLibraryItemAnalysis(const juce::String& itemId, const juce::String& filePath, AudioEngine& engine,
                              ProjectState& projectState, BridgeServer& bridge, juce::ThreadPool& peakPool,
                              const DecodedCache& decodedCache)
{
    if (itemId.isEmpty() || filePath.isEmpty()) return;
    {
        std::lock_guard<std::mutex> lock(bpmJobsMutex);
        if (bpmJobsInFlight.find(itemId) != bpmJobsInFlight.end())
        {
            silverdaw::log::debug("bpmjob", "skip duplicate in-flight reanalysis itemId=" + itemId);
            return;
        }
        bpmJobsInFlight.insert(itemId);
    }
    projectState.clearLibraryItemAnalysis(itemId);
    peakPool.addJob(
        [itemId, file = juce::File(filePath), &engine, &projectState, &bridge, &decodedCache]
        { runBpmDetection(itemId, file, engine, projectState, bridge, decodedCache, true); });
}

void ensureDecodedCache(const juce::String& sourceFilePath, AudioEngine& engine, ProjectState& projectState,
                        juce::ThreadPool& peakPool, const DecodedCache& decodedCache)
{
    if (sourceFilePath.isEmpty()) return;
    const juce::File source(sourceFilePath);
    if (!source.existsAsFile()) return;
    if (decodedCache.getCacheFilePath(source).existsAsFile()) return;

    peakPool.addJob(
        [src = source, &engine, &projectState, &decodedCache]
        {
            const auto built = decodedCache.ensureDecoded(src, engine.getFormatManager());
            if (!built.existsAsFile()) return;
            const auto cachePath = built.getFullPathName();
            const auto sourcePath = src.getFullPathName();
            juce::MessageManager::callAsync(
                [&projectState, sourcePath, cachePath]
                {
                    const auto itemId = findLibraryItemIdForPath(projectState, sourcePath);
                    if (itemId.isNotEmpty())
                    {
                        projectState.setLibraryItemPlaybackPath(itemId, cachePath);
                    }
                });
        });
}

} // namespace silverdaw
