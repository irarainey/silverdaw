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
    // Seeding only makes sense once the analysed item has a stored BPM.
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
    // User classification wins; non-musical samples must not seed tempo.
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

    // Gate 2: another BPM means the seed already ran on an earlier import.
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
// Applies analysis fields to a library item, broadcasts LIBRARY_ITEM_ANALYSIS,
// performs late auto-warp for the item's pending clips, and seeds project BPM.
// Runs on the message thread. Returns false if the item vanished before applying.
bool applyAndBroadcastItemAnalysis(const juce::String& itemId, double bpm,
                                   const std::vector<double>& beats, double beatAnchorSec,
                                   bool variableTempo, bool lowConfidence,
                                   const juce::String& cachedPath, AudioEngine& engine,
                                   ProjectState& projectState, BridgeServer& bridge)
{
    // setLibraryItemBpm returns false only when the item is gone (also our guard).
    if (!projectState.setLibraryItemBpm(itemId, bpm))
    {
        silverdaw::log::warn("bpmjob", "library item " + itemId + " gone before analysis applied");
        return false;
    }
    projectState.setLibraryItemBeats(itemId, beats);
    projectState.setLibraryItemBeatAnchor(itemId, beatAnchorSec);
    projectState.setLibraryItemVariableTempo(itemId, variableTempo);
    projectState.setLibraryItemLowConfidence(itemId, lowConfidence);
    if (cachedPath.isNotEmpty())
    {
        projectState.setLibraryItemPlaybackPath(itemId, cachedPath);
    }

    auto* p = new juce::DynamicObject();
    p->setProperty("itemId", itemId);
    p->setProperty("bpm", bpm);
    p->setProperty("beatAnchorSec", beatAnchorSec);
    juce::Array<juce::var> beatArr;
    beatArr.ensureStorageAllocated(static_cast<int>(beats.size()));
    for (double t : beats) beatArr.add(juce::var(t));
    p->setProperty("beats", juce::var(beatArr));
    p->setProperty("variableTempo", variableTempo);
    p->setProperty("lowConfidence", lowConfidence);
    if (cachedPath.isNotEmpty())
    {
        p->setProperty("playbackFilePath", cachedPath);
    }
    bridge.broadcast("LIBRARY_ITEM_ANALYSIS", juce::var(p));

    // Late auto-warp preserves the user's drop-time intent once stable BPM is known.
    if (!variableTempo && !lowConfidence && bpm > 0.0)
    {
        const double projectBpm = projectState.getBpm();
        projectState.forEachWarpClip(
            [&](const silverdaw::ProjectState::WarpClipInfo& info)
            {
                if (info.libraryItemId != itemId) return;
                if (info.pendingAutoWarp && projectBpm > 0.0)
                {
                    const double ratio = projectBpm / bpm;
                    projectState.setClipWarp(info.clipId, /*enabled=*/true, juce::String("rhythmic"),
                                             /*tempoRatio=*/std::nullopt, /*tempoRatioClear=*/false,
                                             std::nullopt, std::nullopt, /*pendingAutoWarp=*/false);
                    engine.setClipWarp(info.clipId, true, juce::String("rhythmic"), ratio,
                                       std::nullopt, std::nullopt);
                    auto wp = buildClipWarpAppliedPayload(projectState, info.clipId);
                    bridge.broadcast("CLIP_WARP_APPLIED", juce::var(wp.release()));
                }
            });
    }

    maybeSeedProjectBpmFor(itemId, projectState, bridge);
    return true;
}

// Worker analysis must marshal ValueTree writes and broadcasts to the message thread.
void runBpmDetection(const juce::String& itemId, const juce::File& filePath,
                     AudioEngine& engine, ProjectState& projectState,
                     BridgeServer& bridge, const DecodedCache& decodedCache,
                     bool recreateDecodedCache = false)
{
    silverdaw::log::info("bpmjob", "start itemId=" + itemId + " file=" + filePath.getFileName());

    // Decode once so later clip adds use cheap PCM instead of block-time decoding.
    const auto cachedFile = recreateDecodedCache
                                ? decodedCache.recreateDecoded(filePath, engine.getFormatManager())
                                : decodedCache.ensureDecoded(filePath, engine.getFormatManager());
    const juce::String cachedPath = cachedFile.existsAsFile() ? cachedFile.getFullPathName() : juce::String();

    // Analyse the cached WAV so beat times match playback.
    const juce::File analysisFile = cachedFile.existsAsFile() ? cachedFile : filePath;
    silverdaw::BpmDetector detector;
    const silverdaw::BpmAnalysis analysis = detector.analyse(analysisFile, engine.getFormatManager());
    if (analysis.bpm <= 0.0)
    {
        silverdaw::log::info("bpmjob", "no plausible BPM for itemId=" + itemId);
        // Still publish the cache path so future clip adds use the WAV.
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
            applyAndBroadcastItemAnalysis(itemId, analysis.bpm, analysis.beatTimesSec,
                                          analysis.beatAnchorSec, analysis.variableTempo,
                                          analysis.lowConfidence, cachedPath, engine, projectState,
                                          bridge);
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

void inheritAnalysisFromSource(const juce::String& itemId, const juce::String& sourceItemId,
                               AudioEngine& engine, ProjectState& projectState, BridgeServer& bridge)
{
    if (itemId.isEmpty() || sourceItemId.isEmpty()) return;
    const auto& root = projectState.getTree();
    const auto library = root.getChildWithName(juce::Identifier{"LIBRARY"});
    if (!library.isValid()) return;

    juce::ValueTree source;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(juce::Identifier{"id"}).toString() == sourceItemId)
        {
            source = item;
            break;
        }
    }
    if (!source.isValid())
    {
        silverdaw::log::warn("bpmjob", "stem " + itemId + " source " + sourceItemId + " not found");
        return;
    }

    // Stems are sample-aligned with the source file, so its beat grid applies directly.
    const double bpm = static_cast<double>(source.getProperty(juce::Identifier{"bpm"}, 0.0));
    const double beatAnchorSec = static_cast<double>(source.getProperty(juce::Identifier{"beatAnchorSec"}, 0.0));
    const bool variableTempo = static_cast<bool>(source.getProperty(juce::Identifier{"variableTempo"}, false));
    const juce::String key = source.getProperty(juce::Identifier{"key"}, juce::String{}).toString();

    std::vector<double> beats;
    if (const auto beatsVar = source.getProperty(juce::Identifier{"beats"}); beatsVar.isArray())
    {
        if (auto* arr = beatsVar.getArray())
        {
            beats.reserve(static_cast<size_t>(arr->size()));
            for (const auto& b : *arr) beats.push_back(static_cast<double>(b));
        }
    }

    if (key.isNotEmpty()) projectState.setLibraryItemKey(itemId, key);
    // A stem has no independent confidence measurement; leave its lowConfidence
    // unset so it defers its sample/music classification to the source (the stem
    // carries derivedFrom.sourceItemId). This keeps a stem visible as music
    // whenever the user marks the source as music.
    applyAndBroadcastItemAnalysis(itemId, bpm, beats, beatAnchorSec, variableTempo, /*lowConfidence=*/false,
                                  juce::String{}, engine, projectState, bridge);
    silverdaw::log::info("bpmjob", "inherited analysis for stem " + itemId + " from source "
                                       + sourceItemId + " bpm=" + juce::String(bpm, 4));
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
