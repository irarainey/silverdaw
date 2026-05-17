#include "AudioEngine.h"
#include "BridgeServer.h"
#include "Log.h"
#include "PeaksCache.h"
#include "ProjectFile.h"
#include "ProjectState.h"
#include "Waveform.h"

#include <atomic>
#include <chrono>
#include <csignal>
#include <iostream>
#include <juce_events/juce_events.h>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>

//==============================================================================
// Silverdaw headless audio backend - entry point.
//
// Lifecycle:
//   1. Initialise JUCE GUI singletons (MessageManager, AudioFormatManager pool).
//   2. Spin up the audio engine (default output device, stereo).
//   3. Start the WebSocket bridge on ws://localhost:8765.
//   4. Run the JUCE message dispatch loop. Audio runs on its own thread,
//      WebSocket I/O runs on ixwebsocket's threads; all engine mutations
//      are marshalled onto the message thread for safety.
//
// NOTE: keep string literals ASCII-only. juce::String(const char*) asserts on
// any byte > 127. For Unicode text, wrap with juce::CharPointer_UTF8.
//==============================================================================

namespace
{
constexpr int kDefaultBridgePort = 8765;
constexpr int kMinBridgePort = 1024;
constexpr int kMaxBridgePort = 65535;
constexpr int kPlayheadUpdateHz = 60;
// 4 workers keeps peak computation responsive without burning every core
// on a giant project import. Each job is disk-bound + a tight scan loop,
// so 4 is plenty even on a 16-core machine.
constexpr int kPeakWorkerCount = 4;

std::atomic<bool> g_shouldQuit{false};

void onSignal(int /*sig*/)
{
    g_shouldQuit.store(true);
    juce::MessageManager::getInstance()->stopDispatchLoop();
}

/**
 * Parse an integer port from a string. Returns the parsed value on success,
 * or `kDefaultBridgePort` on any failure (out of range / non-numeric /
 * trailing garbage). A warning is emitted on stderr in the failure path so
 * silent fallbacks remain debuggable.
 */
int parsePort(std::string_view value, std::string_view source)
{
    if (value.empty())
    {
        return kDefaultBridgePort;
    }

    int port = 0;
    try
    {
        std::size_t consumed = 0;
        port = std::stoi(std::string(value), &consumed);
        if (consumed != value.size())
        {
            throw std::invalid_argument("trailing characters");
        }
    }
    catch (const std::exception& e)
    {
        std::cerr << "[main] invalid port from " << source << " (" << value << "): " << e.what() << "; using default "
                  << kDefaultBridgePort << '\n';
        return kDefaultBridgePort;
    }

    if (port < kMinBridgePort || port > kMaxBridgePort)
    {
        std::cerr << "[main] port " << port << " from " << source << " outside [" << kMinBridgePort << ", "
                  << kMaxBridgePort << "]; using default " << kDefaultBridgePort << '\n';
        return kDefaultBridgePort;
    }

    return port;
}

/**
 * Resolve the bridge listen port. Precedence (highest first):
 *   1. `--port <N>` or `--port=N` command-line argument
 *   2. `SILVERDAW_BRIDGE_PORT` environment variable
 *   3. compiled-in default (`kDefaultBridgePort`)
 *
 * The Electron main process picks an unused loopback port and passes it
 * via `--port` so multiple Silverdaw instances can run side-by-side without
 * colliding on 8765.
 */
// `argv` is necessarily a C-style array — that's the only legal signature for
// `main` and forwarded helpers. clang-tidy's modernize check doesn't model that.
// NOLINTNEXTLINE(modernize-avoid-c-arrays,hicpp-avoid-c-arrays,cppcoreguidelines-avoid-c-arrays)
int resolveBridgePort(int argc, char* argv[])
{
    for (int i = 1; i < argc; ++i)
    {
        const std::string_view arg{argv[i]};
        if (arg == "--port" && i + 1 < argc)
        {
            return parsePort(argv[i + 1], "--port");
        }
        constexpr std::string_view prefix = "--port=";
        if (arg.size() > prefix.size() && arg.substr(0, prefix.size()) == prefix)
        {
            return parsePort(arg.substr(prefix.size()), "--port=");
        }
    }

    // JUCE's wrapper is portable AND silences the MSVC "getenv is unsafe"
    // deprecation noise without a per-translation-unit pragma.
    const juce::String envValue = juce::SystemStats::getEnvironmentVariable("SILVERDAW_BRIDGE_PORT", {});
    if (envValue.isNotEmpty())
    {
        return parsePort(envValue.toStdString(), "SILVERDAW_BRIDGE_PORT");
    }

    return kDefaultBridgePort;
}

/**
 * Resolve the per-session AUTH token the bridge will require from every
 * connecting client. Precedence (highest first):
 *   1. `--token <hex>` or `--token=<hex>` command-line argument
 *   2. `SILVERDAW_BRIDGE_TOKEN` environment variable
 *   3. empty string → authentication disabled (stand-alone manual debug only;
 *      `BridgeServer` logs a loud warning when this happens at startup).
 *
 * Electron main generates a fresh random token per session and forwards it
 * via the env var. The CLI form is provided for hand-testing the backend
 * out of process — never use it in production: command-line arguments are
 * visible to other processes via the OS process table.
 */
// `argv` is necessarily a C-style array — see note on `resolveBridgePort`.
// NOLINTNEXTLINE(modernize-avoid-c-arrays,hicpp-avoid-c-arrays,cppcoreguidelines-avoid-c-arrays)
juce::String resolveBridgeToken(int argc, char* argv[])
{
    for (int i = 1; i < argc; ++i)
    {
        const std::string_view arg{argv[i]};
        if (arg == "--token" && i + 1 < argc)
        {
            return juce::String{argv[i + 1]};
        }
        constexpr std::string_view prefix = "--token=";
        if (arg.size() > prefix.size() && arg.substr(0, prefix.size()) == prefix)
        {
            return juce::String{std::string(arg.substr(prefix.size()))};
        }
    }

    return juce::SystemStats::getEnvironmentVariable("SILVERDAW_BRIDGE_TOKEN", {});
}

/** Polls the audio engine and broadcasts PLAYHEAD_UPDATE while playing. */
class PlayheadEmitter : public juce::Timer
{
  public:
    PlayheadEmitter(silverdaw::AudioEngine& e, silverdaw::BridgeServer& b)
        : engine(e), bridge(b), payloadObject(new juce::DynamicObject()), payload(payloadObject.get())
    {
    }

