#include "ProjectSettingsCommands.h"

#include <optional>

#include "AudioConstants.h"
#include "AudioEngine.h"
#include "BridgeServer.h"
#include "LibraryAnalysis.h"
#include "Log.h"
#include "PayloadHelpers.h"
#include "ProjectState.h"

namespace silverdaw
{

using silverdaw::bridge::tryGetNumber;
using silverdaw::bridge::tryGetRequiredString;

void handleProjectSetView(const juce::var& payload, silverdaw::ProjectState& projectState)
{
    // View preferences (zoom + scroll position) travel with the
    // project so opening a saved file restores the exact view the
    // user had when they saved. Suppressed from the dirty-flag
    // listener inside the setters so view changes don't prompt an
    // unsaved-changes dialog.
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
    // Selected track + Track-FX-panel-open flag travel with the
    // project too, so reopening restores which track's effects the
    // user was editing. Both are non-dirty view state. Guard on the
    // property being present: scroll/zoom-only pushes omit these and
    // must not be treated as "clear the selection".
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
}

void handleProjectSetBpm(const juce::var& payload, silverdaw::AudioEngine& engine,
                         silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge)
{
    // Tempo edits flip the dirty flag — this is a meaningful change
    // to the project that the user should be prompted to save.
    const auto bpmVar = payload.getProperty("bpm", juce::var());
    if (bpmVar.isDouble() || bpmVar.isInt() || bpmVar.isInt64())
    {
        const double bpm = static_cast<double>(bpmVar);
        if (bpm > 0.0)
        {
            projectState.setBpm(bpm);
            // Live re-warp: every warped clip with a derived (not
            // pinned) tempo ratio re-stretches to match the new
            // project BPM. Clips with an explicit `tempoRatio`
            // override keep their pinned value — the user opted
            // out of project-BPM tracking on those.
            projectState.forEachWarpClip(
                [&](const silverdaw::ProjectState::WarpClipInfo& info)
                {
                    if (!info.warpEnabled || info.tempoRatioPinned) return;
                    const double sourceBpm = projectState.getLibraryItemBpm(info.libraryItemId);
                    if (sourceBpm <= 0.0) return;
                    const double ratio = bpm / sourceBpm;
                    engine.setClipWarp(info.clipId, std::nullopt, std::nullopt,
                                       ratio, std::nullopt, std::nullopt);
                    auto appliedPayload = silverdaw::buildClipWarpAppliedPayload(projectState, info.clipId);
                    bridge.broadcast("CLIP_WARP_APPLIED", juce::var(appliedPayload.release()));
                });
        }
    }
}

void handleProjectSetLength(const juce::var& payload, silverdaw::ProjectState& projectState)
{
    // Length edits flip the dirty flag (same rationale as BPM).
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
    // Per-project preferred audio output. Both fields are nullable —
    // the renderer passes `null` to clear the preference. We accept
    // either an explicit empty string or a non-string (e.g. JSON
    // null) as "clear", and validate strings strictly otherwise so
    // a malformed envelope can't smuggle a debug-stringified value
    // into the persisted project file.
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
    // Project-wide target sample rate. Strict whitelist of accepted
    // rates so a malformed envelope can't park a project at an
    // unsupported rate that the import / cache code paths don't
    // handle. Pass 0 to clear (renderer-scope default applies on
    // next load).
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
    // Opaque JSON blob describing the last-used export-dialog
    // settings (format, bit depth, tail seconds, loudness preset,
    // file-level tags, …). Renderer owns the schema — we just
    // round-trip the string. Pass an empty string to clear.
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
    // Master output gain in [0, 1]. Persisted on the ValueTree
    // (undoable, marks dirty) AND pushed live to the AudioEngine
    // so playback changes audibly during a slider drag. Mixdown
    // reads the same value from `snapshotProjectForMixdown`, so
    // the exported file matches what the user hears.
    const auto gainOpt = tryGetNumber(payload, "gain");
    if (gainOpt.has_value())
    {
        const float clamped = juce::jlimit(0.0F, 1.0F, static_cast<float>(*gainOpt));
        projectState.setMasterVolume(clamped);
        engine.setMasterGain(clamped);
    }
}

} // namespace silverdaw
