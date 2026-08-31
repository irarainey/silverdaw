#include "PreviewCommands.h"

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "DecodedCache.h"
#include "EnginePlaybackPath.h"
#include "Log.h"
#include "PayloadHelpers.h"
#include "ProjectState.h"

#include <atomic>
#include <optional>

namespace silverdaw
{

using silverdaw::bridge::readOptionalWarpMode;
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
    stateObj->setProperty("generation", engine.getPreviewGeneration());
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

// Everything a PREVIEW_LOAD needs to reach the engine, so the load can be replayed
// on the message thread once a background decode has finished.
struct PreviewLoadRequest
{
    juce::String libraryItemId;
    double inMs = 0.0;
    double durationMs = 0.0;
    std::optional<bool> warpEnabled;
    std::optional<juce::String> warpMode;
    std::optional<double> tempoRatio;
    std::optional<double> semitones;
    std::optional<double> cents;
};

void loadPreviewAndBroadcast(const juce::String& pathToLoad, const PreviewLoadRequest& request,
                             AudioEngine& engine, BridgeServer& bridge)
{
    juce::String err;
    if (!engine.loadPreview(juce::File(pathToLoad), request.inMs, request.durationMs, &err,
                            request.warpEnabled, request.warpMode, request.tempoRatio,
                            request.semitones, request.cents))
    {
        silverdaw::log::warn("preview", "PREVIEW_LOAD failed: " + err.toStdString());
    }
    const auto generation = engine.getPreviewGeneration();
    const auto itemId = request.libraryItemId;
    juce::Timer::callAfterDelay(
        kPreviewReadyDelayMs,
        [&engine, &bridge, itemId, generation]
        {
            broadcastPreviewStateIfCurrent(engine, bridge, itemId, generation);
        });
}

// Only the newest audition may load. The engine's preview generation cannot serve
// here because it advances only after a successful load, so two pending decodes
// would both still look current.
std::atomic<juce::int64> previewRequestCounter{0};
} // namespace