    void timerCallback() override
    {
        const bool playing = engine.isPlaying();
        const double posMs = engine.getPositionMs();

        // Always broadcast on transitions; while playing, broadcast every tick so the
        // renderer can drive a smooth playhead. Reuse a single DynamicObject so we
        // don't churn the heap 60x/s on the message thread.
        if (playing || posMs != lastPosMs)
        {
            payloadObject->setProperty("positionMs", posMs);
            payloadObject->setProperty("isPlaying", playing);
            bridge.broadcast("PLAYHEAD_UPDATE", payload);
            lastPosMs = posMs;
        }
    }

  private:
    silverdaw::AudioEngine& engine;
    silverdaw::BridgeServer& bridge;
    // Reference-counted: held alive by `payloadObject`; `payload` is the
    // pre-wrapped juce::var we hand to broadcast() each tick.
    juce::DynamicObject::Ptr payloadObject;
    juce::var payload;
    double lastPosMs = -1.0;
};

/**
 * Extract a numeric field from a bridge payload without the silent
 * coercion that `juce::var::getProperty(key, default)` performs. Returns
 * `std::nullopt` (and logs once) when the field is missing or wrong-typed
 * so dispatch handlers can reject the envelope instead of silently
 * applying a default value (e.g. seek-to-0, zero-gain).
 */
std::optional<double> tryGetNumber(const juce::var& payload, const char* key)
{
    const juce::var v = payload.getProperty(key, juce::var());
    if (v.isDouble() || v.isInt() || v.isInt64())
    {
        return static_cast<double>(v);
    }
    std::cerr << "[bridge] field '" << key << "' missing or non-numeric; envelope ignored\n";
    return std::nullopt;
}

/**
 * Compute or load peaks for `filePath` and broadcast a binary
 * `WAVEFORM_DATA` frame to all authenticated clients. Designed to be
 * called from a `juce::ThreadPool` job — does its own disk I/O, never
 * touches the message thread, and uses `BridgeServer::broadcastBinary`
 * which is mutex-guarded so it's safe to call from any thread.
 *
 * Cache lookup first; on miss, compute + persist. The bridge broadcasts
 * the same wire bytes either way. An empty result (decode failure) is
 * NOT broadcast — silent failure means the renderer keeps drawing the
 * empty placeholder until the user retries or the file becomes readable.
 */
void produceAndBroadcastPeaks(const juce::String& clipId, const juce::File& filePath,
                              silverdaw::AudioEngine& engine, const silverdaw::PeaksCache& cache,
                              silverdaw::BridgeServer& bridge)
{
    constexpr int kPeaksPerSecond = silverdaw::waveform::kDefaultPeaksPerSecond;
    silverdaw::log::info("peaksjob", "start clipId=" + clipId + " file=" + filePath.getFileName());
    auto result = cache.tryLoad(filePath, kPeaksPerSecond);
    const bool fromCache = !result.peaks.empty();
    if (!fromCache)
    {
        result = silverdaw::waveform::computePeaks(filePath, engine.getFormatManager(), kPeaksPerSecond);
        if (!result.peaks.empty())
        {
            cache.store(filePath, result);
        }
    }
    if (result.peaks.empty())
    {
        silverdaw::log::warn("peaksjob", "no peaks produced for clipId=" + clipId);
        return;
    }
    const auto frames = silverdaw::waveform::encodeWaveformFrames(clipId, result);

    // Serialise the chunk-burst across ALL peaks jobs running on the
    // worker pool. The per-job 2 ms inter-chunk yield is only sufficient
    // to keep the IXWebSocket I/O loop drained if exactly one job is
    // sending at a time; with two jobs (e.g. reloading a project that
    // has two clips, both cache-hits delivered in parallel) the
    // combined ~40-chunk burst at the doubled rate would starve the
    // read side and silently freeze inbound traffic — including
    // TRANSPORT_PLAY clicks the user makes seconds later. The mutex
    // guarantees only one job is mid-send at any time; the 2 ms yields
    // inside that job still give the I/O loop room to read.
    static std::mutex peakBroadcastMutex;
    std::lock_guard<std::mutex> lock(peakBroadcastMutex);
    for (std::size_t i = 0; i < frames.size(); ++i)
    {
        bridge.broadcastBinary(frames[i]);
        // Yield briefly between chunks so IXWebSocket's per-connection
        // I/O thread can drain reads from the renderer between writes.
        if (i + 1 < frames.size())
        {
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
    }
    silverdaw::log::info("peaksjob", "done clipId=" + clipId + " chunks=" + juce::String(static_cast<int>(frames.size())) +
                                          (fromCache ? " (cache hit)" : " (computed)"));
}

void handleClipAdd(const juce::var& payload, silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                   silverdaw::BridgeServer& bridge, juce::ThreadPool& peakPool, const silverdaw::PeaksCache& cache)
{
    const juce::String trackId = payload.getProperty("trackId", juce::var()).toString();
    const juce::String clipId = payload.getProperty("clipId", juce::var()).toString();
    const juce::String filePath = payload.getProperty("filePath", juce::var()).toString();
    if (trackId.isEmpty() || clipId.isEmpty() || filePath.isEmpty())
    {
        return;
    }

    // Pull the initial offset out of the payload up front so addClip can
    // apply it atomically with the load — otherwise a separate
    // setClipOffsetMs call would race against the audio thread, briefly
    // playing the clip at offset 0.
    const juce::var posVar = payload.getProperty("positionMs", juce::var());
    const double initialOffsetMs =
        (posVar.isDouble() || posVar.isInt() || posVar.isInt64()) ? juce::jmax(0.0, static_cast<double>(posVar)) : 0.0;

    // Auto-create the parent track in the ValueTree if the renderer didn't
    // (e.g. older clients that never send TRACK_ADD). Idempotent.
    projectState.addTrack(trackId);

    juce::String errorMsg;
    bool ok = engine.addClip(clipId, juce::File(filePath), initialOffsetMs, &errorMsg);
    if (ok)
    {
        // Mirror the audio change into the structural project state, capturing
        // the file's duration so PROJECT_STATE on reconnect can rebuild the
        // clip block geometry without re-reading the file from the renderer.
        const double durationMs = engine.getClipDurationMs(clipId);
        if (!projectState.addClip(trackId, clipId, filePath, initialOffsetMs, durationMs))
        {
            // Engine accepted the audio source but ProjectState rejected
            // (e.g. clipId collided). Roll back the audio side so the two
            // models can't drift, and report failure to the renderer.
            engine.removeClip(clipId);
            ok = false;
            errorMsg = "duplicate clipId or unknown trackId";
        }
    }

    auto* p = new juce::DynamicObject();
    p->setProperty("trackId", trackId);
    p->setProperty("clipId", clipId);
    p->setProperty("filePath", filePath);
    p->setProperty("ok", ok);
    if (!ok)
    {
        p->setProperty("error", errorMsg);
    }
    bridge.broadcast(ok ? "CLIP_ADDED" : "CLIP_ADD_FAILED", juce::var(p));

    if (ok)
    {
        // Kick off peaks generation on the worker pool. The job is fire-and-
        // forget from the message thread's perspective; clients receive the
        // waveform as a separate binary frame whenever the worker finishes
        // (or instantly if the disk cache already has an entry for this file).
        peakPool.addJob(
            [clipId, file = juce::File(filePath), &engine, &cache, &bridge]
            { produceAndBroadcastPeaks(clipId, file, engine, cache, bridge); });
    }
}

void handleWaveformRequest(const juce::var& payload, silverdaw::AudioEngine& engine,
                           silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                           juce::ThreadPool& peakPool, const silverdaw::PeaksCache& cache)
{
    const juce::String clipId = payload.getProperty("clipId", juce::var()).toString();
    if (clipId.isEmpty())
    {
        return;
    }
    // Find the file the backend has on record for this clip. The renderer
    // never sends the path on a WAVEFORM_REQUEST — the backend is the
    // authority over what file each clipId resolves to.
    const auto trackId = projectState.getClipTrackId(clipId);
    if (trackId.isEmpty())
    {
        std::cerr << "[bridge] WAVEFORM_REQUEST for unknown clipId " << clipId.toStdString() << '\n';
        return;
    }
    const auto filePath = projectState.getClipFilePath(clipId);
    if (filePath.isEmpty())
    {
        return;
    }

    peakPool.addJob(
        [clipId, file = juce::File(filePath), &engine, &cache, &bridge]
        { produceAndBroadcastPeaks(clipId, file, engine, cache, bridge); });
}

void handleClipMove(const juce::var& payload, silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState)
{
    const juce::String clipId = payload.getProperty("clipId", juce::var()).toString();
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
}

void handleTrackAdd(const juce::var& payload, silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge)
{
    const juce::String trackId = payload.getProperty("trackId", juce::var()).toString();
    if (trackId.isEmpty())
    {
        return;
    }
    const bool ok = projectState.addTrack(trackId);
    auto* p = new juce::DynamicObject();
    p->setProperty("trackId", trackId);
    p->setProperty("ok", ok);
    bridge.broadcast("TRACK_ADDED", juce::var(p));
}

void handleTrackRemove(const juce::var& payload, silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                       silverdaw::BridgeServer& bridge)
{
    const juce::String trackId = payload.getProperty("trackId", juce::var()).toString();
    if (trackId.isEmpty())
    {
        return;
    }
    const bool existed = projectState.hasTrack(trackId);
    // Tear down every audio source on this track BEFORE dropping the
    // track from ProjectState — otherwise the lookup loses the clip ids.
    const auto clipIds = projectState.getTrackClipIds(trackId);
    for (const auto& clipId : clipIds)
    {
        engine.removeClip(clipId);
    }
    projectState.removeTrack(trackId);
    auto* p = new juce::DynamicObject();
    p->setProperty("trackId", trackId);
    p->setProperty("ok", existed);
    bridge.broadcast("TRACK_REMOVED", juce::var(p));
}

void handleTrackGain(const juce::var& payload, silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                     silverdaw::BridgeServer& bridge)
{
    const juce::String trackId = payload.getProperty("trackId", juce::var()).toString();
    if (trackId.isEmpty())
    {
        return;
    }
    const auto gain = tryGetNumber(payload, "gain");
    if (!gain.has_value())
    {
        return;
    }
    const auto gainF = static_cast<float>(*gain);
    const bool stored = projectState.setTrackGain(trackId, gainF);
    // Fan the gain out to every clip on this logical track so multi-clip
    // tracks all hear the same volume. With one-clip-per-track today the
    // loop body runs at most once; the structure is ready for Phase 5.
    const auto clipIds = projectState.getTrackClipIds(trackId);
    for (const auto& clipId : clipIds)
    {
        engine.setClipGain(clipId, gainF);
    }
    auto* p = new juce::DynamicObject();
    p->setProperty("trackId", trackId);
    p->setProperty("gain", gainF);
    p->setProperty("ok", stored);
    bridge.broadcast("TRACK_GAIN_APPLIED", juce::var(p));
}

// ─── Project-level state (save / load / new / rename) ────────────────────

/**
 * Per-process project-lifecycle state. Owned by `runBackend`, captured by
 * reference into every project-mutating handler. `currentPath` is empty
 * for a project that has never been saved (the renderer shows the name
 * "Untitled" alongside).
 */
struct ProjectSession
{
    juce::String currentPath;
};

/** Walk every clip in `projectState` and gather their ids in tree order. */
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

/**
 * Build the PROJECT_STATE envelope payload. `reset` is added (as `true`)
 * when the snapshot is a hard replacement (PROJECT_NEW / PROJECT_LOAD)
 * so the renderer wipes optimistic local state first; on the connect
 * path the snapshot is purely additive and `reset` is omitted.
 */
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
    return juce::var(obj);
}

/**
 * Replace the engine's playable sources with one per clip described in
 * `projectState`. Caller is responsible for first dropping every clip
 * the engine currently holds — `handleProjectLoad` / `handleProjectNew`
 * do that immediately before invoking this.
 */
void rebuildEngineFromProject(silverdaw::AudioEngine& engine, const silverdaw::ProjectState& projectState)
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
        for (int c = 0; c < track.getNumChildren(); ++c)
        {
            const auto clip = track.getChild(c);
            if (!clip.hasType(juce::Identifier{"CLIP"}))
            {
                continue;
            }
            const juce::String clipId = clip.getProperty("id").toString();
            const juce::String filePath = clip.getProperty("filePath").toString();
            const double offsetMs = static_cast<double>(clip.getProperty("offsetMs", 0.0));
            if (clipId.isEmpty() || filePath.isEmpty())
            {
                continue;
            }
            juce::String err;
            if (engine.addClip(clipId, juce::File(filePath), offsetMs, &err))
            {
                ++rebuilt;
            }
            else
            {
                ++failed;
                // Always surface to stderr (independent of debug logging)
                // because a missing source file is the single most common
                // reason audio fails to play after a project load, and
                // the user has no other diagnostic channel when debug is
                // off. Renderer-facing toasts are added by the
                // unresolved-files todo (save-load-unresolved-files).
                std::cerr << "[project] addClip FAILED for clipId=" << clipId.toStdString()
                          << " path=" << filePath.toStdString() << " err=" << err.toStdString() << '\n';
                silverdaw::log::warn("project", "addClip failed clipId=" + clipId + " path=" + filePath +
                                                     " err=" + err);
            }
        }
    }
    if (failed > 0)
    {
        std::cerr << "[project] rebuilt " << rebuilt << " clip(s); " << failed
                  << " failed (audio for those clips will be silent)\n";
    }
}

