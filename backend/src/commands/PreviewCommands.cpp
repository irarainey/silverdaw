#include "PreviewCommands.h"

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "DecodedCache.h"
#include "EnginePlaybackPath.h"
#include "Log.h"
#include "PayloadHelpers.h"
#include "ProjectState.h"

namespace silverdaw
{

using silverdaw::bridge::tryGetNumber;
using silverdaw::bridge::tryGetRequiredString;

namespace
{
constexpr int kPreviewReadyDelayMs = 200;

void broadcastPreviewState(AudioEngine& engine, BridgeServer& bridge, bool isPlaying, bool isLoaded,
                           double durationMs)
{
    auto* stateObj = new juce::DynamicObject();
    stateObj->setProperty("isPlaying", isPlaying);
    stateObj->setProperty("isLoaded", isLoaded);
    stateObj->setProperty("durationMs", durationMs);
    stateObj->setProperty("generation", static_cast<juce::int64>(engine.getPreviewGeneration()));
    bridge.broadcast("PREVIEW_STATE", juce::var(stateObj));
}

// Generation check prevents stale delayed load state from clobbering a newer load.
void broadcastPreviewStateIfCurrent(AudioEngine& engine, BridgeServer& bridge,
                                    const juce::String& libraryItemId, juce::int64 generation)
{
    if (engine.getPreviewGeneration() != generation) return;
    auto* stateObj = new juce::DynamicObject();
    if (libraryItemId.isNotEmpty()) stateObj->setProperty("libraryItemId", libraryItemId);
    stateObj->setProperty("isPlaying", engine.isPreviewPlaying());
    stateObj->setProperty("isLoaded", engine.isPreviewLoaded());
    stateObj->setProperty("durationMs", engine.getPreviewDurationMs());
    stateObj->setProperty("generation", generation);
    bridge.broadcast("PREVIEW_STATE", juce::var(stateObj));
}
} // namespace

void handlePreviewLoad(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                       BridgeServer& bridge, const DecodedCache& decodedCache)
{
    const juce::String libraryItemId = tryGetRequiredString(payload, "libraryItemId").value_or(juce::String{});
    const double inMs = static_cast<double>(payload.getProperty("inMs", 0.0));
    const double durationMs = static_cast<double>(payload.getProperty("durationMs", 0.0));
    silverdaw::log::info("bridge", "recv PREVIEW_LOAD libraryItemId=" + libraryItemId +
                                        " inMs=" + juce::String(inMs) +
                                        " durationMs=" + juce::String(durationMs));
    const juce::String sourcePath = projectState.getLibraryItemFilePath(libraryItemId);
    if (sourcePath.isEmpty())
    {
        silverdaw::log::warn("preview", "PREVIEW_LOAD unknown libraryItemId=" + libraryItemId);
        return;
    }
    // Prefer the decoded WAV cache so compressed sources preview promptly.
    const juce::String playbackPath = resolveEnginePlaybackPath(sourcePath, projectState, decodedCache);
    juce::String err;
    std::optional<bool> warpEnabled;
    std::optional<juce::String> warpMode;
    std::optional<double> tempoRatio;
    std::optional<double> semitones;
    std::optional<double> cents;
    if (payload.hasProperty("warpEnabled"))
    {
        warpEnabled = static_cast<bool>(payload.getProperty("warpEnabled", false));
        if (payload.hasProperty("warpMode"))
            warpMode = tryGetRequiredString(payload, "warpMode").value_or(juce::String{});
        if (payload.hasProperty("tempoRatio"))
        {
            const auto& v = payload["tempoRatio"];
            if (!v.isVoid() && !v.isUndefined()) tempoRatio = static_cast<double>(v);
        }
        if (payload.hasProperty("semitones"))
            semitones = static_cast<double>(payload.getProperty("semitones", 0.0));
        if (payload.hasProperty("cents"))
            cents = static_cast<double>(payload.getProperty("cents", 0.0));
    }
    if (!engine.loadPreview(juce::File(playbackPath), inMs, durationMs, &err,
                            warpEnabled, warpMode, tempoRatio, semitones, cents))
    {
        silverdaw::log::warn("preview", "PREVIEW_LOAD failed: " + err.toStdString());
    }
    const auto generation = static_cast<juce::int64>(engine.getPreviewGeneration());
    juce::Timer::callAfterDelay(
        kPreviewReadyDelayMs,
        [&engine, &bridge, libraryItemId, generation]
        {
            broadcastPreviewStateIfCurrent(engine, bridge, libraryItemId, generation);
        });
}

void handlePreviewUnload(AudioEngine& engine, BridgeServer& bridge)
{
    silverdaw::log::info("bridge", "recv PREVIEW_UNLOAD");
    engine.unloadPreview();
    broadcastPreviewState(engine, bridge, false, false, 0.0);
}

void handlePreviewPlay(AudioEngine& engine, BridgeServer& bridge)
{
    silverdaw::log::info("bridge", "recv PREVIEW_PLAY");
    // Clip Editor preview is exclusive; pause project transport first.
    if (engine.isPlaying()) engine.pause();
    engine.playPreview();
    broadcastPreviewState(engine, bridge, engine.isPreviewPlaying(), engine.isPreviewLoaded(),
                          engine.getPreviewDurationMs());
}

void handlePreviewPause(AudioEngine& engine, BridgeServer& bridge)
{
    silverdaw::log::info("bridge", "recv PREVIEW_PAUSE");
    engine.pausePreview();
    broadcastPreviewState(engine, bridge, false, engine.isPreviewLoaded(), engine.getPreviewDurationMs());
}

void handlePreviewStop(AudioEngine& engine, BridgeServer& bridge)
{
    silverdaw::log::info("bridge", "recv PREVIEW_STOP");
    engine.stopPreview();
    broadcastPreviewState(engine, bridge, false, engine.isPreviewLoaded(), engine.getPreviewDurationMs());
}

void handlePreviewSeek(const juce::var& payload, AudioEngine& engine)
{
    const auto positionMs = tryGetNumber(payload, "positionMs");
    if (positionMs.has_value())
    {
        engine.setPreviewPositionMs(*positionMs);
    }
}

void handlePreviewSetWarp(const juce::var& payload, AudioEngine& engine)
{
    silverdaw::log::info("bridge", "recv PREVIEW_SET_WARP");
    std::optional<bool> warpEnabled;
    if (payload.hasProperty("warpEnabled"))
        warpEnabled = static_cast<bool>(payload.getProperty("warpEnabled", false));
    std::optional<juce::String> warpMode;
    if (payload.hasProperty("warpMode"))
        warpMode = tryGetRequiredString(payload, "warpMode").value_or(juce::String{});
    std::optional<double> tempoRatio;
    if (payload.hasProperty("tempoRatio"))
    {
        const auto& v = payload["tempoRatio"];
        if (!v.isVoid() && !v.isUndefined()) tempoRatio = static_cast<double>(v);
    }
    std::optional<double> semitones;
    if (payload.hasProperty("semitones"))
        semitones = static_cast<double>(payload.getProperty("semitones", 0.0));
    std::optional<double> cents;
    if (payload.hasProperty("cents"))
        cents = static_cast<double>(payload.getProperty("cents", 0.0));
    engine.setPreviewWarp(warpEnabled, warpMode, tempoRatio, semitones, cents);
}

void handlePreviewSetEnvelope(const juce::var& payload, AudioEngine& engine)
{
    juce::Array<juce::var> points;
    const auto& pointsVar = payload.getProperty("points", juce::var());
    if (pointsVar.isArray())
    {
        points = *pointsVar.getArray();
    }
    engine.setPreviewEnvelope(points);
}

void handlePreviewSetReversed(const juce::var& payload, AudioEngine& engine)
{
    silverdaw::log::info("bridge", "recv PREVIEW_SET_REVERSED");
    const bool reversed = static_cast<bool>(payload.getProperty("reversed", false));
    engine.setPreviewReversed(reversed);
}

void handlePreviewSetBrake(const juce::var& payload, AudioEngine& engine, ProjectState& projectState)
{
    juce::ignoreUnused(projectState);
    const bool on = static_cast<bool>(payload.getProperty("on", false));
    silverdaw::log::info("bridge", std::string("recv PREVIEW_SET_BRAKE on=") + (on ? "1" : "0"));
    engine.setPreviewBrake(on ? engine.getBrakeDefaultSeconds() : 0.0,
                           engine.getBrakeDefaultCurve());
}

void handlePreviewSetBackspin(const juce::var& payload, AudioEngine& engine, ProjectState& projectState)
{
    juce::ignoreUnused(projectState);
    const bool on = static_cast<bool>(payload.getProperty("on", false));
    silverdaw::log::info("bridge", std::string("recv PREVIEW_SET_BACKSPIN on=") + (on ? "1" : "0"));
    engine.setPreviewBackspin(on ? engine.getBackspinDefaultSeconds() : 0.0,
                              engine.getBackspinDefaultSpeed(), engine.getBackspinDefaultCurve());
}

} // namespace silverdaw