void handlePreviewLoad(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                       BridgeServer& bridge, const DecodedCache& decodedCache,
                       juce::ThreadPool& peakPool)
{
    const juce::String libraryItemId = tryGetRequiredString(payload, "libraryItemId").value_or(juce::String{});
    const juce::String requestedPath = payload.getProperty("filePath", juce::var{}).toString();
    const double inMs = static_cast<double>(payload.getProperty("inMs", 0.0));
    const double durationMs = static_cast<double>(payload.getProperty("durationMs", 0.0));
    silverdaw::log::info("bridge", "recv PREVIEW_LOAD libraryItemId=" + libraryItemId +
                                        " filePath=" + requestedPath +
                                        " inMs=" + juce::String(inMs) +
                                        " durationMs=" + juce::String(durationMs));
    // The file browser auditions files that are not library items, so an explicit
    // path wins; otherwise the item id resolves to its source as before.
    const juce::String sourcePath =
        requestedPath.isNotEmpty() ? requestedPath : projectState.getLibraryItemFilePath(libraryItemId);
    if (sourcePath.isEmpty())
    {
        silverdaw::log::warn("preview", "PREVIEW_LOAD unknown libraryItemId=" + libraryItemId);
        return;
    }
    if (requestedPath.isNotEmpty() && !juce::File(requestedPath).existsAsFile())
    {
        silverdaw::log::warn("preview", "PREVIEW_LOAD missing file: " + requestedPath);
        return;
    }
    // Prefer the decoded WAV cache so compressed sources preview promptly.
    const juce::String playbackPath = resolveEnginePlaybackPath(sourcePath, projectState, decodedCache);
    PreviewLoadRequest request;
    request.libraryItemId = libraryItemId;
    request.inMs = inMs;
    request.durationMs = durationMs;
    if (payload.hasProperty("warpEnabled"))
    {
        request.warpEnabled = static_cast<bool>(payload.getProperty("warpEnabled", false));
        request.warpMode = readOptionalWarpMode(payload, "warpMode");
        if (payload.hasProperty("tempoRatio"))
        {
            const auto& v = payload["tempoRatio"];
            if (!v.isVoid() && !v.isUndefined()) request.tempoRatio = static_cast<double>(v);
        }
        if (payload.hasProperty("semitones"))
            request.semitones = static_cast<double>(payload.getProperty("semitones", 0.0));
        if (payload.hasProperty("cents"))
            request.cents = static_cast<double>(payload.getProperty("cents", 0.0));
    }

    const auto requestId = ++previewRequestCounter;

    // An MP3 with no cache entry yet must be decoded before it can be auditioned.
    // Handing the original to the engine relies on the built-in MP3 reader, which
    // mis-parses some files so badly that the audition silently does nothing —
    // exactly the "it plays everywhere else but not here" symptom. Decode on a
    // worker rather than the message thread so the UI never stalls.
    if (juce::File(playbackPath).hasFileExtension("mp3"))
    {
        silverdaw::log::info("preview",
                             "decoding " + juce::File(playbackPath).getFileName() + " before audition");
        peakPool.addJob(
            [&engine, &bridge, &projectState, &decodedCache, request, requestId,
             source = juce::File(sourcePath)]
            {
                const auto built = decodedCache.ensureDecoded(source, engine.getFormatManager());
                const auto& sourcePathCopy = source.getFullPathName();
                const auto builtPath = built.existsAsFile() ? built.getFullPathName() : juce::String{};
                juce::MessageManager::callAsync(
                    [&engine, &bridge, &projectState, request, requestId, sourcePathCopy, builtPath]
                    {
                        // A newer audition started while this decode ran.
                        if (previewRequestCounter.load() != requestId) return;
                        if (builtPath.isEmpty())
                        {
                            silverdaw::log::warn("preview",
                                                 "could not decode " + sourcePathCopy + " — nothing to audition");
                            broadcastPreviewState(engine, bridge, false, false, 0.0);
                            return;
                        }
                        const auto itemId = findLibraryItemIdForPath(projectState, sourcePathCopy);
                        if (itemId.isNotEmpty())
                        {
                            projectState.setLibraryItemPlaybackPath(itemId, builtPath);
                        }
                        loadPreviewAndBroadcast(builtPath, request, engine, bridge);
                    });
            });
        return;
    }

    loadPreviewAndBroadcast(playbackPath, request, engine, bridge);
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
    std::optional<juce::String> warpMode = readOptionalWarpMode(payload, "warpMode");
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

void handlePreviewSetLoop(const juce::var& payload, AudioEngine& engine)
{
    const bool enabled = static_cast<bool>(payload.getProperty("enabled", false));
    const double startMs = static_cast<double>(payload.getProperty("startMs", 0.0));
    const double endMs = static_cast<double>(payload.getProperty("endMs", 0.0));
    silverdaw::log::info("bridge", "recv PREVIEW_SET_LOOP enabled=" + std::string(enabled ? "1" : "0")
                                       + " start=" + std::to_string(startMs)
                                       + " end=" + std::to_string(endMs));
    // A window that isn't a forward range would wrap on every poll, so it disarms instead.
    if (! enabled || endMs <= startMs)
    {
        engine.setPreviewLoop(std::nullopt);
        return;
    }
    engine.setPreviewLoop(AudioEngine::LoopRange{juce::jmax(0.0, startMs), endMs});
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

void handlePreviewSetMetronome(const juce::var& payload, AudioEngine& engine, ProjectState& projectState)
{
    const bool enabled = static_cast<bool>(payload.getProperty("enabled", false));
    // bpm/anchor drive the click grid but are transient (they come from the clip's source item);
    // only the enabled flag persists with the project (silently, like the main metronome).
    const double bpm = static_cast<double>(payload.getProperty("bpm", 0.0));
    const double anchorSec = static_cast<double>(payload.getProperty("beatAnchorSec", 0.0));
    silverdaw::log::info("bridge", juce::String("recv PREVIEW_SET_METRONOME enabled=") +
                                       (enabled ? "1" : "0") + " bpm=" + juce::String(bpm, 2));
    engine.setPreviewMetronomeGrid(bpm, anchorSec);
    engine.setPreviewMetronomeEnabled(enabled);
    projectState.setClipEditorMetronomeEnabled(enabled);
}

} // namespace silverdaw