void handleProjectNew(silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                      silverdaw::BridgeServer& bridge, ProjectSession& session)
{
    // Capture the CURRENT project's clip ids before we replace the tree —
    // otherwise we'd ask the engine to remove the freshly-empty set,
    // leaking the old playable sources.
    const auto previousClipIds = collectClipIds(projectState);

    engine.stop();
    for (const auto& id : previousClipIds)
    {
        engine.removeClip(id);
    }

    juce::ValueTree fresh(juce::Identifier{"PROJECT"});
    fresh.setProperty(juce::Identifier{"name"}, silverdaw::ProjectState::kDefaultName, nullptr);
    projectState.replaceTree(fresh);
    session.currentPath.clear();

    bridge.broadcast("PROJECT_STATE", buildProjectStateEnvelope(session, projectState, true));
}

void handleProjectLoad(const juce::var& payload, silverdaw::AudioEngine& engine,
                       silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                       ProjectSession& session)
{
    const juce::String filePath = payload.getProperty("filePath", juce::var()).toString();
    if (filePath.isEmpty())
    {
        auto* p = new juce::DynamicObject();
        p->setProperty("filePath", filePath);
        p->setProperty("error", juce::String("Missing filePath"));
        bridge.broadcast("PROJECT_LOAD_FAILED", juce::var(p));
        return;
    }

    // Capture OLD clip ids before the load wipes the ValueTree — needed
    // to tear down the engine's playable sources for the previous
    // project. Done before `ProjectFile::load` so a load failure leaves
    // the engine intact (we only call removeClip / addClip on success).
    const auto previousClipIds = collectClipIds(projectState);

    const auto result = silverdaw::ProjectFile::load(juce::File(filePath), projectState);
    if (!result.ok)
    {
        auto* p = new juce::DynamicObject();
        p->setProperty("filePath", filePath);
        p->setProperty("error", result.error);
        bridge.broadcast("PROJECT_LOAD_FAILED", juce::var(p));
        silverdaw::log::warn("project", "PROJECT_LOAD failed: " + result.error);
        return;
    }

    engine.stop();
    for (const auto& id : previousClipIds)
    {
        engine.removeClip(id);
    }
    rebuildEngineFromProject(engine, projectState);
    session.currentPath = filePath;

    bridge.broadcast("PROJECT_STATE", buildProjectStateEnvelope(session, projectState, true));
    silverdaw::log::info("project", "PROJECT_LOAD ok path=" + filePath);
}

