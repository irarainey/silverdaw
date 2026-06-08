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
}

void handleProjectSetBpm(const juce::var& payload, silverdaw::AudioEngine& engine,
                         silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge)
{
    const auto bpmVar = payload.getProperty("bpm", juce::var());
    if (bpmVar.isDouble() || bpmVar.isInt() || bpmVar.isInt64())
    {
        const double bpm = static_cast<double>(bpmVar);
        if (bpm > 0.0)
        {
            projectState.setBpm(bpm);
            // Pinned tempo ratios opt out of project-BPM tracking.
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

} // namespace silverdaw
