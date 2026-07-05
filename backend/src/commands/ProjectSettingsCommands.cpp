#include "ProjectSettingsCommands.h"

#include <cmath>
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
using silverdaw::bridge::readOptionalBool;

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
            engine.setMetronomeBpm(bpm);
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
