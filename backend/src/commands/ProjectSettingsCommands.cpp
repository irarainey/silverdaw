#include "ProjectSettingsCommands.h"

#include <cmath>
#include <optional>

#include "AudioConstants.h"
#include "AudioEngine.h"
#include "BeatRepeatCommands.h"
#include "BridgeServer.h"
#include "LibraryAnalysis.h"
#include "Log.h"
#include "PayloadHelpers.h"
#include "ProjectState.h"

namespace silverdaw
{

using silverdaw::bridge::tryGetNumber;
using silverdaw::bridge::tryGetRequiredString;
using silverdaw::bridge::readOptionalBool;

void syncTimelineLoop(AudioEngine& engine, const ProjectState& projectState)
{
    const auto selection = projectState.getViewTimelineSelection();
    if (selection.has_value() && selection->loop)
        engine.setTimelineLoop(AudioEngine::LoopRange{selection->startMs, selection->endMs});
    else
        engine.setTimelineLoop(std::nullopt);
}

void handleProjectSetView(const juce::var& payload, silverdaw::AudioEngine& engine,
                          silverdaw::ProjectState& projectState)
{
    // View preferences are saved but dirty-suppressed.
    const auto pxVar = payload.getProperty("pxPerSecond", juce::var());
    if (pxVar.isDouble() || pxVar.isInt() || pxVar.isInt64())
    {
        const double px = static_cast<double>(pxVar);
        if (px > 0.0)
        {
            projectState.setViewPxPerSecond(px);
        }
    }
    const auto sxVar = payload.getProperty("scrollX", juce::var());
    if (sxVar.isDouble() || sxVar.isInt() || sxVar.isInt64())
    {
        projectState.setViewScrollX(juce::jmax(0.0, static_cast<double>(sxVar)));
    }
    // Missing scroll/zoom-only fields must not clear selected track state.
    if (payload.hasProperty("selectedTrackId"))
    {
        const auto selVar = payload.getProperty("selectedTrackId", juce::var());
        projectState.setViewSelectedTrack(selVar.isString() ? selVar.toString() : juce::String{});
    }
    const auto fxVar = payload.getProperty("fxPanelOpen", juce::var());
    if (fxVar.isBool())
    {
        projectState.setViewFxPanelOpen(static_cast<bool>(fxVar));
    }
    const auto fxTabVar = payload.getProperty("fxTab", juce::var());
    if (fxTabVar.isString())
    {
        projectState.setViewFxTab(fxTabVar.toString());
    }
    // Stored opaquely: the renderer owns the snap vocabulary and falls back to
    // its own default for anything it does not recognise.
    const auto snapVar = payload.getProperty("snapGrid", juce::var());
    if (snapVar.isString())
    {
        projectState.setViewSnapGrid(snapVar.toString());
    }

    auto timelineSelection = projectState.getViewTimelineSelection();
    bool selectionChanged = false;
    if (payload.hasProperty("timelineSelection"))
    {
        const auto selectionVar = payload.getProperty("timelineSelection", juce::var());
        if (selectionVar.isVoid())
        {
            timelineSelection.reset();
            selectionChanged = true;
        }
        else if (const auto* selectionObj = selectionVar.getDynamicObject())
        {
            const auto startVar = selectionObj->getProperty("startMs");
            const auto endVar = selectionObj->getProperty("endMs");
            if ((startVar.isDouble() || startVar.isInt() || startVar.isInt64())
                && (endVar.isDouble() || endVar.isInt() || endVar.isInt64()))
            {
                const double startMs = static_cast<double>(startVar);
                const double endMs = static_cast<double>(endVar);
                if (std::isfinite(startMs) && std::isfinite(endMs)
                    && startMs >= 0.0 && endMs > startMs)
                {
                    timelineSelection = ProjectState::TimelineSelectionView{
                        startMs,
                        endMs,
                        timelineSelection.has_value() && timelineSelection->loop
                    };
                    selectionChanged = true;
                }
            }
        }
    }
    const auto loopVar = payload.getProperty("loopTimelineSelection", juce::var());
    if (loopVar.isBool() && timelineSelection.has_value())
    {
        timelineSelection->loop = static_cast<bool>(loopVar);
        selectionChanged = true;
    }
    if (selectionChanged)
    {
        projectState.setViewTimelineSelection(timelineSelection);
        syncTimelineLoop(engine, projectState);
    }
}

void handleProjectSetBpm(const juce::var& payload, silverdaw::AudioEngine& engine,
                         silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge)
{
    const auto bpmVar = payload.getProperty("bpm", juce::var());
    if (bpmVar.isDouble() || bpmVar.isInt() || bpmVar.isInt64())
    {
        const double bpm = static_cast<double>(bpmVar);
        if (bpm >= 20.0 && bpm <= 300.0)
        {
            const double previousBpm = projectState.getBpm();
            // Captured before anything moves: the envelope retime below needs to know
            // how far each clip actually re-stretched, and that is only knowable by
            // comparing against the footprints the shapes were drawn against.
            const auto previousFootprints = projectState.snapshotClipFootprints();
            projectState.setBpm(bpm);
            // Setting the tempo by hand is the strongest statement that it is
            // established: without this the flag stays false and the next analysed
            // clip re-seeds the project, overriding the tempo the user just typed.
            projectState.setBpmSeeded(true);
            engine.setMetronomeBpm(bpm);
            syncBeatRepeatRegions(engine, projectState);

            // Bring unwarped clips onto the new tempo first, so the re-stretch below
            // sees them. Only when the renderer says the "match project tempo" pref is
            // on — it is the same preference that warps a clip on drop, and this is the
            // same decision applied to clips that are already placed. An unwarped clip
            // left alone would be the one thing on the timeline still at the old tempo.
            const bool autoWarp = static_cast<bool>(payload.getProperty("autoWarp", false));
            if (autoWarp)
            {
                projectState.forEachWarpClip(
                    [&](const silverdaw::ProjectState::WarpClipInfo& info)
                    {
                        if (info.warpEnabled || info.tempoRatioPinned) return;
                        if (projectState.getLibraryItemBpm(info.libraryItemId) <= 0.0) return;
                        projectState.setClipWarp(info.clipId, true, std::nullopt, std::nullopt,
                                                 /*tempoRatioClear=*/true, std::nullopt, std::nullopt,
                                                 std::nullopt);
                    });
            }

            // Keep the arrangement's musical shape: a clip on bar 9 stays on bar 9.
            // Warped clips re-stretch below, but without this their start times stay
            // in milliseconds and the whole arrangement drifts apart on a tempo edit.
            const int retimed = projectState.retimeClipsForTempoChange(
                previousBpm, bpm,
                [&](const juce::String& clipId, double offsetMs)
                {
                    engine.setClipOffsetMs(clipId, offsetMs);
                    engine.commitClipOffset(clipId);
                });

            // Markers and the playhead are musical places too, so they travel with the
            // material rather than staying put in milliseconds. A marker dropped on the
            // drop must still be on the drop, and the playhead must stay on the beat it
            // was parked on — otherwise the one edit that moves everything else leaves
            // exactly these two behind, pointing at whatever now happens to occupy that
            // instant.
            const int markersRetimed = projectState.retimeMarkersForTempoChange(previousBpm, bpm);

            // Track automation shares the timeline axis with clips and markers, so a
            // curve drawn over bar 9 has to stay over bar 9. Left in milliseconds it
            // drifts against the material it was written for and shapes the wrong sound.
            const int automationRetimed = projectState.retimeTrackAutomationForTempoChange(
                previousBpm, bpm,
                [&](const juce::String& trackId, const juce::String& paramId,
                    const juce::Array<juce::var>& points)
                { engine.setTrackAutomation(trackId, paramId, points); });
            if (previousBpm > 0.0 && bpm > 0.0 && previousBpm != bpm)
            {
                const double positionMs = engine.getPositionMs();
                if (positionMs > 0.0)
                {
                    // Same material under the playhead after the move, so the effect
                    // tails are still the right ones to carry across.
                    engine.setPositionMs(positionMs * (previousBpm / bpm),
                                         /*resetEffects=*/false);
                }
            }

            // Pinned tempo ratios opt out of project-BPM tracking.
            projectState.forEachWarpClip(
                [&](const silverdaw::ProjectState::WarpClipInfo& info)
                {
                    if (!info.warpEnabled || info.tempoRatioPinned) return;
                    const double sourceBpm = projectState.getLibraryItemBpm(info.libraryItemId);
                    if (sourceBpm <= 0.0) return;
                    const double ratio = bpm / sourceBpm;
                    // Say `enabled` rather than leaving it unset: the engine reads an unset
                    // value as "whatever this clip already is", which for a clip the auto-warp
                    // above has only just enabled in project state is *not warped* — it would
                    // take the disable branch, and the clip would play dry at its original
                    // length while the timeline drew it stretched to the new tempo. Project
                    // state is the truth here, and every clip this loop visits is warped.
                    // The tempo a project was seeded from is not special: it only means a clip
                    // happened to need no stretch at the time, and any later tempo change makes
                    // it warpable like any other musical clip.
                    const std::optional<juce::String> mode =
                        info.warpMode.isNotEmpty() ? std::optional<juce::String>(info.warpMode)
                                                   : std::nullopt;
                    if (!engine.setClipWarp(info.clipId, /*enabled=*/true, mode,
                                            ratio, std::nullopt, std::nullopt))
                    {
                        silverdaw::log::warn("warp",
                                             "engine refused tempo-change warp clipId=" + info.clipId
                                                 + " — project state and playback are now out of step");
                    }
                    auto appliedPayload = silverdaw::buildClipWarpAppliedPayload(projectState, info.clipId);
                    bridge.broadcast("CLIP_WARP_APPLIED", juce::var(appliedPayload.release()));
                });

            // Last, so it measures the footprints the warp loops above have settled on.
            // A volume shape is measured across the clip's timeline footprint, so it has
            // to follow that footprint rather than the project scale: a pinned ratio or a
            // clip left unwarped does not re-stretch, and its shape must stay put.
            const int envelopesRetimed = projectState.retimeClipEnvelopesForFootprintChange(
                previousFootprints,
                [&](const juce::String& clipId, const juce::Array<juce::var>& points)
                { engine.setClipEnvelope(clipId, points); });

            if (retimed > 0 || markersRetimed > 0 || automationRetimed > 0
                || envelopesRetimed > 0 || autoWarp)
            {
                silverdaw::log::info("project", "tempo change " + juce::String(previousBpm, 2) + " -> "
                                                    + juce::String(bpm, 2) + " retimed "
                                                    + juce::String(retimed) + " clip(s) "
                                                    + juce::String(markersRetimed) + " marker(s) "
                                                    + juce::String(automationRetimed) + " automation lane(s) "
                                                    + juce::String(envelopesRetimed) + " envelope(s)");
            }
        }
    }
}

void handleProjectSetLength(const juce::var& payload, silverdaw::ProjectState& projectState)
{
    const auto lenVar = payload.getProperty("lengthMs", juce::var());
    if (lenVar.isDouble() || lenVar.isInt() || lenVar.isInt64())
    {
        const double lenMs = static_cast<double>(lenVar);
        if (lenMs >= 0.0)
        {
            projectState.setProjectLengthMs(lenMs);
        }
    }
}

void handleProjectSetAudioOutput(const juce::var& payload, silverdaw::ProjectState& projectState)
{
    // Null or non-string clears preference; strings are persisted verbatim.
    const auto extract = [](const juce::var& payloadIn, const char* key) -> juce::String {
        const juce::var v = payloadIn.getProperty(key, juce::var());
        if (v.isString()) return v.toString();
        return {};
    };
    const auto typeName = extract(payload, "typeName");
    const auto deviceName = extract(payload, "deviceName");
    projectState.setAudioOutput(typeName, deviceName);
}

void handleProjectSetTargetSampleRate(const juce::var& payload, silverdaw::ProjectState& projectState)
{
    // Whitelist rates so import/cache paths never see unsupported project rates.
    const auto rateOpt = tryGetNumber(payload, "sampleRate");
    if (rateOpt.has_value())
    {
        const int requested = static_cast<int>(*rateOpt);
        if (requested == 0 || silverdaw::isSupportedSampleRate(requested))
        {
            projectState.setTargetSampleRate(requested);
        }
        else
        {
            silverdaw::log::warn(
                "bridge",
                "PROJECT_SET_TARGET_SAMPLE_RATE rejected (unsupported rate "
                    + juce::String(requested) + ")");
        }
    }
}

void handleProjectSetExportSettings(const juce::var& payload, silverdaw::ProjectState& projectState)
{
    // Renderer owns this export-settings schema; backend only size-limits it.
    const auto json = tryGetRequiredString(payload, "json").value_or(juce::String{});
    if (json.length() > 64 * 1024)
    {
        silverdaw::log::warn(
            "bridge",
            "PROJECT_SET_EXPORT_SETTINGS rejected (json > 64 KB; got "
                + juce::String(json.length()) + ")");
    }
    else
    {
        projectState.setExportSettingsJson(json);
    }
}

void handleProjectSetMasterVolume(const juce::var& payload, silverdaw::AudioEngine& engine,
                                  silverdaw::ProjectState& projectState)
{
    // Persist and push live so mixdown matches what the user hears.
    const auto gainOpt = tryGetNumber(payload, "gain");
    if (gainOpt.has_value())
    {
        const float clamped = juce::jlimit(0.0F, 1.0F, static_cast<float>(*gainOpt));
        projectState.setMasterVolume(clamped);
        engine.setMasterGain(clamped);
    }
}

void handleProjectSetSafetyLimiter(const juce::var& payload, silverdaw::AudioEngine& engine,
                                   silverdaw::ProjectState& projectState)
{
    const auto enabledOpt = readOptionalBool(payload, "enabled");
    if (!enabledOpt.has_value()) return;

    projectState.setSafetyLimiterEnabled(*enabledOpt);
    engine.setSafetyLimiterEnabled(*enabledOpt, /*snap*/ *enabledOpt);
}

void handleProjectSetBarCounterStart(const juce::var& payload, silverdaw::ProjectState& projectState)
{
    // Bar-label offset for the ruler; bounded so a stray value can't shift labels absurdly.
    const auto startOpt = tryGetNumber(payload, "barCounterStart");
    if (startOpt.has_value())
    {
        const int clamped = juce::jlimit(-64, 1, static_cast<int>(std::lround(*startOpt)));
        projectState.setBarCounterStart(clamped);
    }
}

void handleProjectSetMixdownStartBar(const juce::var& payload, silverdaw::ProjectState& projectState)
{
    // Displayed bar marker a mixdown starts from; never negative of the project origin.
    const auto barOpt = tryGetNumber(payload, "mixdownStartBar");
    if (barOpt.has_value())
    {
        const int clamped = juce::jlimit(-64, 4096, static_cast<int>(std::lround(*barOpt)));
        projectState.setMixdownStartBar(clamped);
    }
}

void handleProjectSetMetronome(const juce::var& payload, silverdaw::AudioEngine& engine,
                               silverdaw::ProjectState& projectState)
{
    const auto enabledOpt = readOptionalBool(payload, "enabled");
    if (! enabledOpt.has_value()) return;
    // Persist silently (no dirty, no undo) and push live. Refresh the metronome BPM from the
    // current project tempo on enable so it ticks in time even if the tempo changed (or was
    // auto-seeded) since the engine last learned it.
    projectState.setMetronomeEnabled(*enabledOpt);
    engine.setMetronomeBpm(projectState.getBpm());
    engine.setMetronomeEnabled(*enabledOpt);
}

void handleSetSeedProjectTempoPref(const juce::var& payload, silverdaw::ProjectState& projectState)
{
    // App-level preference (default on), re-pushed by the renderer on connect and
    // on change. Runtime-only: gates whether the first clip seeds the project tempo.
    const auto enabledOpt = readOptionalBool(payload, "enabled");
    if (! enabledOpt.has_value()) return;
    projectState.setSeedProjectTempoFromFirstClip(*enabledOpt);
    silverdaw::log::info("bpmjob",
                         juce::String("seed-from-first-clip preference set to ")
                             + (*enabledOpt ? "on" : "off"));
}

} // namespace silverdaw