void handleProjectSave(const juce::var& payload, silverdaw::ProjectState& projectState,
                       silverdaw::BridgeServer& bridge, ProjectSession& session, bool isSaveAs)
{
    juce::String filePath = payload.getProperty("filePath", juce::var()).toString();
    if (filePath.isEmpty())
    {
        // PROJECT_SAVE with no path falls back to the current project's
        // path. The renderer is supposed to gate this on currentFilePath
        // being non-null, but we double-check defensively.
        filePath = session.currentPath;
    }
    if (filePath.isEmpty())
    {
        auto* p = new juce::DynamicObject();
        p->setProperty("filePath", filePath);
        p->setProperty("ok", false);
        p->setProperty("error", juce::String("No project path; use Save As first"));
        bridge.broadcast("PROJECT_SAVED", juce::var(p));
        return;
    }

    const auto result = silverdaw::ProjectFile::save(juce::File(filePath), projectState);
    auto* p = new juce::DynamicObject();
    p->setProperty("filePath", filePath);
    p->setProperty("ok", result.wasOk());
    if (!result.wasOk())
    {
        p->setProperty("error", result.getErrorMessage());
    }
    if (result.wasOk())
    {
        session.currentPath = filePath;
        // For Save As, fold the file basename into the project name so
        // the title bar updates without a separate rename round-trip.
        if (isSaveAs)
        {
            const auto stem = juce::File(filePath).getFileNameWithoutExtension();
            if (stem.isNotEmpty())
            {
                projectState.setName(stem);
            }
        }
    }
    bridge.broadcast("PROJECT_SAVED", juce::var(p));
    silverdaw::log::info("project",
                         juce::String("PROJECT_SAVE ") + (isSaveAs ? "(as) " : "") +
                             (result.wasOk() ? "ok" : "fail: " + result.getErrorMessage()) + " path=" + filePath);
    if (result.wasOk() && isSaveAs)
    {
        // Push the updated project state so the renderer picks up the
        // new filePath + name without waiting on a rename ack.
        bridge.broadcast("PROJECT_STATE", buildProjectStateEnvelope(session, projectState, false));
    }
}

