#include "LibraryCommands.h"

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "DecodedCache.h"
#include "EnginePlaybackPath.h"
#include "LibraryAnalysis.h"
#include "Log.h"
#include "PayloadHelpers.h"
#include "ProjectState.h"
#include "ProjectSession.h"

#include <optional>

namespace silverdaw
{

using silverdaw::bridge::readOptionalString;
using silverdaw::bridge::tryGetRequiredString;

void handleLibraryAdd(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                      BridgeServer& bridge, juce::ThreadPool& peakPool, const DecodedCache& decodedCache)
{
    const juce::String itemId = tryGetRequiredString(payload, "itemId").value_or(juce::String{});
    const juce::String filePath = tryGetRequiredString(payload, "filePath").value_or(juce::String{});
    const juce::String fileName = tryGetRequiredString(payload, "fileName").value_or(juce::String{});
    const double durationMs = static_cast<double>(payload.getProperty("durationMs", 0.0));
    const int sampleRate = static_cast<int>(payload.getProperty("sampleRate", 0));
    const int channelCount = static_cast<int>(payload.getProperty("channelCount", 0));
    const juce::String playbackPath = tryGetRequiredString(payload, "playbackFilePath").value_or(juce::String{});
    const juce::String key = tryGetRequiredString(payload, "key").value_or(juce::String{});
    const juce::String kind = tryGetRequiredString(payload, "kind").value_or(juce::String{});
    const juce::String displayName = tryGetRequiredString(payload, "name").value_or(juce::String{});
    const juce::String sourceItemId = tryGetRequiredString(payload, "sourceItemId").value_or(juce::String{});
    const juce::String sourceClipId = tryGetRequiredString(payload, "sourceClipId").value_or(juce::String{});
    const double sourceInMs = payload.hasProperty("sourceInMs")
                                  ? static_cast<double>(payload.getProperty("sourceInMs", 0.0))
                                  : -1.0;
    const double sourceDurationMs = payload.hasProperty("sourceDurationMs")
                                        ? static_cast<double>(payload.getProperty("sourceDurationMs", 0.0))
                                        : -1.0;
    const int collapsedFlag = payload.hasProperty("collapsed")
                                  ? (bool(payload.getProperty("collapsed", false)) ? 1 : 0)
                                  : -1;
    silverdaw::log::info("bridge", "recv LIBRARY_ADD itemId=" + itemId);
    projectState.addLibraryItem(itemId, filePath, fileName, durationMs, sampleRate, channelCount, playbackPath, key,
                                kind, displayName, sourceItemId, sourceClipId, sourceInMs, sourceDurationMs,
                                collapsedFlag);
    if (kind == "saved-clip")
    {
        // Saved-clip warp fields are partial; missing fields keep identity defaults.
        std::optional<bool> warpEnabled;
        if (payload.hasProperty("warpEnabled"))
            warpEnabled = static_cast<bool>(payload.getProperty("warpEnabled", false));
        std::optional<juce::String> warpMode;
        if (payload.hasProperty("warpMode"))
            warpMode = tryGetRequiredString(payload, "warpMode").value_or(juce::String{});
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
        if (warpEnabled.has_value() || warpMode.has_value() || tempoRatio.has_value() ||
            tempoRatioClear || semitones.has_value() || cents.has_value())
        {
            projectState.setLibraryItemWarp(itemId, warpEnabled, warpMode, tempoRatio,
                                            tempoRatioClear, semitones, cents);
        }
    }
    else if (kind == "stem")
    {
        // Stems are derived from an already-analysed source; inherit its grid and
        // ensure a decoded cache exists for cheap playback (no re-analysis).
        inheritAnalysisFromSource(itemId, sourceItemId, engine, projectState, bridge);
        ensureDecodedCache(filePath, engine, projectState, peakPool, decodedCache);
    }
    else
    {
        ensureBpmDetection(filePath, engine, projectState, bridge, peakPool, decodedCache);
    }
}

void handleLibraryRemove(const juce::var& payload, ProjectState& projectState)
{
    const juce::String itemId = tryGetRequiredString(payload, "itemId").value_or(juce::String{});
    silverdaw::log::info("bridge", "recv LIBRARY_REMOVE itemId=" + itemId);
    projectState.removeLibraryItem(itemId);
}

void handleLibraryReanalyse(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                            BridgeServer& bridge, juce::ThreadPool& peakPool, const DecodedCache& decodedCache)
{
    const juce::String itemId = tryGetRequiredString(payload, "itemId").value_or(juce::String{});
    const juce::String filePath = tryGetRequiredString(payload, "filePath").value_or(juce::String{});
    const juce::String fileName = tryGetRequiredString(payload, "fileName").value_or(juce::String{});
    const double durationMs = static_cast<double>(payload.getProperty("durationMs", 0.0));
    const int sampleRate = static_cast<int>(payload.getProperty("sampleRate", 0));
    const int channelCount = static_cast<int>(payload.getProperty("channelCount", 0));
    const juce::String playbackPath = tryGetRequiredString(payload, "playbackFilePath").value_or(juce::String{});
    silverdaw::log::info("bridge", "recv LIBRARY_REANALYSE itemId=" + itemId);
    projectState.addLibraryItem(itemId, filePath, fileName, durationMs, sampleRate, channelCount, playbackPath);
    if (payload.hasProperty("key"))
    {
        projectState.setLibraryItemKey(itemId, tryGetRequiredString(payload, "key").value_or(juce::String{}));
    }
    const juce::String analysisPath = playbackPath.isNotEmpty() ? playbackPath : filePath;
    forceLibraryItemAnalysis(itemId, analysisPath, engine, projectState, bridge, peakPool, decodedCache);
}

void handleLibraryItemSetSampleMode(const juce::var& payload, ProjectState& projectState)
{
    const juce::String itemId = tryGetRequiredString(payload, "itemId").value_or(juce::String{});
    const juce::String mode = readOptionalString(payload, "mode").value_or(juce::String{});
    silverdaw::log::info("bridge", "recv LIBRARY_ITEM_SET_SAMPLE_MODE itemId=" + itemId + " mode='" + mode + "'");
    if (itemId.isEmpty())
    {
        silverdaw::log::warn("bridge", "LIBRARY_ITEM_SET_SAMPLE_MODE missing itemId");
    }
    else if (!mode.isEmpty() && mode != "sample" && mode != "music" && mode != "auto")
    {
        silverdaw::log::warn("bridge", "LIBRARY_ITEM_SET_SAMPLE_MODE bad mode='" + mode + "'");
    }
    else
    {
        // "auto" and empty both clear the override.
        const juce::String stored = (mode == "sample" || mode == "music") ? mode : juce::String{};
        projectState.setLibraryItemSampleMode(itemId, stored);
    }
}


// Clips reference library items by id, so relink rebuilds each dependent clip.
void handleLibraryItemRelink(const juce::var& payload, silverdaw::AudioEngine& engine,
                             silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                             const silverdaw::ProjectSession& session, juce::ThreadPool& peakPool,
                             const silverdaw::DecodedCache& decodedCache)
{
    const juce::String itemId = tryGetRequiredString(payload, "itemId").value_or(juce::String{});
    const juce::String filePath = tryGetRequiredString(payload, "filePath").value_or(juce::String{});
    if (itemId.isEmpty() || filePath.isEmpty())
    {
        return;
    }
    if (!projectState.setLibraryItemFilePath(itemId, filePath))
    {
        silverdaw::log::warn("project", "LIBRARY_ITEM_RELINK unknown itemId=" + itemId);
        return;
    }

    // Each clip is its own playable source, so rebuild dependents individually.
    const auto& root = projectState.getTree();
    int rebuilt = 0;
    int failed = 0;
    for (int t = 0; t < root.getNumChildren(); ++t)
    {
        const auto track = root.getChild(t);
        if (!track.hasType(juce::Identifier{"TRACK"})) continue;
        for (int c = 0; c < track.getNumChildren(); ++c)
        {
            const auto clip = track.getChild(c);
            if (!clip.hasType(juce::Identifier{"CLIP"})) continue;
            if (clip.getProperty("libraryItemId", {}).toString() != itemId) continue;

            const juce::String clipId = clip.getProperty("id").toString();
            const double offsetMs = static_cast<double>(clip.getProperty("offsetMs", 0.0));
            const double inMs = static_cast<double>(clip.getProperty("inMs", 0.0));
            const double durationMs = static_cast<double>(clip.getProperty("durationMs", 0.0));
            const auto trackId = track.getProperty("id").toString();
            const auto effectiveGain = projectState.getEffectiveTrackGain(trackId);

            engine.removeClip(clipId);
            const juce::String engineFilePath =
                silverdaw::resolveEnginePlaybackPath(filePath, projectState, decodedCache);
            if (engineFilePath == filePath)
            {
                silverdaw::ensureDecodedCache(filePath, engine, projectState, peakPool, decodedCache);
            }
            juce::String err;
            if (engine.addClip(trackId, clipId, juce::File(engineFilePath), offsetMs, inMs, durationMs, effectiveGain, &err))
            {
                engine.setClipGain(clipId, effectiveGain);
                ++rebuilt;
            }
            else
            {
                ++failed;
                silverdaw::log::warn("project", "relink-rebuild failed clipId=" + clipId + " err=" + err);
            }
        }
    }
    silverdaw::log::info("project", "LIBRARY_ITEM_RELINK itemId=" + itemId + " rebuilt=" + juce::String(rebuilt) +
                                        " failed=" + juce::String(failed));

    // Re-broadcast so dependent clips clear unresolved state.
    bridge.broadcast("PROJECT_STATE", silverdaw::buildProjectStateEnvelope(session, projectState, false));
}
} // namespace silverdaw
