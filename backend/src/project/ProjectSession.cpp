#include "ProjectSession.h"

#include "AudioEngine.h"
#include "DecodedCache.h"
#include "EnginePlaybackPath.h"
#include "LibraryAnalysis.h"
#include "Log.h"
#include "ProjectState.h"
#include "SharedFx.h"

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
    // Per-project preferred audio output. Emit as null when no
    // preference is set so the renderer can distinguish "absent" from
    // "explicitly cleared".
    {
        const auto outType = projectState.getAudioOutputTypeName();
        const auto outDevice = projectState.getAudioOutputDeviceName();
        obj->setProperty("audioOutputTypeName", outType.isEmpty() ? juce::var() : juce::var(outType));
        obj->setProperty("audioOutputDeviceName", outDevice.isEmpty() ? juce::var() : juce::var(outDevice));
    }
    // Per-project target sample rate (Hz). Emit only when set so the
    // renderer can distinguish "absent → use user-scope default"
    // from "explicit project value".
    {
        const auto rate = projectState.getTargetSampleRate();
        if (rate > 0) obj->setProperty("targetSampleRate", rate);
    }
    // Persisted export-dialog settings (opaque JSON, renderer-owned schema).
    // Absent until the user runs an export at least once on this project.
    {
        const auto exportSettings = projectState.getExportSettingsJson();
        if (exportSettings.isNotEmpty()) obj->setProperty("exportSettingsJson", exportSettings);
    }
    // Master output volume. Omitted when at unity (1.0) so legacy
    // projects round-trip without an extra field; renderer falls
    // back to 1.0 when absent.
    {
        const auto masterVolume = projectState.getMasterVolume();
        if (! juce::approximatelyEqual(masterVolume, 1.0F))
            obj->setProperty("masterVolume", masterVolume);
    }
    // Project-shared Reverb + Delay. Each scalar is emitted
    // only when non-default so the Track FX Reverb / Delay modules restore
    // after a reload while legacy projects round-trip byte-clean (the
    // renderer reads each field as optional and falls back to the
    // inaudible default when absent). The audio engine restores these
    // separately in rebuildEngineFromProject.
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
        // Phase 5 — restore persisted per-track Tone EQ. Pushed once per
        // track (independent of clips) and snapped so the response is
        // steady-state immediately, matching offline export. Only push
        // when non-default so a freshly-loaded flat project doesn't
        // hammer the audio thread with identity updates.
        {
            const auto toneTrackId = track.getProperty("id").toString();
            const float tBass = projectState.getTrackToneBassDb(toneTrackId);
            const float tMid = projectState.getTrackToneMidDb(toneTrackId);
            const float tTreble = projectState.getTrackToneTrebleDb(toneTrackId);
            const bool tLowCut = projectState.getTrackToneLowCut(toneTrackId);
            const bool tHighCut = projectState.getTrackToneHighCut(toneTrackId);
            if (tBass != 0.0F || tMid != 0.0F || tTreble != 0.0F || tLowCut || tHighCut)
                engine.setTrackTone(toneTrackId, tBass, tMid, tTreble, tLowCut, tHighCut, /*snap*/ true);

            // Phase 5 — restore persisted per-track Leveler Amount. Snapped so
            // the compressor response is steady-state immediately; only pushed
            // when non-zero so a flat project doesn't fan out identity updates.
            const float tLeveler = projectState.getTrackLevelerAmount(toneTrackId);
            if (tLeveler != 0.0F)
                engine.setTrackLeveler(toneTrackId, tLeveler, /*snap*/ true);

            // Phase 5 — restore persisted per-track Reverb / Delay send
            // amounts. Snapped; only pushed when non-zero so a flat
            // project doesn't fan out identity updates.
            const float sReverb = projectState.getTrackReverbSend(toneTrackId);
            const float sDelay = projectState.getTrackDelaySend(toneTrackId);
            if (sReverb != 0.0F || sDelay != 0.0F)
                engine.setTrackSends(toneTrackId, sReverb, sDelay);

            // Phase 5 — restore persisted per-track pan. Pushed only when
            // off-centre so a default project doesn't fan out identity
            // updates (the engine keeps the bit-exact unity path at 0).
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
            // Same WAV-first resolution as `handleClipAdd` so a loaded
            // project never plays compressed sources at the engine.
            const juce::String engineFilePath =
                silverdaw::resolveEnginePlaybackPath(filePath, projectState, decodedCache);
            if (engineFilePath == filePath)
            {
                silverdaw::ensureDecodedCache(filePath, engine, projectState, peakPool, decodedCache);
            }
            juce::String err;
            // Project rebuild after load must use the EFFECTIVE
            // track gain (post-mute/solo) so a project saved with a
            // soloed track replays correctly: the soloed track plays
            // at its user volume and every other track is silenced.
            // Reading `track.gain` raw here was the bug — it gave
            // every track its user volume regardless of mute/solo
            // state, so a reopened soloed project played everyone.
            const auto trackId = track.getProperty("id").toString();
            const auto effectiveGain = projectState.getEffectiveTrackGain(trackId);
            if (engine.addClip(trackId, clipId, juce::File(engineFilePath), offsetMs, inMs, durationMs, effectiveGain, &err))
            {
                ++rebuilt;
                // If the saved project carried warp settings on this
                // clip, replay them onto the freshly-built engine
                // clip so a loaded project plays at the user's
                // intended tempo / pitch. Identical to what a fresh
                // CLIP_SET_WARP envelope would do.
                const auto warpEnabled = static_cast<bool>(clip.getProperty("warpEnabled", false));
                if (warpEnabled)
                {
                    const auto warpMode = clip.getProperty("warpMode", "rhythmic").toString();
                    std::optional<double> tempoRatio;
                    if (clip.hasProperty("tempoRatio"))
                        tempoRatio = static_cast<double>(clip.getProperty("tempoRatio", 1.0));
                    else
                    {
                        // No pin: derive live from project BPM vs source BPM.
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

                // Phase 5 — restore persisted per-clip volume envelope.
                // Only push when the clip actually carries breakpoints so
                // legacy / unshaped clips stay on the no-op fast path.
                if (clip.hasProperty("envelopePoints"))
                {
                    const auto& envVar = clip.getProperty("envelopePoints");
                    if (envVar.isArray() && envVar.getArray()->size() > 0)
                    {
                        engine.setClipEnvelope(clipId, *envVar.getArray());
                    }
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
    // §12.1 — drop any transitions whose invariants no longer hold (e.g. a
    // hand-edited or future-version project file) WITHOUT polluting the undo
    // history, then publish each clip's derived edge-fade to the live engine
    // so a loaded project's crossfades sound immediately.
    projectState.reconcileTransitions(/*useUndo*/ false);
    silverdaw::syncClipEdgeFades(engine, projectState);

    // Restore project-level master volume to the live engine. PROJECT_NEW
    // resets to 1.0; PROJECT_LOAD / recovery / undo / redo all reuse this
    // path so the slider value persists across a load and undo never
    // diverges audio from the visible UI value.
    engine.setMasterGain(projectState.getMasterVolume());

    // Phase 5 — restore project-shared Reverb / Delay. Pushed UNCONDITIONALLY
    // (snapped) so a PROJECT_NEW / PROJECT_LOAD resets the single shared
    // FX instance to this project's values rather than inheriting the
    // previous project's settings. Delay time resolves via the shared
    // helper so live ↔ export parity holds.
    engine.setProjectReverb(projectState.getProjectReverbSize(),
                            projectState.getProjectReverbDecay(),
                            projectState.getProjectReverbTone(),
                            projectState.getProjectReverbMix(), /*snap*/ true);
    engine.setProjectDelay(
        silverdaw::delayNoteToMs(projectState.getProjectDelayNoteValue(), projectState.getBpm()),
        projectState.getProjectDelayFeedback(), projectState.getProjectDelayTone(),
        projectState.getProjectDelayMix(), /*snap*/ true);
}

} // namespace silverdaw
