#include "ClipCommands.h"

#include <optional>

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "CommandHelpers.h"
#include "LibraryAnalysis.h"
#include "Log.h"
#include "PayloadHelpers.h"
#include "ProjectState.h"

namespace silverdaw
{

using silverdaw::bridge::readOptionalString;
using silverdaw::bridge::tryGetNumber;
using silverdaw::bridge::tryGetRequiredString;

void handleClipMove(const juce::var& payload, silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState)
{
    const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
    if (clipId.isEmpty())
    {
        return;
    }
    const auto positionMs = tryGetNumber(payload, "positionMs");
    if (positionMs.has_value())
    {
        engine.setClipOffsetMs(clipId, *positionMs);
        projectState.setClipOffsetMs(clipId, *positionMs);
    }
    if (static_cast<bool>(payload.getProperty("commit", false)))
    {
        engine.commitClipOffset(clipId);
    }
    // Reapply destination track gain so cross-track moves preserve mute/solo audibility.
    // trackId is optional: present only for cross-track moves, absent for same-track drags.
    const juce::String newTrackId = readOptionalString(payload, "trackId").value_or(juce::String{});
    if (newTrackId.isNotEmpty())
    {
        if (projectState.setClipTrack(clipId, newTrackId))
        {
            engine.setClipGain(clipId, projectState.getEffectiveTrackGain(newTrackId));
        }
    }
}

void handleClipTrim(const juce::var& payload, silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState)
{
    const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
    if (clipId.isEmpty())
    {
        return;
    }
    const auto startMs = tryGetNumber(payload, "startMs");
    const auto inMs = tryGetNumber(payload, "inMs");
    const auto durationMs = tryGetNumber(payload, "durationMs");
    if (!startMs.has_value() || !inMs.has_value() || !durationMs.has_value())
    {
        return;
    }
    engine.setClipTrim(clipId, *startMs, *inMs, *durationMs);
    projectState.setClipTrim(clipId, *startMs, *inMs, *durationMs);
}

void handleClipColor(const juce::var& payload, silverdaw::ProjectState& projectState)
{
    const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
    if (clipId.isEmpty())
    {
        return;
    }
    const juce::var idxVar = payload.getProperty("colorIndex", juce::var());
    const int colorIndex =
        (idxVar.isInt() || idxVar.isInt64()) ? static_cast<int>(idxVar) : -1;
    projectState.setClipColorIndex(clipId, colorIndex);
}

void handleClipRemove(const juce::var& payload, silverdaw::AudioEngine& engine,
                      silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge)
{
    const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
    if (clipId.isEmpty())
    {
        return;
    }
    // Remove the audio source before its ProjectState clip ids disappear.
    engine.removeClip(clipId);
    const bool existed = projectState.removeClip(clipId);
    auto* p = new juce::DynamicObject();
    p->setProperty("clipId", clipId);
    p->setProperty("ok", existed);
    bridge.broadcast("CLIP_REMOVED", juce::var(p));
}

void handleClipSetEnvelope(const juce::var& payload, silverdaw::AudioEngine& engine,
                           silverdaw::ProjectState& projectState,
                           silverdaw::BridgeServer& bridge)
{
    const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
    if (clipId.isEmpty()) return;

    juce::Array<juce::var> points;
    const auto& pointsVar = payload.getProperty("points", juce::var());
    if (pointsVar.isArray())
    {
        points = *pointsVar.getArray();
    }

    const bool changed = projectState.setClipEnvelope(clipId, points);
    if (!changed) return;

    // Ack with the normalised persisted shape the engine receives.
    const auto stored = projectState.getClipEnvelope(clipId);
    engine.setClipEnvelope(clipId, stored);

    broadcastApplied(bridge, "CLIP_ENVELOPE_APPLIED",
                     {{"clipId", clipId}, {"points", juce::var(stored)}});
}

void handleClipSetLocked(const juce::var& payload, silverdaw::ProjectState& projectState)
{
    const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
    const bool locked = static_cast<bool>(payload.getProperty("locked", false));
    silverdaw::log::info("bridge", "recv CLIP_SET_LOCKED clipId=" + clipId +
                                      " locked=" + (locked ? "true" : "false"));
    if (clipId.isNotEmpty())
    {
        projectState.setClipLocked(clipId, locked);
    }
}

void handleClipSetReversed(const juce::var& payload, silverdaw::AudioEngine& engine,
                           silverdaw::ProjectState& projectState)
{
    const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
    const bool reversed = static_cast<bool>(payload.getProperty("reversed", false));
    silverdaw::log::info("bridge", "recv CLIP_SET_REVERSED clipId=" + clipId +
                                      " reversed=" + (reversed ? "true" : "false"));
    if (clipId.isEmpty())
    {
        return;
    }
    projectState.setClipReversed(clipId, reversed);
    engine.setClipReversed(clipId, reversed);
}

void handleClipSetBrake(const juce::var& payload, silverdaw::AudioEngine& engine,
                        silverdaw::ProjectState& projectState)
{
    const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
    const bool on = static_cast<bool>(payload.getProperty("on", false));
    silverdaw::log::info("bridge", "recv CLIP_SET_BRAKE clipId=" + clipId +
                                       " on=" + (on ? "true" : "false"));
    if (clipId.isEmpty())
    {
        return;
    }
    projectState.setClipBrake(clipId, on);
    engine.setClipBrake(clipId, on ? engine.getBrakeDefaultSeconds() : 0.0,
                        engine.getBrakeDefaultCurve());
}

void handleClipRename(const juce::var& payload, silverdaw::ProjectState& projectState)
{
    const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
    const juce::String name = tryGetRequiredString(payload, "name").value_or(juce::String{});
    silverdaw::log::info("bridge", "recv CLIP_RENAME clipId=" + clipId + " name=" + name);
    projectState.setClipName(clipId, name);
}

void handleClipRebind(const juce::var& payload, silverdaw::ProjectState& projectState)
{
    const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
    const juce::String libraryItemId = tryGetRequiredString(payload, "libraryItemId").value_or(juce::String{});
    silverdaw::log::info("bridge", "recv CLIP_REBIND clipId=" + clipId + " libraryItemId=" +
                                       libraryItemId);
    if (clipId.isNotEmpty() && libraryItemId.isNotEmpty())
    {
        projectState.setClipLibraryItemId(clipId, libraryItemId);
    }
}

void handleClipSetWarp(const juce::var& payload, silverdaw::AudioEngine& engine,
                       silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge)
{
    const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
    silverdaw::log::info("bridge", "recv CLIP_SET_WARP clipId=" + clipId);
    if (clipId.isEmpty())
    {
        return;
    }

    std::optional<bool> warpEnabled;
    if (payload.hasProperty("warpEnabled"))
        warpEnabled = static_cast<bool>(payload.getProperty("warpEnabled", false));
    std::optional<juce::String> warpMode;
    if (payload.hasProperty("warpMode"))
        warpMode = tryGetRequiredString(payload, "warpMode").value_or(juce::String{});
    // `tempoRatio: null` restores project-BPM tracking.
    std::optional<double> tempoRatio;
    bool tempoRatioClear = false;
    if (payload.hasProperty("tempoRatio"))
    {
        const auto& v = payload["tempoRatio"];
        if (v.isVoid() || v.isUndefined())
            tempoRatioClear = true;
        else
            tempoRatio = static_cast<double>(v);
    }
    std::optional<double> semitones;
    if (payload.hasProperty("semitones"))
        semitones = static_cast<double>(payload.getProperty("semitones", 0.0));
    std::optional<double> cents;
    if (payload.hasProperty("cents"))
        cents = static_cast<double>(payload.getProperty("cents", 0.0));
    std::optional<bool> pendingAutoWarp;
    if (payload.hasProperty("pendingAutoWarp"))
        pendingAutoWarp = static_cast<bool>(payload.getProperty("pendingAutoWarp", false));
    projectState.setClipWarp(clipId, warpEnabled, warpMode, tempoRatio, tempoRatioClear,
                             semitones, cents, pendingAutoWarp);
    bool clipFound = false;
    bool enabledNow = false;
    bool tempoRatioPinnedNow = false;
    double pinnedTempoRatioNow = 1.0;
    juce::String libraryItemIdNow;
    projectState.forEachWarpClip(
        [&](const silverdaw::ProjectState::WarpClipInfo& info)
        {
            if (info.clipId != clipId) return;
            clipFound = true;
            enabledNow = info.warpEnabled;
            tempoRatioPinnedNow = info.tempoRatioPinned;
            pinnedTempoRatioNow = info.tempoRatio;
            libraryItemIdNow = info.libraryItemId;
        });
    // Mirror rebuildEngineFromProject so project-BPM-tracking warp starts at the right ratio.
    std::optional<double> effectiveRatio = tempoRatio;
    if (!effectiveRatio.has_value() && !tempoRatioClear && tempoRatioPinnedNow)
    {
        effectiveRatio = pinnedTempoRatioNow;
    }
    if (enabledNow && !effectiveRatio.has_value() && !tempoRatioClear)
    {
        const auto libraryItemId =
            libraryItemIdNow.isNotEmpty() ? libraryItemIdNow : projectState.getClipLibraryItemId(clipId);
        if (libraryItemId.isNotEmpty())
        {
            const double sourceBpm = projectState.getLibraryItemBpm(libraryItemId);
            const double projectBpm = projectState.getBpm();
            if (sourceBpm > 0.0 && projectBpm > 0.0)
            {
                effectiveRatio = projectBpm / sourceBpm;
            }
        }
    }
    silverdaw::log::info("warp",
        "CLIP_SET_WARP clipId=" + clipId
        + " enabled=" + (clipFound ? (enabledNow ? "true" : "false") : "unknown")
        + " mode=" + (warpMode.has_value() ? *warpMode : juce::String("unset"))
        + " tempoRatio=" + (tempoRatio.has_value() ? juce::String(*tempoRatio) : juce::String(tempoRatioClear ? "null" : "unset"))
        + " pendingAutoWarp=" + (pendingAutoWarp.has_value() ? (*pendingAutoWarp ? "true" : "false") : "unset")
        + " effectiveRatio=" + (effectiveRatio.has_value() ? juce::String(*effectiveRatio) : juce::String("unset")));
    // Engine owns WarpProcessor lifetime; update it for the next audio block.
    engine.setClipWarp(clipId, warpEnabled, warpMode, effectiveRatio, semitones, cents);
    auto appliedPayload = silverdaw::buildClipWarpAppliedPayload(projectState, clipId);
    bridge.broadcast("CLIP_WARP_APPLIED", juce::var(appliedPayload.release()));
}

} // namespace silverdaw