void handleProjectRename(const juce::var& payload, silverdaw::ProjectState& projectState,
                         silverdaw::BridgeServer& bridge)
{
    const juce::String name = payload.getProperty("name", juce::var()).toString();
    projectState.setName(name);
    auto* p = new juce::DynamicObject();
    p->setProperty("name", projectState.getName());
    p->setProperty("ok", true);
    bridge.broadcast("PROJECT_RENAMED", juce::var(p));
}

// Same wire-protocol convention as BridgeServer::broadcast: (type, payload) order is
// fixed by design, so the easily-swappable-parameters check is intentionally silenced.
// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
void dispatchBridgeMessage(const juce::String& type, const juce::var& payload, silverdaw::AudioEngine& engine,
                           silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                           juce::ThreadPool& peakPool, const silverdaw::PeaksCache& cache, ProjectSession& session)
{
    if (type == "CLIP_ADD")
    {
        silverdaw::log::info("bridge", "recv CLIP_ADD trackId=" + payload.getProperty("trackId", "").toString() +
                                           " clipId=" + payload.getProperty("clipId", "").toString());
        handleClipAdd(payload, engine, projectState, bridge, peakPool, cache);
    }
    else if (type == "CLIP_MOVE")
    {
        silverdaw::log::debug("bridge", "recv CLIP_MOVE clipId=" + payload.getProperty("clipId", "").toString() +
                                            " pos=" + payload.getProperty("positionMs", "").toString());
        handleClipMove(payload, engine, projectState);
    }
    else if (type == "TRANSPORT_PLAY")
    {
        silverdaw::log::info("bridge", "recv TRANSPORT_PLAY");
        engine.play();
    }
    else if (type == "TRANSPORT_PAUSE")
    {
        silverdaw::log::info("bridge", "recv TRANSPORT_PAUSE");
        engine.pause();
    }
    else if (type == "TRANSPORT_STOP")
    {
        silverdaw::log::info("bridge", "recv TRANSPORT_STOP");
        engine.stop();
    }
    else if (type == "TRANSPORT_SEEK")
    {
        const auto positionMs = tryGetNumber(payload, "positionMs");
        silverdaw::log::info("bridge", "recv TRANSPORT_SEEK pos=" + juce::String(positionMs.value_or(-1.0)));
        if (positionMs.has_value())
        {
            engine.setPositionMs(*positionMs);
        }
    }
    else if (type == "TRACK_ADD")
    {
        silverdaw::log::info("bridge", "recv TRACK_ADD trackId=" + payload.getProperty("trackId", "").toString());
        handleTrackAdd(payload, projectState, bridge);
    }
    else if (type == "TRACK_REMOVE")
    {
        silverdaw::log::info("bridge", "recv TRACK_REMOVE trackId=" + payload.getProperty("trackId", "").toString());
        handleTrackRemove(payload, engine, projectState, bridge);
    }
    else if (type == "TRACK_GAIN")
    {
        silverdaw::log::debug("bridge", "recv TRACK_GAIN trackId=" + payload.getProperty("trackId", "").toString() +
                                            " gain=" + payload.getProperty("gain", "").toString());
        handleTrackGain(payload, engine, projectState, bridge);
    }
    else if (type == "WAVEFORM_REQUEST")
    {
        silverdaw::log::debug("bridge", "recv WAVEFORM_REQUEST clipId=" + payload.getProperty("clipId", "").toString());
        handleWaveformRequest(payload, engine, projectState, bridge, peakPool, cache);
    }
    else if (type == "PROJECT_NEW")
    {
        silverdaw::log::info("bridge", "recv PROJECT_NEW");
        handleProjectNew(engine, projectState, bridge, session);
    }
    else if (type == "PROJECT_SAVE")
    {
        silverdaw::log::info("bridge", "recv PROJECT_SAVE");
        handleProjectSave(payload, projectState, bridge, session, /*isSaveAs*/ false);
    }
    else if (type == "PROJECT_SAVE_AS")
    {
        silverdaw::log::info("bridge", "recv PROJECT_SAVE_AS path=" + payload.getProperty("filePath", "").toString());
        handleProjectSave(payload, projectState, bridge, session, /*isSaveAs*/ true);
    }
    else if (type == "PROJECT_LOAD")
    {
        silverdaw::log::info("bridge", "recv PROJECT_LOAD path=" + payload.getProperty("filePath", "").toString());
        handleProjectLoad(payload, engine, projectState, bridge, session);
    }
    else if (type == "PROJECT_RENAME")
    {
        silverdaw::log::info("bridge", "recv PROJECT_RENAME name=" + payload.getProperty("name", "").toString());
        handleProjectRename(payload, projectState, bridge);
    }
    else
    {
        silverdaw::log::warn("bridge", "unhandled message type: " + type);
    }
}

