#include "ProjectSession.h"

#include "AudioEngine.h"
#include "DecodedCache.h"
#include "EnginePlaybackPath.h"
#include "LibraryAnalysis.h"
#include "Log.h"
#include "ProjectState.h"
#include "SharedFx.h"

#include <algorithm>
#include <optional>

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
    // Omit default (zero) bar settings so legacy projects round-trip byte-clean.
    {
        const auto barCounterStart = projectState.getBarCounterStart();
        if (barCounterStart != 0) obj->setProperty("barCounterStart", barCounterStart);
        const auto mixdownStartBar = projectState.getMixdownStartBar();
        if (mixdownStartBar != 0) obj->setProperty("mixdownStartBar", mixdownStartBar);
    }
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
            // Match clip ingest: prefer decoded WAVs over compressed engine sources.
            const juce::String engineFilePath =
                silverdaw::resolveEnginePlaybackPath(filePath, projectState, decodedCache);
            if (engineFilePath == filePath)
            {
                silverdaw::ensureDecodedCache(filePath, engine, projectState, peakPool, decodedCache);
            }
            juce::String err;
            // Use effective gain so mute/solo state is audible immediately after load.
            const auto trackId = track.getProperty("id").toString();
            const auto effectiveGain = projectState.getEffectiveTrackGain(trackId);
            if (engine.addClip(trackId, clipId, juce::File(engineFilePath), offsetMs, inMs, durationMs, effectiveGain, &err))
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
    static const char* kCategories[] = {"Stems", "Samples"};

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
