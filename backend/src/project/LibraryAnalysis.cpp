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

// Build a rigid metronome grid phase-locked to `beatAnchorSec`, spanning the
// item's window [0, durationSec]. The renderer derives marker positions from
// (bpm, anchor) directly and only needs `beats` to be non-empty; a full grid
// also keeps the info-dialog count and any beat-position consumers honest. The
// anchor may be negative (a derived stem whose window starts past the source's
// grid origin) — the first emitted beat is still the earliest on-grid position
// at or after local time 0. Returns empty for a non-positive bpm.
std::vector<double> buildRigidBeatGrid(double bpm, double beatAnchorSec, double durationMs)
{
    std::vector<double> beats;
    if (bpm <= 0.0) return beats;
    const double beatSpacingSec = 60.0 / bpm;
    if (beatSpacingSec <= 0.0) return beats;
    const double endSec = durationMs > 0.0 ? durationMs / 1000.0 : beatAnchorSec + beatSpacingSec;
    // First grid beat at or after 0s, phase-locked to the anchor.
    double firstSec = beatAnchorSec;
    if (firstSec > 0.0)
        firstSec -= std::floor(firstSec / beatSpacingSec) * beatSpacingSec;
    else
        firstSec += std::ceil(-firstSec / beatSpacingSec) * beatSpacingSec;
    constexpr int kMaxBeats = 100000;
    int guard = 0;
    for (double t = firstSec; t <= endSec + 1.0e-6 && guard < kMaxBeats; t += beatSpacingSec, ++guard)
        beats.push_back(t);
    if (beats.empty())
        beats.push_back(beatAnchorSec);
    return beats;
}
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
    // App preference (default on): when off, the first clip must not establish
    // the project tempo. The renderer keeps this in sync on connect / change.
    if (!projectState.seedProjectTempoFromFirstClip())
    {
        silverdaw::log::info("bpmjob",
                             "seed skipped for itemId=" + itemId + " (seed-from-first-clip preference off)");
        return;
    }
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
    juce::String itemAudioType;
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
            itemAudioType = item.getProperty(juce::Identifier{"audioType"}, juce::var("")).toString();
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
    // Only an explicit user "simple" classification blocks tempo seeding. A
    // low-confidence auto-detection still seeds: the very first musical clip on
    // a track should establish the project tempo (the seeded flag below ensures
    // this only fires once), rather than leaving the default because the
    // detector was merely unsure.
    if (itemAudioType == "simple")
    {
        silverdaw::log::info(
            "bpmjob",
            "seed skipped for itemId=" + itemId
                + " (user-classified as simple — lowConfidence="
                + (itemLowConfidence ? "true" : "false") + ")");
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

    // Gate 2: only seed once. The project tempo is established by the first
    // musical clip placed on a track; later clips (and derived stems, which
    // inherit a BPM without ever seeding) must not override it. The flag is the
    // authoritative signal — counting library items with a BPM mis-fired when
    // stems were separated from a library-only source before any clip was
    // dropped, leaving the project stuck at the default tempo.
    if (projectState.isBpmSeeded())
    {
        silverdaw::log::info("bpmjob",
                             "seed skipped for itemId=" + itemId + " (project BPM already seeded)");
        return;
    }

    // All gates passed: this is the first seed for the project.
    projectState.setBpmSeeded(true);

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
                                   ProjectState& projectState, BridgeServer& bridge,
                                   juce::UndoManager* undo = nullptr)
{
    if (undo != nullptr)
    {
        // User-driven manual tempo: an undoable, dirtying edit (variable /
        // low-confidence flags are always cleared for a hand-set grid).
        if (!projectState.setLibraryItemManualTempo(itemId, bpm, beats, beatAnchorSec))
        {
            silverdaw::log::warn("bpmjob", "library item " + itemId + " gone before manual tempo applied");
            return false;
        }
    }
    else
    {
        // Automatic analysis: derived, non-dirtying, non-undoable metadata.
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
    }
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
    // Mark a user-driven manual tempo so the renderer does NOT auto-align placed
    // clips on this echo (manual grid edits re-align only on Clip Editor Save);
    // automatic analysis leaves the flag off and still aligns on import.
    if (undo != nullptr)
    {
        p->setProperty("manual", true);
    }
    bridge.broadcast("LIBRARY_ITEM_ANALYSIS", juce::var(p));

    // Late auto-warp preserves the user's drop-time intent once stable BPM is
    // known. Low detection confidence no longer blocks this: a low-confidence
    // grid is still treated as music (shown + warpable), matching the frontend
    // classification. Only a genuinely variable tempo or an unanalysed BPM skip
    // the auto-warp, since force-warping those to a single ratio is unsafe.
    if (!variableTempo && bpm > 0.0)
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
    // Keep the monitoring metronome in time if this analysis just (re)seeded the project tempo.
    engine.setMetronomeBpm(projectState.getBpm());
    return true;
}