// See note on `resolveBridgePort`: argv must remain a C-style array.
// NOLINTNEXTLINE(modernize-avoid-c-arrays,hicpp-avoid-c-arrays,cppcoreguidelines-avoid-c-arrays)
int runBackend(int argc, char* argv[])
{
    // Initialise the cross-layer file logger only when Electron main
    // explicitly opts in via `SILVERDAW_LOG_DIR` (set when the user has
    // toggled "Enable Debugging" in Preferences). Without it the logger
    // stays uninitialised and every `silverdaw::log::*` call is a
    // silent no-op — so a normal-use packaged install never writes a
    // backend.log nor creates a `.logs/` directory.
    const auto logDirOverride = juce::SystemStats::getEnvironmentVariable("SILVERDAW_LOG_DIR", {});
    if (logDirOverride.isNotEmpty())
    {
        silverdaw::log::initialise(logDirOverride);
    }

    const juce::String banner = "Silverdaw Backend v1.0.0 - " + juce::SystemStats::getOperatingSystemName() + " (" +
                                juce::SystemStats::getCpuVendor() + ")";
    std::cout << banner.toStdString() << '\n';
    silverdaw::log::info("main", banner);

    const int bridgePort = resolveBridgePort(argc, argv);
    const juce::String bridgeToken = resolveBridgeToken(argc, argv);

    // Initialises MessageManager, JUCE singletons, etc. Required even for headless apps.
    const juce::ScopedJuceInitialiser_GUI juceInit;

    silverdaw::AudioEngine engine;
    if (const auto err = engine.initialise(); err.isNotEmpty())
    {
        silverdaw::log::error("engine", "audio device init failed: " + err);
        std::cerr << "[engine] audio device init failed: " << err.toStdString() << '\n';
    }

    silverdaw::ProjectState projectState;
    ProjectSession session;

    // Disk-backed cache for waveform peaks. Reused across renderer reloads
    // and even backend restarts so the same file never recomputes peaks
    // twice. See `PeaksCache.h` for the on-disk format.
    const silverdaw::PeaksCache peaksCache;

    if (bridgeToken.isEmpty())
    {
        silverdaw::log::warn("bridge", "no AUTH token set; accepting all loopback clients (debug only)");
        std::cerr << "[bridge] WARNING: no AUTH token set (SILVERDAW_BRIDGE_TOKEN unset and "
                     "--token not given); accepting all loopback clients. DO NOT USE IN PRODUCTION.\n";
    }

    // Worker pool for off-message-thread work — currently only peaks
    // computation. Declared BEFORE `bridge` so the bridge's lambdas can
    // capture it by reference. Shutdown explicitly drains the pool
    // before any of the captured objects (bridge, peaksCache, engine)
    // destruct — see `peakPool.removeAllJobs(...)` below the dispatch
    // loop.
    juce::ThreadPool peakPool(kPeakWorkerCount);

    // Construct the bridge with the token, message handler, and the
    // post-AUTH initial-state hook frozen at construction time — the I/O
    // thread reads all three lock-free, so freezing them at construction
    // is what makes the read race-free by design. The handler receives
    // `BridgeServer&` from `onIncoming` so it can call `broadcast()` for
    // acks (e.g. CLIP_ADDED) without a chicken-and-egg capture problem.
    silverdaw::BridgeServer bridge(
        bridgeToken,
        [&engine, &projectState, &peakPool, &peaksCache, &session](silverdaw::BridgeServer& self,
                                                                    const juce::String& type, const juce::var& payload)
        { dispatchBridgeMessage(type, payload, engine, projectState, self, peakPool, peaksCache, session); },
        [&projectState, &session](const silverdaw::BridgeServer::SendToClient& sendToClient)
        {
            // PROJECT_STATE is sent only to the newly-authenticated client,
            // not broadcast — other clients (if any) already have their own
            // snapshot from when they connected. `reset` is omitted on the
            // connect path so the renderer treats it as additive.
            sendToClient("PROJECT_STATE", buildProjectStateEnvelope(session, projectState, false));
        });

    if (!bridge.start(bridgePort))
    {
        silverdaw::log::error("bridge", "failed to start; exiting");
        std::cerr << "[bridge] failed to start; exiting\n";
        return 1;
    }

    PlayheadEmitter emitter(engine, bridge);
    emitter.startTimerHz(kPlayheadUpdateHz);

    // Catch Ctrl+C so the dispatch loop can exit cleanly.
    std::signal(SIGINT, onSignal);
    std::signal(SIGTERM, onSignal);

    juce::MessageManager::getInstance()->runDispatchLoop();

    // Drain the peaks worker pool BEFORE any of `bridge` / `peaksCache` /
    // `engine` destruct, so an in-flight job that captures references to
    // them can't observe a half-destroyed object. `removeAllJobs(false)`
    // waits up to the timeout for running jobs to finish naturally — the
    // peaks loop is bounded by file size, ~hundreds of ms at worst.
    peakPool.removeAllJobs(false, 5000);

    emitter.stopTimer();
    bridge.stop();
    engine.shutdown();
    silverdaw::log::info("main", "shutdown complete");
    silverdaw::log::shutdown();
    std::cout << "[main] shutdown complete\n";
    return 0;
}
} // namespace

// The catch handler logs to std::cerr, which clang-tidy can't statically prove is
// non-throwing; in practice cerr won't throw without exceptions() being enabled.
// `argv` has to be a C-style array — only legal `main` signature.
// NOLINTNEXTLINE(bugprone-exception-escape,modernize-avoid-c-arrays,hicpp-avoid-c-arrays,cppcoreguidelines-avoid-c-arrays)
int main(int argc, char* argv[])
{
    try
    {
        return runBackend(argc, argv);
    }
    catch (const std::exception& e)
    {
        std::cerr << "[fatal] uncaught exception: " << e.what() << '\n';
        return 1;
    }
    catch (...)
    {
        std::cerr << "[fatal] uncaught non-standard exception\n";
        return 1;
    }
}
