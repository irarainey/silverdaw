#include "ProjectSession.h"

#include "AudioEngine.h"
#include "DecodedCache.h"
#include "EnginePlaybackPath.h"
#include "LibraryAnalysis.h"
#include "Log.h"
#include "ProjectState.h"
#include "SharedFx.h"

#include <algorithm>
#include <atomic>
#include <optional>
#include <unordered_map>
#include <vector>

namespace silverdaw
{

juce::StringArray collectClipIds(const silverdaw::ProjectState& projectState)
{
    juce::StringArray ids;
    const auto& root = projectState.getTree();
    for (int t = 0; t < root.getNumChildren(); ++t)
    {
        const auto track = root.getChild(t);
        for (int c = 0; c < track.getNumChildren(); ++c)
        {
            const auto clip = track.getChild(c);
            if (clip.hasType(juce::Identifier{"CLIP"}))
            {
                ids.add(clip.getProperty("id").toString());
            }
        }
    }
    return ids;
}

juce::var buildProjectStateEnvelope(const ProjectSession& session, const silverdaw::ProjectState& projectState,
                                    bool reset)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("filePath", session.currentPath.isEmpty() ? juce::var() : juce::var(session.currentPath));
    obj->setProperty("name", projectState.getName());
    // Authoritative unsaved-changes flag so incremental rebroadcasts (e.g. a
    // transition create) don't let the renderer drop the project's dirty state.
    obj->setProperty("dirty", projectState.isDirty());
    if (reset)
    {
        obj->setProperty("reset", true);
    }
    obj->setProperty("tracks", projectState.tracksAsJson());
    obj->setProperty("library", projectState.libraryAsJson());
    obj->setProperty("markers", projectState.markersAsJson());
    obj->setProperty("viewPxPerSecond", projectState.getViewPxPerSecond());
    obj->setProperty("viewScrollX", projectState.getViewScrollX());
    obj->setProperty("viewSelectedTrack", projectState.getViewSelectedTrack());
    obj->setProperty("viewFxPanelOpen", projectState.getViewFxPanelOpen());
    obj->setProperty("playheadMs", projectState.getPlayheadMs());
    obj->setProperty("bpm", projectState.getBpm());
    obj->setProperty("projectLengthMs", projectState.getProjectLengthMs());
    // Null lets the renderer distinguish unset from explicitly cleared.
    {
        const auto outType = projectState.getAudioOutputTypeName();
        const auto outDevice = projectState.getAudioOutputDeviceName();
        obj->setProperty("audioOutputTypeName", outType.isEmpty() ? juce::var() : juce::var(outType));
        obj->setProperty("audioOutputDeviceName", outDevice.isEmpty() ? juce::var() : juce::var(outDevice));
    }
    // Omit absent project sample-rate overrides so user-scope defaults still apply.
    {
        const auto rate = projectState.getTargetSampleRate();
        if (rate > 0) obj->setProperty("targetSampleRate", rate);
    }
    // Renderer-owned export settings are absent until first export.
    {
        const auto exportSettings = projectState.getExportSettingsJson();
        if (exportSettings.isNotEmpty()) obj->setProperty("exportSettingsJson", exportSettings);
    }
    // Omit unity master volume so legacy projects round-trip without extra fields.
    {
        const auto masterVolume = projectState.getMasterVolume();
        if (! juce::approximatelyEqual(masterVolume, 1.0F))
            obj->setProperty("masterVolume", masterVolume);
    }
    // Omit default (one) bar settings so legacy projects round-trip byte-clean.
    {
        const auto barCounterStart = projectState.getBarCounterStart();
        if (barCounterStart != 1) obj->setProperty("barCounterStart", barCounterStart);
        const auto mixdownStartBar = projectState.getMixdownStartBar();
        if (mixdownStartBar != 1) obj->setProperty("mixdownStartBar", mixdownStartBar);
    }
    // Omit the default-off metronome so legacy projects round-trip byte-clean.
    if (projectState.getMetronomeEnabled()) obj->setProperty("metronomeEnabled", true);
    if (projectState.getClipEditorMetronomeEnabled())
        obj->setProperty("clipEditorMetronomeEnabled", true);
    // Emit only non-default shared FX so legacy projects stay byte-clean.
    {
        const auto emitUnit = [obj](const char* key, float v) {
            if (v > 1.0e-4f) obj->setProperty(key, v);
        };
        emitUnit("reverbSize", projectState.getProjectReverbSize());
        emitUnit("reverbDecay", projectState.getProjectReverbDecay());
        emitUnit("reverbTone", projectState.getProjectReverbTone());
        emitUnit("reverbMix", projectState.getProjectReverbMix());
        const auto noteValue = projectState.getProjectDelayNoteValue();
        if (noteValue != "1/8") obj->setProperty("delayNoteValue", noteValue);
        emitUnit("delayFeedback", projectState.getProjectDelayFeedback());
        emitUnit("delayTone", projectState.getProjectDelayTone());
        emitUnit("delayMix", projectState.getProjectDelayMix());
    }
    return juce::var(obj);
}