// Worker analysis must marshal ValueTree writes and broadcasts to the message thread.
void runBpmDetection(const juce::String& itemId, const juce::File& filePath,
                     AudioEngine& engine, ProjectState& projectState,
                     BridgeServer& bridge, const DecodedCache& decodedCache,
                     bool recreateDecodedCache = false)
{
    silverdaw::log::info("bpmjob", "start itemId=" + itemId + " file=" + filePath.getFileName());

    // Analysis must run on decoded PCM. ensureDecoded returns the source
    // unchanged when it is already a readable WAV, a cached WAV for decodable
    // compressed formats, or an invalid file when the source can't be decoded
    // (e.g. a raw .m4a/.aac — the backend has no reader for those; the renderer
    // decodes them to a WAV whose path is resolved upstream). Never fall back to
    // analysing a non-WAV: the detector can't read it and the import would hang
    // waiting on a result that never comes.
    const auto cachedFile = recreateDecodedCache
                                ? decodedCache.recreateDecoded(filePath, engine.getFormatManager())
                                : decodedCache.ensureDecoded(filePath, engine.getFormatManager());
    const bool haveWav = cachedFile.existsAsFile() && cachedFile.hasFileExtension("wav");
    const juce::String cachedPath = haveWav ? cachedFile.getFullPathName() : juce::String();

    silverdaw::BpmAnalysis analysis; // bpm 0 by default → treated as "no tempo"
    if (haveWav)
    {
        silverdaw::BpmDetector detector;
        analysis = detector.analyse(cachedFile, engine.getFormatManager());
    }
    else
    {
        silverdaw::log::warn("bpmjob", "no decoded WAV to analyse for itemId=" + itemId + " file="
                                           + filePath.getFileName() + " — skipping tempo detection");
    }

    if (analysis.bpm <= 0.0)
    {
        const bool didTimeOut = analysis.timedOut;
        silverdaw::log::info("bpmjob", juce::String(didTimeOut ? "tempo detection timed out" : "no plausible BPM")
                                           + " for itemId=" + itemId);
        // Always broadcast an empty analysis so the import UI clears its
        // "Analysing tempo…" stage, even when a file has no detectable tempo or
        // couldn't be decoded. Publish the cache path when we have one so future
        // clip adds reuse the WAV. `timedOut` tells the renderer to toast so the
        // user knows they can reanalyse.
        juce::MessageManager::callAsync(
            [itemId, cachedPath, didTimeOut, &projectState, &bridge]
            {
                projectState.clearLibraryItemAnalysis(itemId);
                if (cachedPath.isNotEmpty())
                    projectState.setLibraryItemPlaybackPath(itemId, cachedPath);
                auto* p = new juce::DynamicObject();
                p->setProperty("itemId", itemId);
                p->setProperty("bpm", 0.0);
                p->setProperty("beatAnchorSec", 0.0);
                p->setProperty("beats", juce::var(juce::Array<juce::var>{}));
                p->setProperty("variableTempo", false);
                p->setProperty("playbackFilePath", cachedPath);
                if (didTimeOut) p->setProperty("timedOut", true);
                bridge.broadcast("LIBRARY_ITEM_ANALYSIS", juce::var(p));
            });
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

void applyManualTempo(const juce::String& itemId, double bpm, double beatAnchorSec,
                      AudioEngine& engine, ProjectState& projectState, BridgeServer& bridge)
{
    if (bpm <= 0.0)
    {
        silverdaw::log::warn("bpmjob", "applyManualTempo ignored non-positive bpm for itemId=" + itemId);
        return;
    }

    // Build a rigid metronome grid from the anchor across the source duration so
    // markers render and beat-position consumers stay honest (see buildRigidBeatGrid).
    const double durationMs = projectState.getLibraryItemDurationMs(itemId);
    std::vector<double> beats = buildRigidBeatGrid(bpm, beatAnchorSec, durationMs);

    silverdaw::log::info("bpmjob",
                         "applyManualTempo itemId=" + itemId + " bpm=" + juce::String(bpm, 2)
                             + " anchor=" + juce::String(beatAnchorSec, 3) + "s beats="
                             + juce::String(static_cast<int>(beats.size())));

    applyAndBroadcastItemAnalysis(itemId, bpm, beats, beatAnchorSec, /*variableTempo=*/false,
                                  /*lowConfidence=*/false, /*cachedPath=*/juce::String{}, engine,
                                  projectState, bridge, &projectState.getUndoManager());
}

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
    // Detection must run on decoded PCM. Compressed non-native sources (.m4a /
    // .aac) can't be read by the backend's format manager; the renderer decodes
    // them to a WAV and stores its path on the library item, so resolve to that
    // WAV here (native sources resolve to themselves and are decoded inside the
    // job). This keeps analysis on a readable WAV regardless of import format,
    // mirroring what LIBRARY_REANALYSE already does.
    const juce::String analysisPath = resolveEnginePlaybackPath(filePath, projectState, decodedCache);
    peakPool.addJob(
        [itemId, file = juce::File(analysisPath), &engine, &projectState, &bridge, &decodedCache]
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
    juce::ValueTree stem;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        const auto id = item.getProperty(juce::Identifier{"id"}).toString();
        if (id == sourceItemId) source = item;
        if (id == itemId) stem = item;
    }
    if (!source.isValid())
    {
        silverdaw::log::warn("bpmjob", "stem " + itemId + " source " + sourceItemId + " not found");
        return;
    }

    // A clip-scoped separation extracts only the source clip's window
    // ([inMs, inMs+durationMs)), so the stem WAV's sample 0 is source-time
    // `inMs`, not 0. The source's grid is expressed in source time, so shift it
    // back by the window start to land on the stem's own timeline. The shift
    // always derives from the (unshifted) source, so re-running this is
    // idempotent. A full-source/library separation has no offset (shift = 0).
    const double windowStartSec =
        stem.isValid()
            ? juce::jmax(0.0, static_cast<double>(stem.getProperty(juce::Identifier{"sourceInMs"}, 0.0))) / 1000.0
            : 0.0;

    const double bpm = static_cast<double>(source.getProperty(juce::Identifier{"bpm"}, 0.0));
    const double beatAnchorSec =
        static_cast<double>(source.getProperty(juce::Identifier{"beatAnchorSec"}, 0.0)) - windowStartSec;
    const bool variableTempo = static_cast<bool>(source.getProperty(juce::Identifier{"variableTempo"}, false));
    const juce::String key = source.getProperty(juce::Identifier{"key"}, juce::String{}).toString();

    std::vector<double> beats;
    if (const auto beatsVar = source.getProperty(juce::Identifier{"beats"}); beatsVar.isArray())
    {
        if (auto* arr = beatsVar.getArray())
        {
            beats.reserve(static_cast<size_t>(arr->size()));
            for (const auto& b : *arr)
            {
                const double shifted = static_cast<double>(b) - windowStartSec;
                if (shifted >= 0.0) beats.push_back(shifted);
            }
        }
    }

    // A window that begins after the source's last detected beat drops every
    // shifted beat, leaving `beats` empty even though the inherited (bpm, anchor)
    // fully describe the grid. Without any beats the renderer's marker gate hides
    // the grid entirely, so synthesise a rigid grid across the stem's own window
    // from the same (bpm, anchor) the markers are drawn from. In-window beats are
    // preserved as-is so a variable-tempo source keeps its detected phrasing.
    if (beats.empty() && bpm > 0.0)
        beats = buildRigidBeatGrid(bpm, beatAnchorSec, projectState.getLibraryItemDurationMs(itemId));

    if (key.isNotEmpty()) projectState.setLibraryItemKey(itemId, key);
    // A stem has no independent confidence measurement; leave its lowConfidence
    // unset so it defers its sample/music classification to the source (the stem
    // carries derivedFrom.sourceItemId). This keeps a stem visible as music
    // whenever the user marks the source as music.
    applyAndBroadcastItemAnalysis(itemId, bpm, beats, beatAnchorSec, variableTempo, /*lowConfidence=*/false,
                                  juce::String{}, engine, projectState, bridge);
    silverdaw::log::info("bpmjob", "inherited analysis for stem " + itemId + " from source "
                                       + sourceItemId + " bpm=" + juce::String(bpm, 4)
                                       + " windowStart=" + juce::String(windowStartSec, 4) + "s"
                                       + " anchor=" + juce::String(beatAnchorSec, 4) + "s");
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
