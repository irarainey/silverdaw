#include "LibraryCommands.h"

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "DecodedCache.h"
#include "LibraryAnalysis.h"
#include "Log.h"
#include "PayloadHelpers.h"
#include "ProjectState.h"

#include <optional>

namespace silverdaw
{

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
        // Warp defaults — only meaningful on saved clips. Each field is partial;
        // missing fields stay at whatever `addLibraryItem` left them (identity).
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
    const juce::String mode = payload.getProperty("mode", juce::var("")).toString();
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
        // "auto" and empty both clear the override (auto-detect falls back to
        // the analysis-side `lowConfidence` flag).
        const juce::String stored = (mode == "sample" || mode == "music") ? mode : juce::String{};
        projectState.setLibraryItemSampleMode(itemId, stored);
    }
}

} // namespace silverdaw