juce::var buildSoftReplaceProjectStateEnvelope(const ProjectSession& session,
                                                silverdaw::ProjectState& projectState)
{
    auto envelope = buildProjectStateEnvelope(session, projectState, false);
    if (auto* obj = envelope.getDynamicObject())
    {
        obj->setProperty("softReplace", true);
    }
    return envelope;
}

void rebuildEngineFromProject(silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                              juce::ThreadPool& peakPool, const silverdaw::DecodedCache& decodedCache)
{
    const auto& root = projectState.getTree();
    int rebuilt = 0;
    int failed = 0;

    // Open every clip's audio reader up front, in parallel, BEFORE the serial attach loop below.
    // Per-clip opens (file header reads) are I/O-bound and, done one-at-a-time on the message
    // thread, dominate cold-load latency — especially for cloud-synced project directories.
    // Overlapping them across a few workers cuts that cost; the actual audio-graph mutation still
    // happens serially on the message thread in the loop below, so real-time safety is unchanged.
    struct PreopenedReader
    {
        juce::String engineFilePath;
        std::unique_ptr<juce::AudioFormatReader> reader;
    };
    std::unordered_map<juce::String, PreopenedReader> preopened;
    {
        std::vector<juce::String> orderedClipIds;
        for (int t = 0; t < root.getNumChildren(); ++t)
        {
            const auto track = root.getChild(t);
            if (!track.hasType(juce::Identifier{"TRACK"})) continue;
            for (int c = 0; c < track.getNumChildren(); ++c)
            {
                const auto clip = track.getChild(c);
                if (!clip.hasType(juce::Identifier{"CLIP"})) continue;
                const juce::String clipId = clip.getProperty("id").toString();
                const juce::String libraryItemId = clip.getProperty("libraryItemId", {}).toString();
                const juce::String filePath = projectState.getLibraryItemFilePath(libraryItemId);
                if (clipId.isEmpty() || libraryItemId.isEmpty() || filePath.isEmpty()) continue;
                // Resolve the playback path (decoded WAV preferred) on the message thread — it can
                // touch projectState — before the workers, which only read files, start.
                const juce::String engineFilePath =
                    silverdaw::resolveEnginePlaybackPath(filePath, projectState, decodedCache);
                if (preopened.emplace(clipId, PreopenedReader{engineFilePath, nullptr}).second)
                    orderedClipIds.push_back(clipId);
            }
        }
        if (!orderedClipIds.empty())
        {
            // Open on the PERSISTENT peak worker pool (not transient threads): a Media Foundation
            // reader for a compressed source holds COM objects tied to its creating thread, so the
            // opener thread must outlive the reader — exactly why the shipped AUDIO_FILE_PROBE path
            // uses this pool too. ensureDecodedCache is deferred to the attach loop below so its
            // decode jobs never contend with these opens.
            const double tOpen0 = juce::Time::getMillisecondCounterHiRes();
            std::atomic<int> remaining{static_cast<int>(orderedClipIds.size())};
            juce::WaitableEvent allOpened;
            for (const auto& clipId : orderedClipIds)
            {
                peakPool.addJob(
                    [&engine, &preopened, &remaining, &allOpened, clipId]
                    {
                        // Keys are pre-inserted, so find() never mutates the map and each job
                        // writes a distinct element — safe without a lock.
                        const auto it = preopened.find(clipId);
                        it->second.reader =
                            engine.createReaderForClip(juce::File(it->second.engineFilePath));
                        if (remaining.fetch_sub(1, std::memory_order_acq_rel) == 1)
                            allOpened.signal();
                    });
            }
            allOpened.wait();
            silverdaw::log::info("project",
                                 "pre-opened " + juce::String(static_cast<int>(orderedClipIds.size())) +
                                     " clip reader(s) in " +
                                     juce::String(juce::Time::getMillisecondCounterHiRes() - tOpen0, 1) +
                                     " ms");
        }
    }

    for (int t = 0; t < root.getNumChildren(); ++t)
    {
        const auto track = root.getChild(t);
        if (!track.hasType(juce::Identifier{"TRACK"}))
        {
            continue;
        }
        // Snap non-default track Tone once so load/export start from steady state.
        {
            const auto toneTrackId = track.getProperty("id").toString();
            const float tBass = projectState.getTrackToneBassDb(toneTrackId);
            const float tMid = projectState.getTrackToneMidDb(toneTrackId);
            const float tTreble = projectState.getTrackToneTrebleDb(toneTrackId);
            const float tFilter = projectState.getTrackToneFilter(toneTrackId);
            if (tBass != 0.0F || tMid != 0.0F || tTreble != 0.0F || tFilter != 0.0F)
                engine.setTrackTone(toneTrackId, tBass, tMid, tTreble, tFilter, /*snap*/ true);

            // Restore non-zero Leveler only to avoid identity updates on flat projects.
            const float tLeveler = projectState.getTrackLevelerAmount(toneTrackId);
            if (tLeveler != 0.0F)
                engine.setTrackLeveler(toneTrackId, tLeveler, /*snap*/ true);

            // Restore sends only when non-zero to avoid identity updates.
            const float sReverb = projectState.getTrackReverbSend(toneTrackId);
            const float sDelay = projectState.getTrackDelaySend(toneTrackId);
            if (sReverb != 0.0F || sDelay != 0.0F)
                engine.setTrackSends(toneTrackId, sReverb, sDelay);

            // Restore pan only when off-centre to keep the engine's unity path.
            const float pan = projectState.getTrackPan(toneTrackId);
            if (pan != 0.0F)
                engine.setTrackPan(toneTrackId, pan);

            // Restore per-track effect automation lanes.
            const auto lanes = projectState.getTrackAutomationLanes(toneTrackId);
            for (const auto& lane : lanes)
            {
                const juce::String paramId =
                    lane.getProperty(juce::Identifier{"paramId"}, juce::var()).toString();
                const auto& pts = lane.getProperty(juce::Identifier{"points"}, juce::var());
                if (paramId.isNotEmpty() && pts.isArray())
                    engine.setTrackAutomation(toneTrackId, paramId, *pts.getArray());
            }
        }
        for (int c = 0; c < track.getNumChildren(); ++c)
        {
            const auto clip = track.getChild(c);
            if (!clip.hasType(juce::Identifier{"CLIP"}))
            {
                continue;
            }
            const juce::String clipId = clip.getProperty("id").toString();
            const juce::String libraryItemId = clip.getProperty("libraryItemId", {}).toString();
            const juce::String filePath = projectState.getLibraryItemFilePath(libraryItemId);
            const double offsetMs = static_cast<double>(clip.getProperty("offsetMs", 0.0));
            const double inMs = static_cast<double>(clip.getProperty("inMs", 0.0));
            const double durationMs = static_cast<double>(clip.getProperty("durationMs", 0.0));
            if (clipId.isEmpty() || libraryItemId.isEmpty() || filePath.isEmpty())
            {
                ++failed;
                silverdaw::log::warn("project", "skip clipId=" + clipId + " libraryItemId=" + libraryItemId +
                                                    " (no resolvable source)");
                continue;
            }
            // Reader + resolved path came from the parallel pre-open above; fall back to a
            // synchronous resolve/open only if this clip somehow wasn't pre-opened.
            const auto preIt = preopened.find(clipId);
            const juce::String engineFilePath =
                preIt != preopened.end()
                    ? preIt->second.engineFilePath
                    : silverdaw::resolveEnginePlaybackPath(filePath, projectState, decodedCache);
            if (engineFilePath == filePath)
            {
                silverdaw::ensureDecodedCache(filePath, engine, projectState, peakPool, decodedCache);
            }
            juce::String err;
            // Use effective gain so mute/solo state is audible immediately after load.
            const auto trackId = track.getProperty("id").toString();
            const auto effectiveGain = projectState.getEffectiveTrackGain(trackId);
            const bool added =
                (preIt != preopened.end() && preIt->second.reader != nullptr)
                    ? engine.addClip(trackId, clipId, std::move(preIt->second.reader),
                                     juce::File(engineFilePath), offsetMs, inMs, durationMs, effectiveGain,
                                     &err)
                    : engine.addClip(trackId, clipId, juce::File(engineFilePath), offsetMs, inMs,
                                     durationMs, effectiveGain, &err);
            if (added)
            {
                ++rebuilt;
                // Replay persisted warp so loaded clips match their saved tempo/pitch.
                const auto warpEnabled = static_cast<bool>(clip.getProperty("warpEnabled", false));
                if (warpEnabled)
                {
                    const auto warpMode = clip.getProperty("warpMode", "rhythmic").toString();
                    std::optional<double> tempoRatio;
                    if (clip.hasProperty("tempoRatio"))
                        tempoRatio = static_cast<double>(clip.getProperty("tempoRatio", 1.0));
                    else
                    {
                        // No pin: follow project BPM against source BPM.
                        const auto warpLibraryItemId = clip.getProperty("libraryItemId", {}).toString();
                        const double sourceBpm = projectState.getLibraryItemBpm(warpLibraryItemId);
                        const double projectBpm = projectState.getBpm();
                        if (sourceBpm > 0.0 && projectBpm > 0.0)
                            tempoRatio = projectBpm / sourceBpm;
                    }
                    const std::optional<double> semitones =
                        clip.hasProperty("semitones")
                            ? std::optional<double>{static_cast<double>(clip.getProperty("semitones", 0.0))}
                            : std::nullopt;
                    const std::optional<double> cents =
                        clip.hasProperty("cents")
                            ? std::optional<double>{static_cast<double>(clip.getProperty("cents", 0.0))}
                            : std::nullopt;
                    engine.setClipWarp(clipId, true, warpMode, tempoRatio, semitones, cents);
                }

                // Only clips with envelope points leave the no-op fast path.
                if (clip.hasProperty("envelopePoints"))
                {
                    const auto& envVar = clip.getProperty("envelopePoints");
                    if (envVar.isArray() && envVar.getArray()->size() > 0)
                    {
                        engine.setClipEnvelope(clipId, *envVar.getArray());
                    }
                }

                // Replay persisted reverse so loaded clips play backwards as saved.
                if (static_cast<bool>(clip.getProperty("reversed", false)))
                {
                    engine.setClipReversed(clipId, true);
                }

                // Replay persisted brake (turntable record-stop) with the engine defaults.
                if (static_cast<bool>(clip.getProperty("brake", false)))
                {
                    engine.setClipBrake(clipId, engine.getBrakeDefaultSeconds(),
                                        engine.getBrakeDefaultCurve());
                }
                if (static_cast<bool>(clip.getProperty("backspin", false)))
                {
                    engine.setClipBackspin(clipId, engine.getBackspinDefaultSeconds(),
                                           engine.getBackspinDefaultSpeed(),
                                           engine.getBackspinDefaultCurve());
                }
            }
            else
            {
                ++failed;
                silverdaw::log::warn("project", "addClip failed clipId=" + clipId + " path=" + filePath +
                                                     " err=" + err);
            }
        }
    }
    if (failed > 0)
    {
        silverdaw::log::warn("project",
                             "rebuilt " + juce::String(rebuilt) + " clip(s); " + juce::String(failed) +
                                 " failed (audio for those clips will be silent)");
    }
    // Load-time transition cleanup stays out of undo history before publishing fades.
    projectState.reconcileTransitions(/*useUndo*/ false);
    silverdaw::syncClipEdgeFades(engine, projectState);

    // Keep live master gain aligned with loaded, recovered, and undo/redo state.
    engine.setMasterGain(projectState.getMasterVolume());

    // Keep the monitoring metronome aligned with the loaded tempo + toggle state.
    engine.setMetronomeBpm(projectState.getBpm());
    engine.setMetronomeEnabled(projectState.getMetronomeEnabled());

    // Always reset shared FX on new/load so projects never inherit prior settings.
    engine.setProjectReverb(projectState.getProjectReverbSize(),
                            projectState.getProjectReverbDecay(),
                            projectState.getProjectReverbTone(),
                            projectState.getProjectReverbMix(), /*snap*/ true);
    engine.setProjectDelay(
        silverdaw::delayNoteToMs(projectState.getProjectDelayNoteValue(), projectState.getBpm()),
        projectState.getProjectDelayFeedback(), projectState.getProjectDelayTone(),
        projectState.getProjectDelayMix(), /*snap*/ true);
}

juce::File tempArtifactsRoot()
{
    return juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("Silverdaw");
}

juce::File projectArtifactsBaseDir(const juce::String& projectPath, const juce::String& subdir)
{
    if (projectPath.isNotEmpty())
    {
        const auto projectDir = juce::File(projectPath).getParentDirectory();
        if (projectDir.getFullPathName().isNotEmpty())
            return projectDir.getChildFile(subdir);
    }
    return tempArtifactsRoot().getChildFile(subdir);
}

namespace
{
// Move every child of `src` into `dest` (created on demand), recursing into
// subdirectories so an existing destination folder is merged, not replaced.
bool mergeMoveDirectory(const juce::File& src, const juce::File& dest)
{
    if (! src.isDirectory()) return true;
    if (! dest.isDirectory() && ! dest.createDirectory().wasOk()) return false;
    bool ok = true;
    for (const auto& child : src.findChildFiles(juce::File::findFilesAndDirectories, false))
    {
        const auto target = dest.getChildFile(child.getFileName());
        if (child.isDirectory())
        {
            ok = mergeMoveDirectory(child, target) && ok;
        }
        else
        {
            target.deleteFile();
            ok = child.moveFileTo(target) && ok;
        }
    }
    return ok;
}
} // namespace

void migrateTempArtifactsIntoProject(const juce::String& projectFilePath, AudioEngine& engine,
                                     ProjectState& projectState, juce::ThreadPool& peakPool,
                                     const DecodedCache& decodedCache)
{
    static const char* kCategories[] = {"stems", "samples"};

    const auto tempRoot = tempArtifactsRoot();
    const auto projectDir = juce::File(projectFilePath).getParentDirectory();
    if (! tempRoot.isDirectory() || projectDir.getFullPathName().isEmpty())
        return;

    const bool hasArtifacts = std::any_of(std::begin(kCategories), std::end(kCategories),
                                          [&](const char* c) { return tempRoot.getChildFile(c).isDirectory(); });
    if (! hasArtifacts)
    {
        // Stray empty workspace from a prior session: nothing to relocate, just clear it.
        tempRoot.deleteRecursively();
        return;
    }

    // The engine holds open readers on the temp WAVs; release them before the move.
    engine.stop();
    for (const auto& id : collectClipIds(projectState))
        engine.removeClip(id);

    for (const auto* category : kCategories)
    {
        const auto src = tempRoot.getChildFile(category);
        if (src.isDirectory() && ! mergeMoveDirectory(src, projectDir.getChildFile(category)))
            silverdaw::log::warn("project", juce::String("temp artifact move incomplete for ") + category);
    }

    const int rewritten = projectState.rebaseArtifactPaths(tempRoot, projectDir);

    // Re-open the relocated clip sources from their new project-folder paths.
    rebuildEngineFromProject(engine, projectState, peakPool, decodedCache);

    // The unsaved session's artifacts are now beside the project; clear the workspace.
    tempRoot.deleteRecursively();

    silverdaw::log::info("project", "migrated temp artifacts into project dir; rewrote " +
                                        juce::String(rewritten) + " path(s)");
}

} // namespace silverdaw
