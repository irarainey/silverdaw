#include "AudioEngine.h"
#include "AudioConstants.h"
#include "AudioDeviceCommands.h"
#include "BpmDetector.h"
#include "BridgeServer.h"
#include "ClipCommands.h"
#include "CommandHelpers.h"
#include "DecodedCache.h"
#include "EditUndoState.h"
#include "Log.h"
#include "MixdownEngine.h"
#include "EnginePlaybackPath.h"
#include "LibraryAnalysis.h"
#include "LibraryCommands.h"
#include "PreviewCommands.h"
#include "TransportCommands.h"
#include "MarkerCommands.h"
#include "PayloadHelpers.h"
#include "PeaksCache.h"
#include "PlayheadEmitter.h"
#include "ProjectFile.h"
#include "ProjectFxCommands.h"
#include "ProjectSession.h"
#include "ProjectState.h"
#include "SampleExport.h"
#include "TransitionCommands.h"
#include "TrackCommands.h"
#include "Waveform.h"
#include "WaveformCommands.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <iostream>
#include <juce_events/juce_events.h>
#include <mutex>
#include <optional>
#include <set>
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
constexpr int kMinBridgePort = 1024;
constexpr int kMaxBridgePort = 65535;
constexpr int kPlayheadUpdateHz = 60;
// 4 workers keeps peak computation responsive without burning every core
// on a giant project import. Each job is disk-bound + a tight scan loop,
// so 4 is plenty even on a 16-core machine.
constexpr int kPeakWorkerCount = 4;

std::atomic<bool> g_shouldQuit{false};
// Mixdown job state. `g_mixdownBusy` is set true while a render is in
// flight and gates `TRANSPORT_PLAY` so transport can't audibly start
// mid-render. `g_mixdownCancel` is the cancel flag the engine polls
// every block.
std::atomic<bool> g_mixdownBusy{false};
std::atomic<bool> g_mixdownCancel{false};

void onSignal(int /*sig*/)
{
    g_shouldQuit.store(true);
    juce::MessageManager::getInstance()->stopDispatchLoop();
}

/**
 * Parse an integer port from a string. Returns the parsed value on
 * success, or `-1` on any failure (empty / non-numeric / trailing
 * garbage / out of `[kMinBridgePort, kMaxBridgePort]`). A warning is
 * logged so silent fallbacks remain debuggable.
 */
int parsePort(std::string_view value, std::string_view source)
{
    if (value.empty())
    {
        silverdaw::log::warn("main",
                             juce::String("empty port value from ") + juce::String(std::string(source)));
        return -1;
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
        silverdaw::log::warn("main",
                             juce::String("invalid port from ") + juce::String(std::string(source)) + " (" +
                                 juce::String(std::string(value)) + "): " + juce::String(e.what()));
        return -1;
    }

    if (port < kMinBridgePort || port > kMaxBridgePort)
    {
        silverdaw::log::warn("main",
                             juce::String("port ") + juce::String(port) + " from " +
                                 juce::String(std::string(source)) + " outside [" +
                                 juce::String(kMinBridgePort) + ", " + juce::String(kMaxBridgePort) + "]");
        return -1;
    }

    return port;
}

/**
 * Resolve the bridge listen port from `--port <N>` / `--port=N`. The
 * Electron main process is the single source of truth for the port —
 * it picks an unused loopback port (so multiple Silverdaw instances
 * can coexist) and passes it to every spawned backend via `--port`.
 *
 * Returns `-1` when `--port` is missing or invalid; `runBackend` then
 * refuses to start. There is no compiled-in default and no env-var
 * fallback: a missing `--port` is always a configuration bug.
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

    silverdaw::log::error("main",
                          juce::String("missing required --port <N> argument (range [") +
                              juce::String(kMinBridgePort) + ", " + juce::String(kMaxBridgePort) +
                              "]); refusing to start");
    return -1;
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

// Bridge payload validation helpers live in `PayloadHelpers.h` so the
// backend test binary can link them in. Hoist them into the
// anonymous namespace here so existing dispatch call sites
// (`tryGetNumber(payload, "X")` etc.) keep working unchanged.
using silverdaw::bridge::tryGetNumber;
using silverdaw::bridge::tryGetRequiredString;
using silverdaw::bridge::tryGetString;
using silverdaw::bridge::readOptionalNumber;
using silverdaw::bridge::readOptionalBool;
using silverdaw::bridge::readOptionalString;
using silverdaw::broadcastApplied;

// ─── Project-level state (save / load / new / rename) ────────────────────

/**
 * Library-item relink. Updates the source file path on a library item
 * and rebuilds every clip that references it. Every dependent clip
 * picks up the new file automatically because clips reference the
 * library item by id, not by path.
 */
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

    // Re-create every clip that points at this library item so the
    // engine swaps in the new source file. Each clip is its own
    // playable source in the engine, so we rebuild them individually.
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

    // Re-broadcast PROJECT_STATE so the renderer learns the new
    // filePath + clears the unresolved flag on every dependent clip.
    bridge.broadcast("PROJECT_STATE", silverdaw::buildProjectStateEnvelope(session, projectState, false));
}

void handleProjectNew(silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                      silverdaw::BridgeServer& bridge, silverdaw::ProjectSession& session)
{
    // Capture the CURRENT project's clip ids before we replace the tree —
    // otherwise we'd ask the engine to remove the freshly-empty set,
    // leaking the old playable sources.
    const auto previousClipIds = silverdaw::collectClipIds(projectState);

    engine.stop();
    for (const auto& id : previousClipIds)
    {
        engine.removeClip(id);
    }

    juce::ValueTree fresh(juce::Identifier{"PROJECT"});
    fresh.setProperty(juce::Identifier{"name"}, silverdaw::ProjectState::kDefaultName, nullptr);
    projectState.replaceTree(fresh);
    session.currentPath.clear();

    bridge.broadcast("PROJECT_STATE", silverdaw::buildProjectStateEnvelope(session, projectState, true));
}

void handleProjectLoad(const juce::var& payload, silverdaw::AudioEngine& engine,
                       silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                       silverdaw::ProjectSession& session, juce::ThreadPool& peakPool,
                       const silverdaw::DecodedCache& decodedCache)
{
    const juce::String filePath = tryGetRequiredString(payload, "filePath").value_or(juce::String{});
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
    const auto previousClipIds = silverdaw::collectClipIds(projectState);

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
    silverdaw::rebuildEngineFromProject(engine, projectState, peakPool, decodedCache);
    // Restore the persisted playhead position so the user reopens the
    // project at the same point they left it. `engine.stop()` reset to
    // 0 above; this puts us back where the project file says.
    const double persistedPlayhead = projectState.getPlayheadMs();
    if (persistedPlayhead > 0.0)
    {
        engine.setPositionMs(persistedPlayhead);
    }
    // Block-prime the read-ahead buffers at the restored playhead so the
    // first "press play" after a load is instant — never an audible gap
    // while the background reader catches up at a non-zero position.
    engine.primeTracksForPlayback(silverdaw::kLoadPrimeBudgetMs);
    session.currentPath = filePath;

    bridge.broadcast("PROJECT_STATE", silverdaw::buildProjectStateEnvelope(session, projectState, true));
    silverdaw::log::info("project", "PROJECT_LOAD ok path=" + filePath);
}

void handleProjectSave(const juce::var& payload, silverdaw::AudioEngine& engine,
                       silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                       silverdaw::ProjectSession& session, bool isSaveAs)
{
    juce::String filePath = tryGetRequiredString(payload, "filePath").value_or(juce::String{});
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

    const auto scrollX = tryGetNumber(payload, "viewScrollX");
    if (scrollX.has_value())
    {
        projectState.setViewScrollX(juce::jmax(0.0, *scrollX));
    }

    // Capture the engine's current playhead position into the project
    // tree just before serialisation so the saved file remembers where
    // the user was. Suppressed from dirty-tracking inside `setPlayheadMs`
    // — capturing this value is a save-side concern, not a user edit.
    projectState.setPlayheadMs(engine.getPositionMs());

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
        // If the project still has its default name (Untitled), fold
        // the file basename in so the title bar reflects the chosen
        // filename. Once the user has explicitly renamed the project
        // to anything else we leave their choice alone — Save / Save
        // As should never silently overwrite a user-chosen name.
        if (projectState.getName() == silverdaw::ProjectState::kDefaultName)
        {
            const auto stem = juce::File(filePath).getFileNameWithoutExtension();
            if (stem.isNotEmpty())
            {
                projectState.setName(stem);
            }
        }
        // A successful save makes the in-memory state match disk; clear
        // dirty. `markClean` fires a PROJECT_DIRTY(false) transition.
        projectState.markClean();
    }
    bridge.broadcast("PROJECT_SAVED", juce::var(p));
    silverdaw::log::info("project",
                         juce::String("PROJECT_SAVE ") + (isSaveAs ? "(as) " : "") +
                             (result.wasOk() ? "ok" : "fail: " + result.getErrorMessage()) + " path=" + filePath);
    if (result.wasOk() && isSaveAs)
    {
        // Push the updated project state so the renderer picks up the
        // new filePath + name without waiting on a rename ack.
        bridge.broadcast("PROJECT_STATE", silverdaw::buildProjectStateEnvelope(session, projectState, false));
    }
}

void handleProjectSaveViewState(const juce::var& payload, silverdaw::AudioEngine& engine,
                                silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                                const silverdaw::ProjectSession& session)
{
    juce::String filePath = tryGetRequiredString(payload, "filePath").value_or(juce::String{});
    if (filePath.isEmpty())
    {
        filePath = session.currentPath;
    }

    auto* p = new juce::DynamicObject();
    p->setProperty("filePath", filePath);
    if (filePath.isEmpty())
    {
        p->setProperty("ok", false);
        p->setProperty("error", juce::String("No project path for view-state save"));
        bridge.broadcast("PROJECT_VIEW_STATE_SAVED", juce::var(p));
        return;
    }

    const double scrollX = juce::jmax(0.0, tryGetNumber(payload, "viewScrollX").value_or(projectState.getViewScrollX()));
    const double playheadMs = juce::jmax(0.0, engine.getPositionMs());
    projectState.setViewScrollX(scrollX);
    projectState.setPlayheadMs(playheadMs);

    // Selection + panel state are kept current on the project tree via
    // PROJECT_SET_VIEW pushes, so the lightweight view-state save just
    // mirrors whatever is already there into the file.
    const juce::String selectedTrackId = projectState.getViewSelectedTrack();
    const bool fxPanelOpen = projectState.getViewFxPanelOpen();

    const auto result = silverdaw::ProjectFile::saveViewState(juce::File(filePath), scrollX, playheadMs,
                                                              selectedTrackId, fxPanelOpen);
    p->setProperty("ok", result.wasOk());
    if (!result.wasOk())
    {
        p->setProperty("error", result.getErrorMessage());
    }
    bridge.broadcast("PROJECT_VIEW_STATE_SAVED", juce::var(p));
    silverdaw::log::info("project",
                         juce::String("PROJECT_SAVE_VIEW_STATE ") +
                             (result.wasOk() ? "ok" : "fail: " + result.getErrorMessage()) + " path=" + filePath);
}

void handleProjectRename(const juce::var& payload, silverdaw::ProjectState& projectState,
                         silverdaw::BridgeServer& bridge)
{
    const juce::String name = tryGetRequiredString(payload, "name").value_or(juce::String{});
    projectState.setName(name);
    auto* p = new juce::DynamicObject();
    p->setProperty("name", projectState.getName());
    p->setProperty("ok", true);
    bridge.broadcast("PROJECT_RENAMED", juce::var(p));
}

// Background autosave: serialise the current ValueTree to `filePath`
// without touching `session.currentPath` or the dirty flag. Used by the
// renderer's autosave manager — autosave is deliberately invisible to
// the user-facing project lifecycle so an in-progress edit session is
// never silently "saved" against the wrong file or quietly marked
// clean. Playhead and scroll setters are dirty-suppressed (see
// `ProjectState::setPlayheadMs` / `setViewScrollX`) so capturing them
// here doesn't pollute the dirty bit.
void handleProjectAutosave(const juce::var& payload, silverdaw::AudioEngine& engine,
                           silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge)
{
    const juce::String filePath = tryGetRequiredString(payload, "filePath").value_or(juce::String{});
    auto* p = new juce::DynamicObject();
    p->setProperty("filePath", filePath);
    if (filePath.isEmpty())
    {
        p->setProperty("ok", false);
        p->setProperty("error", juce::String("Missing filePath"));
        bridge.broadcast("PROJECT_AUTOSAVED", juce::var(p));
        return;
    }

    // Capture playhead + scroll so a recovered autosave restores the
    // user where they actually were. Both setters are explicitly
    // dirty-suppressed so this does not turn into a feedback loop with
    // the autosave manager (which only runs while the project is
    // already dirty).
    const auto scrollX = tryGetNumber(payload, "viewScrollX");
    if (scrollX.has_value())
    {
        projectState.setViewScrollX(juce::jmax(0.0, *scrollX));
    }
    projectState.setPlayheadMs(juce::jmax(0.0, engine.getPositionMs()));

    const auto result = silverdaw::ProjectFile::save(juce::File(filePath), projectState);
    p->setProperty("ok", result.wasOk());
    if (!result.wasOk())
    {
        p->setProperty("error", result.getErrorMessage());
    }
    bridge.broadcast("PROJECT_AUTOSAVED", juce::var(p));
    silverdaw::log::debug("project",
                         juce::String("PROJECT_AUTOSAVE ") +
                             (result.wasOk() ? "ok" : "fail: " + result.getErrorMessage()) + " path=" + filePath);
}

// Crash-recovery load. Same restore pipeline as PROJECT_LOAD but
// `session.currentPath` is set to the *original* backing path (or left
// empty when the autosave was for an untitled project) so File > Save
// either overwrites the original or falls through to Save As. The
// project is marked dirty after the load so the user is clearly
// steered to a deliberate save (the autosave file should be a transient
// safety net, not a stand-in for the real project).
void handleProjectLoadRecovery(const juce::var& payload, silverdaw::AudioEngine& engine,
                               silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                               silverdaw::ProjectSession& session, juce::ThreadPool& peakPool,
                               const silverdaw::DecodedCache& decodedCache)
{
    const juce::String autosavePath = tryGetRequiredString(payload, "autosavePath").value_or(juce::String{});
    const juce::var originalVar = payload.getProperty("originalPath", juce::var());
    const juce::String originalPath = originalVar.isString() ? originalVar.toString() : juce::String();

    if (autosavePath.isEmpty())
    {
        auto* p = new juce::DynamicObject();
        p->setProperty("filePath", autosavePath);
        p->setProperty("error", juce::String("Missing autosavePath"));
        bridge.broadcast("PROJECT_LOAD_FAILED", juce::var(p));
        return;
    }

    const auto previousClipIds = silverdaw::collectClipIds(projectState);

    const auto result = silverdaw::ProjectFile::load(juce::File(autosavePath), projectState);
    if (!result.ok)
    {
        auto* p = new juce::DynamicObject();
        p->setProperty("filePath", autosavePath);
        p->setProperty("error", result.error);
        bridge.broadcast("PROJECT_LOAD_FAILED", juce::var(p));
        silverdaw::log::warn("project", "PROJECT_LOAD_RECOVERY failed: " + result.error);
        return;
    }

    engine.stop();
    for (const auto& id : previousClipIds)
    {
        engine.removeClip(id);
    }
    silverdaw::rebuildEngineFromProject(engine, projectState, peakPool, decodedCache);

    const double persistedPlayhead = projectState.getPlayheadMs();
    if (persistedPlayhead > 0.0)
    {
        engine.setPositionMs(persistedPlayhead);
    }
    // Block-prime the read-ahead buffers at the restored playhead so the
    // first "press play" after a recovery is instant (see PROJECT_LOAD).
    engine.primeTracksForPlayback(silverdaw::kLoadPrimeBudgetMs);

    // Aim the user's "current project" pointer at the original backing
    // path (or clear it for an untitled recovery). The autosave path
    // itself is never exposed as the user's working file.
    session.currentPath = originalPath;

    bridge.broadcast("PROJECT_STATE", silverdaw::buildProjectStateEnvelope(session, projectState, true));

    // Force dirty so the user is steered to save. `ProjectFile::load`
    // calls `markClean()` at the end of replaceTree, so we have to
    // re-dirty the project here rather than rely on the listener.
    projectState.markDirty();

    silverdaw::log::info("project",
                         juce::String("PROJECT_LOAD_RECOVERY ok autosavePath=") + autosavePath +
                             " originalPath=" + originalPath);
}

// ─── Undo / Redo plumbing ─────────────────────────────────────────────
//
// The backend's `juce::UndoManager` already collects every ValueTree
// mutation that goes through `&undoManager` (see ProjectState.cpp).
// Without explicit transaction boundaries every individual
// `setProperty` becomes its own undoable action — a 60Hz drag would
// produce hundreds of useless one-pixel undo steps. We call
// `beginNewTransaction(name)` at the start of every project-mutating
// dispatch so each bridge envelope is exactly one undo step, with a
// small coalescing window for streaming drags.

// Bridge envelope types whose handlers actually mutate
// `setProperty(..., &undoManager)`-tracked state.
bool isUndoableEnvelopeType(const juce::String& type) noexcept
{
    return type == "CLIP_ADD" || type == "CLIP_MOVE" || type == "CLIP_TRIM" || type == "CLIP_COLOR" ||
           type == "CLIP_SET_LOCKED" ||
           type == "CLIP_REMOVE" || type == "CLIP_RENAME" || type == "CLIP_REBIND" ||
           type == "CLIP_SET_WARP" ||
           type == "CLIP_RELINK" ||
           type == "TRACK_ADD" || type == "TRACK_REMOVE" || type == "TRACK_RENAME" ||
           type == "TRACK_GAIN" || type == "TRACK_MUTE" || type == "TRACK_SOLO" ||
           type == "TRACK_SET_HEIGHT" || type == "TRACK_REORDER" ||
           type == "TRACK_SET_SENDS" || type == "TRACK_SET_TONE" || type == "TRACK_SET_LEVELER" ||
           type == "TRACK_SET_PAN" ||
           type == "CLIP_SET_ENVELOPE" ||
           type == "PROJECT_SET_REVERB" || type == "PROJECT_SET_DELAY" ||
           type == "LIBRARY_ADD" || type == "LIBRARY_REMOVE" ||
           type == "LIBRARY_REANALYSE" || type == "LIBRARY_ITEM_RELINK" ||
           type == "LIBRARY_ITEM_SET_SAMPLE_MODE" ||
           type == "PROJECT_RENAME" || type == "PROJECT_SET_BPM" || type == "PROJECT_SET_LENGTH" ||
           type == "PROJECT_SET_AUDIO_OUTPUT" ||
           type == "PROJECT_SET_TARGET_SAMPLE_RATE" ||
           type == "PROJECT_SET_MASTER_VOLUME" ||
           type == "PROJECT_MARKER_ADD" || type == "PROJECT_MARKER_MOVE" ||
           type == "PROJECT_MARKER_REMOVE" ||
           type == "TRANSITION_CREATE" || type == "TRANSITION_DELETE" ||
           type == "TRANSITION_SET_RECIPE";
}

juce::String prettyTransactionName(const juce::String& type)
{
    if (type == "CLIP_ADD") return "Add clip";
    if (type == "CLIP_MOVE") return "Move clip";
    if (type == "CLIP_TRIM") return "Trim clip";
    if (type == "CLIP_COLOR") return "Recolour clip";
    if (type == "CLIP_SET_LOCKED") return "Toggle clip lock";
    if (type == "CLIP_REMOVE") return "Delete clip";
    if (type == "CLIP_RENAME") return "Rename clip";
    if (type == "CLIP_REBIND") return "Save clip to library";
    if (type == "CLIP_SET_WARP") return "Change warp";
    if (type == "CLIP_RELINK") return "Relink clip";
    if (type == "TRACK_ADD") return "Add track";
    if (type == "TRACK_REMOVE") return "Remove track";
    if (type == "TRACK_RENAME") return "Rename track";
    if (type == "TRACK_GAIN") return "Change track gain";
    if (type == "TRACK_MUTE") return "Mute track";
    if (type == "TRACK_SOLO") return "Solo track";
    if (type == "TRACK_SET_HEIGHT") return "Resize track";
    if (type == "TRACK_REORDER") return "Reorder track";
    if (type == "TRACK_SET_SENDS") return "Change track reverb/delay";
    if (type == "TRACK_SET_TONE") return "Change track tone";
    if (type == "TRACK_SET_LEVELER") return "Change track leveler";
    if (type == "TRACK_SET_PAN") return "Change track pan";
    if (type == "CLIP_SET_ENVELOPE") return "Edit clip volume envelope";
    if (type == "PROJECT_SET_REVERB") return "Change reverb";
    if (type == "PROJECT_SET_DELAY") return "Change delay";
    if (type == "LIBRARY_ADD") return "Update library item";
    if (type == "LIBRARY_REMOVE") return "Remove library item";
    if (type == "LIBRARY_REANALYSE") return "Reanalyse library item";
    if (type == "LIBRARY_ITEM_RELINK") return "Relink library item";
    if (type == "LIBRARY_ITEM_SET_SAMPLE_MODE") return "Change library item classification";
    if (type == "PROJECT_RENAME") return "Rename project";
    if (type == "PROJECT_SET_BPM") return "Change tempo";
    if (type == "PROJECT_SET_LENGTH") return "Change project length";
    if (type == "PROJECT_SET_AUDIO_OUTPUT") return "Change audio output";
    if (type == "PROJECT_SET_TARGET_SAMPLE_RATE") return "Change project sample rate";
    if (type == "PROJECT_SET_MASTER_VOLUME") return "Change master volume";
    if (type == "PROJECT_MARKER_ADD") return "Add marker";
    if (type == "PROJECT_MARKER_MOVE") return "Move marker";
    if (type == "PROJECT_MARKER_REMOVE") return "Remove marker";
    if (type == "TRANSITION_CREATE") return "Add transition";
    if (type == "TRANSITION_DELETE") return "Remove transition";
    if (type == "TRANSITION_SET_RECIPE") return "Change transition";
    return type;
}

// File-scope coalescing state. Dispatch always runs on the JUCE message
// thread so no synchronisation is needed.
//
// Two coalescing modes are supported:
//   1. **Time-window mode** (legacy): same `(type, idPart)` within
//      `kUndoCoalesceWindowMs` reuses the open transaction. This is what
//      the existing CLIP_MOVE / CLIP_TRIM / TRACK_GAIN / slider drag
//      paths rely on and the new fader paths fall back to when the
//      renderer doesn't mint a gestureId.
//   2. **Explicit-gesture mode** (Phase 5): when the envelope carries a
//      `gestureId` string, coalescing keys on `(type, idPart, gestureId)`
//      regardless of elapsed time. The terminal event of a gesture sets
//      `gestureEnd: true` — that event still folds into the open
//      transaction; the coalesce state is cleared AFTER it lands so the
//      next gesture opens a fresh undo step.
struct UndoCoalesceState
{
    juce::String lastKey;
    juce::int64 lastTimeMs = 0;
    bool gestureActive = false;
};

static UndoCoalesceState& undoCoalesceState()
{
    static UndoCoalesceState state;
    return state;
}

void resetUndoCoalesceState() noexcept
{
    auto& s = undoCoalesceState();
    s.lastKey = {};
    s.lastTimeMs = 0;
    s.gestureActive = false;
}

// 60Hz drag streams (CLIP_MOVE / CLIP_TRIM / TRACK_GAIN) coalesce
// same-target events within this window into a single undo step. Other
// mutating envelopes get a fresh transaction every time.
constexpr juce::int64 kUndoCoalesceWindowMs = 500;

void beginUndoTransactionIfNeeded(const juce::String& type, const juce::var& payload,
                                  silverdaw::ProjectState& projectState)
{
    if (!isUndoableEnvelopeType(type)) return;

    juce::String idPart;
    if (type == "CLIP_MOVE" || type == "CLIP_TRIM" || type == "CLIP_SET_WARP" ||
        type == "CLIP_SET_ENVELOPE")
    {
        idPart = payload.getProperty("clipId", "").toString();
    }
    else if (type == "TRACK_GAIN" || type == "TRACK_SET_SENDS" ||
             type == "TRACK_SET_TONE" || type == "TRACK_SET_LEVELER" ||
             type == "TRACK_SET_PAN")
    {
        idPart = payload.getProperty("trackId", "").toString();
    }
    else if (type == "PROJECT_SET_MASTER_VOLUME" ||
             type == "PROJECT_SET_REVERB" || type == "PROJECT_SET_DELAY")
    {
        // Singleton project-level edit — slider drag coalesces.
        idPart = "_";
    }
    else if (type == "PROJECT_MARKER_MOVE")
    {
        idPart = payload.getProperty("markerId", "").toString();
    }
    else if (type == "PROJECT_SET_BPM" || type == "PROJECT_SET_LENGTH" || type == "PROJECT_RENAME")
    {
        // Singleton project-level edits coalesce against themselves
        // — typing in the BPM / length / name field commits per
        // keystroke, but we want one undo step per "edit session".
        idPart = "_";
    }

    const auto gestureId = payload.getProperty("gestureId", "").toString();

    juce::String key = type;
    if (idPart.isNotEmpty()) key << ":" << idPart;
    if (gestureId.isNotEmpty()) key << "#" << gestureId;

    const auto now = juce::Time::currentTimeMillis();
    auto& s = undoCoalesceState();

    // Explicit-gesture coalesce ignores the time window entirely. The
    // renderer's pointerdown/pointermove/pointerup loop drives the same
    // `gestureId` for every sample so even a paused-mid-drag stream
    // stays in the same undo step.
    const bool gestureCoalesce =
        gestureId.isNotEmpty() && s.gestureActive && key == s.lastKey;

    const bool timeCoalesce =
        gestureId.isEmpty() && idPart.isNotEmpty() && key == s.lastKey &&
        (now - s.lastTimeMs) < kUndoCoalesceWindowMs;

    if (!gestureCoalesce && !timeCoalesce)
    {
        projectState.getUndoManager().beginNewTransaction(prettyTransactionName(type));
    }
    s.lastKey = key;
    s.lastTimeMs = now;
    s.gestureActive = gestureId.isNotEmpty();
}

// Companion to `beginUndoTransactionIfNeeded`. Called by the dispatcher
// AFTER the handler runs so that the terminal `gestureEnd: true` event
// folds into the open transaction (it was just applied above) and only
// THEN clears the coalesce state. Without this, a same-gesture follow-up
// sample arriving after `gestureEnd` would silently start a new undo
// step.
void endUndoTransactionIfNeeded(const juce::String& type, const juce::var& payload) noexcept
{
    if (!isUndoableEnvelopeType(type)) return;
    const auto gestureId = payload.getProperty("gestureId", "").toString();
    if (gestureId.isEmpty()) return;
    const bool gestureEnd = static_cast<bool>(payload.getProperty("gestureEnd", false));
    if (!gestureEnd) return;
    auto& s = undoCoalesceState();
    s.lastKey = {};
    s.lastTimeMs = 0;
    s.gestureActive = false;
}

void handleEditUndo(silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                    silverdaw::BridgeServer& bridge, silverdaw::ProjectSession& session,
                    juce::ThreadPool& peakPool, const silverdaw::DecodedCache& decodedCache)
{
    auto& um = projectState.getUndoManager();
    // Flush any in-flight coalesced transaction so this undo step is
    // a clean unit.
    um.beginNewTransaction();
    resetUndoCoalesceState();
    if (!um.canUndo())
    {
        silverdaw::log::debug("project", "EDIT_UNDO ignored (nothing to undo)");
        return;
    }

    // Capture engine playhead so the user doesn't get teleported to 0
    // by the rebuild's `engine.stop()`. View state (zoom, scroll) is
    // outside the undo stack so it survives naturally.
    const double playheadMs = engine.getPositionMs();
    const auto preIds = silverdaw::collectClipIds(projectState);

    engine.stop();
    um.undo();
    for (const auto& id : preIds) engine.removeClip(id);
    silverdaw::rebuildEngineFromProject(engine, projectState, peakPool, decodedCache);
    engine.setPositionMs(playheadMs);

    bridge.broadcast("PROJECT_STATE", silverdaw::buildSoftReplaceProjectStateEnvelope(session, projectState));

    // The dirty listener only fires on transitions. Force-broadcast the
    // current dirty state so the renderer's title-bar indicator picks up
    // the "still dirty after undo" case.
    {
        auto* p = new juce::DynamicObject();
        p->setProperty("dirty", projectState.isDirty());
        bridge.broadcast("PROJECT_DIRTY", juce::var(p));
    }

    silverdaw::log::info("project", "EDIT_UNDO ok");
}

void handleEditRedo(silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                    silverdaw::BridgeServer& bridge, silverdaw::ProjectSession& session,
                    juce::ThreadPool& peakPool, const silverdaw::DecodedCache& decodedCache)
{
    auto& um = projectState.getUndoManager();
    um.beginNewTransaction();
    resetUndoCoalesceState();
    if (!um.canRedo())
    {
        silverdaw::log::debug("project", "EDIT_REDO ignored (nothing to redo)");
        return;
    }

    const double playheadMs = engine.getPositionMs();
    const auto preIds = silverdaw::collectClipIds(projectState);

    engine.stop();
    um.redo();
    for (const auto& id : preIds) engine.removeClip(id);
    silverdaw::rebuildEngineFromProject(engine, projectState, peakPool, decodedCache);
    engine.setPositionMs(playheadMs);

    bridge.broadcast("PROJECT_STATE", silverdaw::buildSoftReplaceProjectStateEnvelope(session, projectState));
    {
        auto* p = new juce::DynamicObject();
        p->setProperty("dirty", projectState.isDirty());
        bridge.broadcast("PROJECT_DIRTY", juce::var(p));
    }

    silverdaw::log::info("project", "EDIT_REDO ok");
}

// ─── §12.1 clip-transition dispatch helpers ───────────────────────────────
//
// Shared epilogue for the discrete TRANSITION_* edits: re-derive every clip's
// edge-fade, drop any transition the edit invalidated (folding into the same
// open undo step), then rebroadcast the authoritative PROJECT_STATE. The
// renderer has no bespoke ack — the snapshot IS the ack — so we always
// rebroadcast, even when the mutation was rejected, to re-sync the client.
void finishTransitionEdit(silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                          silverdaw::BridgeServer& bridge, silverdaw::ProjectSession& session)
{
    projectState.reconcileTransitions(/*useUndo*/ true);
    silverdaw::syncClipEdgeFades(engine, projectState);
    bridge.broadcast("PROJECT_STATE", silverdaw::buildProjectStateEnvelope(session, projectState, false));
}

// Geometry edits that can move / resize a clip (or change its warp-scaled
// footprint) and therefore break a transition's sanctioned overlap. Undo /
// redo / load go through rebuildEngineFromProject (which reconciles + syncs
// separately), so they are intentionally excluded here.
bool transitionGeometryMayHaveChanged(const juce::String& type) noexcept
{
    return type == "CLIP_MOVE" || type == "CLIP_TRIM" || type == "CLIP_REMOVE" ||
           type == "CLIP_SET_WARP" || type == "TRACK_REMOVE" || type == "PROJECT_SET_BPM" ||
           type == "CLIP_RELINK";
}

// Re-derive edge-fades after a geometry edit and auto-delete any transition
// whose invariants broke. Gated on the project actually carrying a transition
// so a transition-free project keeps a byte-for-byte unchanged hot path (the
// dormancy invariant). Only rebroadcasts PROJECT_STATE when a transition was
// removed (a rare terminal event), so a 60 Hz move/trim drag does not spam
// full snapshots.
void reconcileTransitionsAfterGeometryEdit(silverdaw::AudioEngine& engine,
                                           silverdaw::ProjectState& projectState,
                                           silverdaw::BridgeServer& bridge, silverdaw::ProjectSession& session)
{
    if (!projectState.hasAnyTransition()) return;
    const bool removed = projectState.reconcileTransitions(/*useUndo*/ true);
    silverdaw::syncClipEdgeFades(engine, projectState);
    if (removed)
    {
        bridge.broadcast("PROJECT_STATE", silverdaw::buildProjectStateEnvelope(session, projectState, false));
    }
}

// Same wire-protocol convention as BridgeServer::broadcast: (type, payload) order is
// fixed by design, so the easily-swappable-parameters check is intentionally silenced.
// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
void dispatchBridgeMessage(const juce::String& type, const juce::var& payload, silverdaw::AudioEngine& engine,
                           silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                           juce::ThreadPool& peakPool, const silverdaw::PeaksCache& cache,
                           const silverdaw::DecodedCache& decodedCache, silverdaw::ProjectSession& session)
{
    // Liveness fast-path. PING is answered on the message thread so a
    // round-trip proves the engine command thread itself is responsive,
    // not merely that the socket is open. It mutates nothing, so it
    // bypasses the undo prologue/epilogue entirely.
    if (type == "PING")
    {
        auto* p = new juce::DynamicObject();
        p->setProperty("id", payload.getProperty("id", 0));
        bridge.broadcast("PONG", juce::var(p));
        return;
    }

    // Undo-transaction prologue. Each project-mutating envelope is wrapped
    // in its own UndoManager transaction so Ctrl+Z reverts one logical
    // edit. Drag streams (CLIP_MOVE / CLIP_TRIM / TRACK_GAIN) coalesce
    // same-target events within a 500 ms window so a 60 Hz drag is one
    // undo step.
    beginUndoTransactionIfNeeded(type, payload, projectState);
    if (type == "CLIP_ADD")
    {
        silverdaw::log::info("bridge", "recv CLIP_ADD trackId=" + payload.getProperty("trackId", "").toString() +
                                           " clipId=" + payload.getProperty("clipId", "").toString());
        silverdaw::handleClipAdd(payload, engine, projectState, bridge, peakPool, cache, decodedCache);
    }
    else if (type == "CLIP_MOVE")
    {
        silverdaw::log::debug("bridge", "recv CLIP_MOVE clipId=" + payload.getProperty("clipId", "").toString() +
                                            " pos=" + payload.getProperty("positionMs", "").toString());
        silverdaw::handleClipMove(payload, engine, projectState);
    }
    else if (type == "CLIP_TRIM")
    {
        silverdaw::log::debug("bridge", "recv CLIP_TRIM clipId=" + payload.getProperty("clipId", "").toString() +
                                            " start=" + payload.getProperty("startMs", "").toString() +
                                            " in=" + payload.getProperty("inMs", "").toString() +
                                            " dur=" + payload.getProperty("durationMs", "").toString());
        silverdaw::handleClipTrim(payload, engine, projectState);
    }
    else if (type == "CLIP_COLOR")
    {
        silverdaw::log::debug("bridge", "recv CLIP_COLOR clipId=" + payload.getProperty("clipId", "").toString() +
                                            " idx=" + payload.getProperty("colorIndex", "").toString());
        silverdaw::handleClipColor(payload, projectState);
    }
    else if (type == "CLIP_SET_LOCKED")
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
    else if (type == "CLIP_REMOVE")
    {
        silverdaw::log::info("bridge", "recv CLIP_REMOVE clipId=" + payload.getProperty("clipId", "").toString());
        silverdaw::handleClipRemove(payload, engine, projectState, bridge);
    }
    else if (type == "LIBRARY_ITEM_RELINK")
    {
        silverdaw::log::info("bridge", "recv LIBRARY_ITEM_RELINK itemId=" + payload.getProperty("itemId", "").toString() +
                                            " path=" + payload.getProperty("filePath", "").toString());
        handleLibraryItemRelink(payload, engine, projectState, bridge, session, peakPool, decodedCache);
    }
    else if (type == "CLIP_RENAME")
    {
        const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
        const juce::String name = tryGetRequiredString(payload, "name").value_or(juce::String{});
        silverdaw::log::info("bridge", "recv CLIP_RENAME clipId=" + clipId + " name=" + name);
        projectState.setClipName(clipId, name);
    }
    else if (type == "CLIP_REBIND")
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
    else if (type == "CLIP_SET_WARP")
    {
        const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
        silverdaw::log::info("bridge", "recv CLIP_SET_WARP clipId=" + clipId);
        if (clipId.isNotEmpty())
        {
            std::optional<bool> warpEnabled;
            if (payload.hasProperty("warpEnabled"))
                warpEnabled = static_cast<bool>(payload.getProperty("warpEnabled", false));
            std::optional<juce::String> warpMode;
            if (payload.hasProperty("warpMode"))
                warpMode = tryGetRequiredString(payload, "warpMode").value_or(juce::String{});
            // `tempoRatio: null` clears the override (clip reverts to
            // project-BPM tracking); a finite number pins the ratio.
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
            // If the renderer enabled warp WITHOUT pinning a ratio
            // ("follow project BPM"), derive the effective ratio from
            // project / source BPM right here so the engine's lazily-
            // built WarpProcessor doesn't end up at its default 1.0
            // and play unwarped. Mirrors the derivation in
            // `rebuildEngineFromProject` so freshly-warped clips and
            // freshly-loaded warped clips end up identical.
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
            // Fan the same change out to the audio engine so the next
            // audio block reflects it. The engine owns the per-clip
            // WarpProcessor lifetime; it builds one lazily when
            // warp is first enabled and tears it down when disabled.
            engine.setClipWarp(clipId, warpEnabled, warpMode, effectiveRatio, semitones, cents);
            auto appliedPayload = silverdaw::buildClipWarpAppliedPayload(projectState, clipId);
            bridge.broadcast("CLIP_WARP_APPLIED", juce::var(appliedPayload.release()));
        }
    }
    else if (type == "CLIP_SAVE_AS_SAMPLE")
    {
        silverdaw::handleClipSaveAsSample(payload, engine, projectState, bridge, peakPool, cache);
    }
    else if (type == "LIBRARY_ITEM_SAVE_AS_SAMPLE")
    {
        silverdaw::handleLibraryItemSaveAsSample(payload, engine, projectState, bridge, peakPool, cache);
    }
    else if (type == "LIBRARY_ADD")
    {
        silverdaw::handleLibraryAdd(payload, engine, projectState, bridge, peakPool, decodedCache);
    }
    else if (type == "LIBRARY_REMOVE")
    {
        silverdaw::handleLibraryRemove(payload, projectState);
    }
    else if (type == "LIBRARY_REANALYSE")
    {
        silverdaw::handleLibraryReanalyse(payload, engine, projectState, bridge, peakPool, decodedCache);
    }
    else if (type == "LIBRARY_ITEM_SET_SAMPLE_MODE")
    {
        silverdaw::handleLibraryItemSetSampleMode(payload, projectState);
    }
    else if (type == "TRANSPORT_PLAY")
    {
        silverdaw::handleTransportPlay(engine, g_mixdownBusy.load());
    }
    else if (type == "TRANSPORT_PAUSE")
    {
        silverdaw::handleTransportPause(engine);
    }
    else if (type == "TRANSPORT_STOP")
    {
        silverdaw::handleTransportStop(engine, projectState);
    }
    else if (type == "TRANSPORT_SEEK")
    {
        silverdaw::handleTransportSeek(payload, engine, projectState);
    }
    else if (type == "PREVIEW_LOAD")
    {
        silverdaw::handlePreviewLoad(payload, engine, projectState, bridge, decodedCache);
    }
    else if (type == "PREVIEW_UNLOAD")
    {
        silverdaw::handlePreviewUnload(engine, bridge);
    }
    else if (type == "PREVIEW_PLAY")
    {
        silverdaw::handlePreviewPlay(engine, bridge);
    }
    else if (type == "PREVIEW_PAUSE")
    {
        silverdaw::handlePreviewPause(engine, bridge);
    }
    else if (type == "PREVIEW_STOP")
    {
        silverdaw::handlePreviewStop(engine, bridge);
    }
    else if (type == "PREVIEW_SEEK")
    {
        silverdaw::handlePreviewSeek(payload, engine);
    }
    else if (type == "PREVIEW_SET_WARP")
    {
        silverdaw::handlePreviewSetWarp(payload, engine);
    }
    else if (type == "PREVIEW_SET_ENVELOPE")
    {
        silverdaw::handlePreviewSetEnvelope(payload, engine);
    }
    else if (type == "TRACK_ADD")
    {
        silverdaw::log::info("bridge", "recv TRACK_ADD trackId=" + payload.getProperty("trackId", "").toString());
        silverdaw::handleTrackAdd(payload, projectState, bridge);
    }
    else if (type == "TRACK_REMOVE")
    {
        silverdaw::log::info("bridge", "recv TRACK_REMOVE trackId=" + payload.getProperty("trackId", "").toString());
        silverdaw::handleTrackRemove(payload, engine, projectState, bridge);
    }
    else if (type == "TRACK_RENAME")
    {
        silverdaw::log::info("bridge", "recv TRACK_RENAME trackId=" + payload.getProperty("trackId", "").toString());
        silverdaw::handleTrackRename(payload, projectState);
    }
    else if (type == "TRACK_GAIN")
    {
        silverdaw::log::debug("bridge", "recv TRACK_GAIN trackId=" + payload.getProperty("trackId", "").toString() +
                                            " gain=" + payload.getProperty("gain", "").toString());
        silverdaw::handleTrackGain(payload, engine, projectState, bridge);
    }
    else if (type == "TRACK_MUTE")
    {
        silverdaw::log::info("bridge", "recv TRACK_MUTE trackId=" + payload.getProperty("trackId", "").toString() +
                                            " muted=" + payload.getProperty("muted", "").toString());
        silverdaw::handleTrackMute(payload, engine, projectState, bridge);
    }
    else if (type == "TRACK_SOLO")
    {
        silverdaw::log::info("bridge", "recv TRACK_SOLO trackId=" + payload.getProperty("trackId", "").toString() +
                                            " soloed=" + payload.getProperty("soloed", "").toString());
        silverdaw::handleTrackSolo(payload, engine, projectState, bridge);
    }
    else if (type == "TRACK_SET_HEIGHT")
    {
        const auto trackId = tryGetRequiredString(payload, "trackId").value_or(juce::String{});
        const auto heightVar = tryGetNumber(payload, "heightPx");
        silverdaw::log::debug("bridge", "recv TRACK_SET_HEIGHT trackId=" + trackId +
                                            " heightPx=" + payload.getProperty("heightPx", "").toString());
        if (trackId.isNotEmpty() && heightVar.has_value())
        {
            projectState.setTrackHeightPx(trackId, *heightVar);
        }
    }
    else if (type == "TRACK_REORDER")
    {
        const auto trackId = tryGetRequiredString(payload, "trackId").value_or(juce::String{});
        const auto idxVar = tryGetNumber(payload, "newIndex");
        silverdaw::log::info("bridge", "recv TRACK_REORDER trackId=" + trackId +
                                           " newIndex=" + payload.getProperty("newIndex", "").toString());
        if (trackId.isNotEmpty() && idxVar.has_value())
        {
            projectState.moveTrack(trackId, static_cast<int>(*idxVar));
        }
    }
    else if (type == "TRACK_SET_SENDS")
    {
        silverdaw::log::debug("bridge",
                              "recv TRACK_SET_SENDS trackId=" +
                                  payload.getProperty("trackId", "").toString() +
                                  " rev=" + payload.getProperty("reverbSend", "").toString() +
                                  " dly=" + payload.getProperty("delaySend", "").toString());
        silverdaw::handleTrackSetSends(payload, engine, projectState, bridge);
    }
    else if (type == "TRACK_SET_TONE")
    {
        silverdaw::log::debug("bridge", "recv TRACK_SET_TONE trackId=" +
                                            payload.getProperty("trackId", "").toString());
        silverdaw::handleTrackSetTone(payload, engine, projectState, bridge);
    }
    else if (type == "TRACK_SET_LEVELER")
    {
        silverdaw::log::debug("bridge", "recv TRACK_SET_LEVELER trackId=" +
                                            payload.getProperty("trackId", "").toString() +
                                            " amount=" + payload.getProperty("amount", "").toString());
        silverdaw::handleTrackSetLeveler(payload, engine, projectState, bridge);
    }
    else if (type == "TRACK_SET_PAN")
    {
        silverdaw::log::debug("bridge", "recv TRACK_SET_PAN trackId=" +
                                            payload.getProperty("trackId", "").toString() +
                                            " pan=" + payload.getProperty("pan", "").toString());
        silverdaw::handleTrackSetPan(payload, engine, projectState, bridge);
    }
    else if (type == "CLIP_SET_ENVELOPE")
    {
        silverdaw::log::debug("bridge", "recv CLIP_SET_ENVELOPE clipId=" +
                                            payload.getProperty("clipId", "").toString());
        silverdaw::handleClipSetEnvelope(payload, engine, projectState, bridge);
    }
    else if (type == "PROJECT_SET_REVERB")
    {
        silverdaw::log::debug("bridge", "recv PROJECT_SET_REVERB");
        silverdaw::handleProjectSetReverb(payload, engine, projectState, bridge);
    }
    else if (type == "PROJECT_SET_DELAY")
    {
        silverdaw::log::debug("bridge", "recv PROJECT_SET_DELAY");
        silverdaw::handleProjectSetDelay(payload, engine, projectState, bridge);
    }
    else if (type == "WAVEFORM_REQUEST")
    {
        silverdaw::log::debug("bridge", "recv WAVEFORM_REQUEST clipId=" + payload.getProperty("clipId", "").toString());
        silverdaw::handleWaveformRequest(payload, engine, projectState, bridge, peakPool, cache);
    }
    else if (type == "CLIP_EDITOR_PEAKS_REQUEST")
    {
        silverdaw::log::debug("bridge",
                              "recv CLIP_EDITOR_PEAKS_REQUEST libId=" +
                                  payload.getProperty("libraryItemId", "").toString() +
                                  " ppS=" + payload.getProperty("peaksPerSecond", "").toString());
        silverdaw::handleClipEditorPeaksRequest(payload, engine, projectState, bridge, peakPool, cache);
    }
    else if (type == "PROJECT_NEW")
    {
        silverdaw::log::info("bridge", "recv PROJECT_NEW");
        handleProjectNew(engine, projectState, bridge, session);
    }
    else if (type == "PROJECT_SAVE")
    {
        silverdaw::log::info("bridge", "recv PROJECT_SAVE");
        handleProjectSave(payload, engine, projectState, bridge, session, /*isSaveAs*/ false);
    }
    else if (type == "PROJECT_SAVE_AS")
    {
        silverdaw::log::info("bridge", "recv PROJECT_SAVE_AS path=" + payload.getProperty("filePath", "").toString());
        handleProjectSave(payload, engine, projectState, bridge, session, /*isSaveAs*/ true);
    }
    else if (type == "PROJECT_SAVE_VIEW_STATE")
    {
        silverdaw::log::info("bridge", "recv PROJECT_SAVE_VIEW_STATE");
        handleProjectSaveViewState(payload, engine, projectState, bridge, session);
    }
    else if (type == "PROJECT_LOAD")
    {
        silverdaw::log::info("bridge", "recv PROJECT_LOAD path=" + payload.getProperty("filePath", "").toString());
        handleProjectLoad(payload, engine, projectState, bridge, session, peakPool, decodedCache);
    }
    else if (type == "PROJECT_LOAD_RECOVERY")
    {
        silverdaw::log::info("bridge", "recv PROJECT_LOAD_RECOVERY autosavePath=" +
                                           payload.getProperty("autosavePath", "").toString());
        handleProjectLoadRecovery(payload, engine, projectState, bridge, session, peakPool, decodedCache);
    }
    else if (type == "PROJECT_AUTOSAVE")
    {
        silverdaw::log::debug("bridge", "recv PROJECT_AUTOSAVE path=" +
                                            payload.getProperty("filePath", "").toString());
        handleProjectAutosave(payload, engine, projectState, bridge);
    }
    else if (type == "PROJECT_RENAME")
    {
        silverdaw::log::info("bridge", "recv PROJECT_RENAME name=" + payload.getProperty("name", "").toString());
        handleProjectRename(payload, projectState, bridge);
    }
    else if (type == "PROJECT_SET_VIEW")
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
    else if (type == "PROJECT_SET_BPM")
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
    else if (type == "PROJECT_SET_LENGTH")
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
    else if (type == "PROJECT_SET_AUDIO_OUTPUT")
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
    else if (type == "PROJECT_SET_TARGET_SAMPLE_RATE")
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
    else if (type == "PROJECT_SET_EXPORT_SETTINGS")
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
    else if (type == "PROJECT_SET_MASTER_VOLUME")
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
    else if (type == "PROJECT_MARKER_ADD")
    {
        silverdaw::applyMarkerAdd(payload, projectState);
    }
    else if (type == "PROJECT_MARKER_MOVE")
    {
        silverdaw::applyMarkerMove(payload, projectState);
    }
    else if (type == "PROJECT_MARKER_REMOVE")
    {
        silverdaw::applyMarkerRemove(payload, projectState);
    }
    else if (type == "AUDIO_DEVICES_REQUEST")
    {
        silverdaw::log::debug("bridge", "recv AUDIO_DEVICES_REQUEST refresh=" +
                                            payload.getProperty("refresh", "false").toString());
        silverdaw::handleAudioDevicesRequest(payload, engine, bridge);
    }
    else if (type == "AUDIO_DEVICE_SELECT")
    {
        silverdaw::log::info("bridge", "recv AUDIO_DEVICE_SELECT type=" +
                                           payload.getProperty("typeName", "").toString() + " name=" +
                                           payload.getProperty("deviceName", "").toString());
        silverdaw::handleAudioDeviceSelect(payload, engine, bridge);
    }
    else if (type == "AUDIO_FILE_PROBE")
    {
        // Synchronous-ish file-rate probe used by the renderer's import
        // flow to decide whether to prompt about a sample-rate
        // mismatch. Opens the file via the existing AudioFormatManager,
        // reads the header (sample rate / channel count / total length),
        // acks via `AUDIO_FILE_PROBED`. `requestId` round-trips so
        // concurrent probes from a batched import don't collide.
        const auto requestId = tryGetRequiredString(payload, "requestId").value_or(juce::String{});
        const auto filePath = tryGetRequiredString(payload, "filePath").value_or(juce::String{});
        if (requestId.isEmpty() || filePath.isEmpty())
        {
            silverdaw::log::warn("bridge", "AUDIO_FILE_PROBE missing requestId/filePath");
        }
        else
        {
            silverdaw::log::debug("bridge", "recv AUDIO_FILE_PROBE id=" + requestId + " path=" + filePath);
            // Heavy work (reader construction; on Windows the JUCE
            // codec call can take a few ms for compressed formats) is
            // dispatched onto the existing peak-pool so the message
            // thread keeps draining 60 Hz transport ticks.
            peakPool.addJob([requestId, filePath, &engine, &bridge]() {
                const juce::File file(filePath);
                std::unique_ptr<juce::AudioFormatReader> reader(
                    engine.getFormatManager().createReaderFor(file));
                juce::MessageManager::callAsync([requestId, filePath, &bridge,
                                                 reader = std::shared_ptr<juce::AudioFormatReader>(std::move(reader))]() {
                    auto* obj = new juce::DynamicObject();
                    obj->setProperty("requestId", requestId);
                    obj->setProperty("filePath", filePath);
                    if (reader && reader->sampleRate > 0.0 && reader->lengthInSamples > 0)
                    {
                        obj->setProperty("ok", true);
                        obj->setProperty("sampleRate", static_cast<int>(reader->sampleRate));
                        obj->setProperty("channelCount", static_cast<int>(reader->numChannels));
                        obj->setProperty(
                            "durationMs",
                            (static_cast<double>(reader->lengthInSamples) / reader->sampleRate) * 1000.0);
                        silverdaw::log::info(
                            "bridge",
                            "probe ok id=" + requestId + " path=" + filePath
                                + " sampleRate=" + juce::String(static_cast<int>(reader->sampleRate))
                                + "Hz ch=" + juce::String(static_cast<int>(reader->numChannels))
                                + " lengthSamples=" + juce::String(reader->lengthInSamples));
                    }
                    else
                    {
                        obj->setProperty("ok", false);
                        obj->setProperty("error",
                                         juce::String("could not decode header for ") + filePath);
                        silverdaw::log::warn(
                            "bridge",
                            "probe fail id=" + requestId + " path=" + filePath
                                + " (reader=" + juce::String(reader ? "ok" : "null") + ")");
                    }
                    bridge.broadcast("AUDIO_FILE_PROBED", juce::var(obj));
                });
            });
        }
    }
    else if (type == "MIXDOWN_START")
    {
        // Render a project mixdown offline. Heavy work runs on the
        // peakPool; results stream back via MIXDOWN_PROGRESS /
        // MIXDOWN_DONE / MIXDOWN_FAILED. Idempotent under double-
        // click — if a render is already in flight, reject the new
        // request with an `invalid` failure rather than starting a
        // second one.
        if (g_mixdownBusy.load())
        {
            auto* obj = new juce::DynamicObject();
            obj->setProperty("code", juce::String("invalid"));
            obj->setProperty("error", juce::String("A mixdown is already in progress."));
            bridge.broadcast("MIXDOWN_FAILED", juce::var(obj));
            return;
        }
        // Stop transport (and don't fight an existing play state) so
        // the live audio device isn't producing sound during the
        // offline render. The TRANSPORT_PLAY gate above keeps it stopped.
        engine.pause();

        const auto outputPath = tryGetRequiredString(payload, "outputPath").value_or(juce::String{});
        const int outputSampleRate = static_cast<int>(payload.getProperty("sampleRate", 44100));
        const auto formatStr = tryGetRequiredString(payload, "format").value_or(juce::String("wav"));
        const auto lengthMode = tryGetRequiredString(payload, "lengthMode").value_or(juce::String("trim-to-last-clip"));
        const double lengthMsHint = static_cast<double>(payload.getProperty("lengthMs", 0.0));
        const int bitrateKbps = static_cast<int>(payload.getProperty("bitrateKbps", 192));
        // Phase A export fields. All optional with safe defaults so
        // older renderer builds keep working. Validated below before
        // we hand them to the engine.
        const int bitDepthRaw = static_cast<int>(payload.getProperty("bitDepth", 16));
        const double tailSecondsRaw = static_cast<double>(payload.getProperty("tailSeconds", 0.0));
        const bool ditherRaw = static_cast<bool>(payload.getProperty("dither", true));

        silverdaw::log::info(
            "mixdown",
            "MIXDOWN_START path=" + outputPath + " sr=" + juce::String(outputSampleRate) +
                " format=" + formatStr + " lengthMode=" + lengthMode +
                " lengthMsHint=" + juce::String(lengthMsHint, 1) +
                " bitDepth=" + juce::String(bitDepthRaw) +
                " tailSeconds=" + juce::String(tailSecondsRaw, 3) +
                " dither=" + (ditherRaw ? "true" : "false"));

        if (outputPath.isEmpty())
        {
            auto* obj = new juce::DynamicObject();
            obj->setProperty("code", juce::String("invalid"));
            obj->setProperty("error", juce::String("MIXDOWN_START requires outputPath."));
            bridge.broadcast("MIXDOWN_FAILED", juce::var(obj));
            return;
        }

        // Snapshot the project on the message thread before the
        // worker dispatches — see rubber-duck finding A.
        auto snapshot = silverdaw::snapshotProjectForMixdown(projectState);
        // Re-resolve each clip's source path through the SAME helper
        // the live engine uses for CLIP_ADD. Without this, mixdown
        // can open the original MP3/WMA for a clip whose stored
        // playbackFilePath is empty/stale while live plays the
        // decoded WAV cache — yielding selective warp failures and
        // amplitude drift when the two readers' sample rates or
        // padding/encoder-delay differ. See rubber-duck H2.
        for (auto& trackSnap : snapshot.tracks)
        {
            for (auto& clipSnap : trackSnap.clips)
            {
                const auto rawSourcePath =
                    projectState.getLibraryItemFilePath(clipSnap.libraryItemId);
                const auto resolvedPath =
                    silverdaw::resolveEnginePlaybackPath(rawSourcePath, projectState, decodedCache);
                const auto previousPath = clipSnap.filePath;
                if (resolvedPath.isNotEmpty()) clipSnap.filePath = resolvedPath;
                silverdaw::log::info(
                    "mixdown",
                    "snapshot path resolve clip=" + clipSnap.id +
                        " libraryItemId=" + clipSnap.libraryItemId +
                        " rawSource=" + rawSourcePath +
                        " storedPlayback=" + previousPath +
                        " resolved=" + clipSnap.filePath +
                        " changed=" +
                            (previousPath != clipSnap.filePath
                                 ? juce::String("true")
                                 : juce::String("false")));
            }
        }
        if (snapshot.tracks.empty())
        {
            auto* obj = new juce::DynamicObject();
            obj->setProperty("code", juce::String("invalid"));
            obj->setProperty("error", juce::String("Project has no clips to mix down."));
            bridge.broadcast("MIXDOWN_FAILED", juce::var(obj));
            return;
        }

        // Align mixdown's internal "project rate" with the live device
        // rate. The per-clip JUCE chain in MixdownEngine is identical to
        // live's (AudioFormatReaderSource → OffsetSource → AudioTransport
        // Source). The transport's internal ResamplingAudioSource uses
        // linear interpolation, so running mixdown at a different rate
        // than live changes the source→render resample ratio and can
        // perceptibly attenuate high frequencies vs live (rubber-duck
        // pair #2: top remaining cause of "export quieter than live").
        // We then do the projectRate→outputRate step through the
        // FinalResampler (libsamplerate SINC), which is higher quality
        // than the transport's linear interpolator.
        {
            const auto deviceSnap = engine.getAudioDevicesSnapshot();
            const int previousRate = snapshot.projectSampleRate;
            if (deviceSnap.currentSampleRate > 0.0)
            {
                snapshot.projectSampleRate =
                    static_cast<int>(deviceSnap.currentSampleRate);
            }
            silverdaw::log::info(
                "mixdown",
                "projectSampleRate aligned previous=" + juce::String(previousRate) +
                    " deviceRate=" + juce::String(deviceSnap.currentSampleRate, 1) +
                    " effective=" + juce::String(snapshot.projectSampleRate) +
                    " outputRate=" + juce::String(outputSampleRate));
        }

        silverdaw::MixdownOptions options;
        options.outputFile = juce::File(outputPath);
        options.outputSampleRate = outputSampleRate;
        // Map and validate format. Anything unrecognised falls back to
        // WAV so a frontend typo can't produce a binary mismatch.
        if (formatStr == "mp3")
            options.format = silverdaw::MixdownOptions::Format::Mp3;
        else if (formatStr == "flac")
            options.format = silverdaw::MixdownOptions::Format::Flac;
        else if (formatStr == "aiff")
            options.format = silverdaw::MixdownOptions::Format::Aiff;
        else
            options.format = silverdaw::MixdownOptions::Format::Wav;

        // Per-format bit-depth validation. The renderer's UI restricts
        // choices but we still validate here — never trust the
        // frontend. Reject unsupported combinations rather than
        // silently quantising.
        const auto rejectInvalid = [&](const juce::String& msg)
        {
            auto* obj = new juce::DynamicObject();
            obj->setProperty("code", juce::String("invalid"));
            obj->setProperty("error", msg);
            bridge.broadcast("MIXDOWN_FAILED", juce::var(obj));
        };
        switch (options.format)
        {
            case silverdaw::MixdownOptions::Format::Wav:
                if (bitDepthRaw != 16 && bitDepthRaw != 24 && bitDepthRaw != 32)
                {
                    rejectInvalid("WAV export supports 16, 24 or 32-bit only (got " +
                                  juce::String(bitDepthRaw) + ").");
                    return;
                }
                break;
            case silverdaw::MixdownOptions::Format::Flac:
                if (bitDepthRaw != 16 && bitDepthRaw != 24)
                {
                    rejectInvalid("FLAC export supports 16 or 24-bit only (got " +
                                  juce::String(bitDepthRaw) + ").");
                    return;
                }
                break;
            case silverdaw::MixdownOptions::Format::Aiff:
                if (bitDepthRaw != 16 && bitDepthRaw != 24)
                {
                    rejectInvalid("AIFF export supports 16 or 24-bit only (got " +
                                  juce::String(bitDepthRaw) + ").");
                    return;
                }
                break;
            case silverdaw::MixdownOptions::Format::Mp3:
                // MP3 ignores bit-depth; nothing to validate here.
                break;
        }
        options.bitDepth = bitDepthRaw;
        // Tail seconds: finite, non-negative, capped at 60s. The
        // engine also clamps but rejecting at the boundary gives a
        // clearer error than silent clamping.
        if (! std::isfinite(tailSecondsRaw) || tailSecondsRaw < 0.0 || tailSecondsRaw > 60.0)
        {
            rejectInvalid("tailSeconds must be in [0, 60] (got " +
                          juce::String(tailSecondsRaw, 3) + ").");
            return;
        }
        options.tailSeconds = tailSecondsRaw;
        options.dither = ditherRaw;
        options.bitrateKbps = bitrateKbps;

        // Loudness block: optional. Accepts `{ mode, targetLufs?,
        // ceilingDbtp? }` where mode ∈ {off, analyze, normalize}.
        // Defaults: mode=off, targetLufs=-14, ceilingDbtp=-1.
        // Normalize requires targetLufs and ceilingDbtp in the
        // valid ranges; analyze ignores those values.
        const auto loudnessVar = payload.getProperty("loudness", juce::var());
        if (loudnessVar.isObject())
        {
            const auto modeStr = loudnessVar.getProperty("mode", juce::var("off")).toString();
            silverdaw::MixdownOptions::LoudnessMode lm =
                silverdaw::MixdownOptions::LoudnessMode::Off;
            if      (modeStr == "off")       lm = silverdaw::MixdownOptions::LoudnessMode::Off;
            else if (modeStr == "analyze")   lm = silverdaw::MixdownOptions::LoudnessMode::AnalyzeOnly;
            else if (modeStr == "normalize") lm = silverdaw::MixdownOptions::LoudnessMode::Normalize;
            else
            {
                rejectInvalid("loudness.mode must be one of off, analyze, normalize (got \"" + modeStr + "\").");
                return;
            }
            options.loudnessMode = lm;

            if (lm == silverdaw::MixdownOptions::LoudnessMode::Normalize)
            {
                if (! loudnessVar.hasProperty("targetLufs"))
                {
                    rejectInvalid("loudness.targetLufs is required when loudness.mode == normalize.");
                    return;
                }
            }
            const double tgt = static_cast<double>(
                loudnessVar.getProperty("targetLufs", -14.0));
            const double ceil = static_cast<double>(
                loudnessVar.getProperty("ceilingDbtp", -1.0));
            if (! std::isfinite(tgt) || tgt < -30.0 || tgt > -6.0)
            {
                rejectInvalid("loudness.targetLufs must be in [-30, -6] (got " +
                              juce::String(tgt, 2) + ").");
                return;
            }
            if (! std::isfinite(ceil) || ceil < -9.0 || ceil > 0.0)
            {
                rejectInvalid("loudness.ceilingDbtp must be in [-9, 0] (got " +
                              juce::String(ceil, 2) + ").");
                return;
            }
            options.targetLufs = tgt;
            options.ceilingDbtp = ceil;
            if (lm != silverdaw::MixdownOptions::LoudnessMode::Off
                && options.outputSampleRate != 44100
                && options.outputSampleRate != 48000)
            {
                rejectInvalid("Loudness analysis requires 44.1 or 48 kHz output (got " +
                              juce::String(options.outputSampleRate) + ").");
                return;
            }
        }
        if (lengthMode == "trim-to-last-clip")
        {
            options.lengthMs = silverdaw::computeLastClipEndMs(snapshot);
        }
        else
        {
            options.lengthMs = lengthMsHint > 0.0
                                   ? lengthMsHint
                                   : projectState.getProjectLengthMs();
        }
        // File-level metadata (format-agnostic; mapped per-format in the engine).
        const auto md = payload.getProperty("metadata", juce::var());
        if (md.isObject())
        {
            options.metadata.title   = md.getProperty("title",   "").toString();
            options.metadata.artist  = md.getProperty("artist",  "").toString();
            options.metadata.album   = md.getProperty("album",   "").toString();
            options.metadata.year    = md.getProperty("year",    "").toString();
            options.metadata.genre   = md.getProperty("genre",   "").toString();
            options.metadata.comment = md.getProperty("comment", "").toString();
        }

        silverdaw::renderMixdownAsync(std::move(snapshot), std::move(options),
                                      peakPool, bridge,
                                      g_mixdownCancel, g_mixdownBusy);
    }
    else if (type == "MIXDOWN_CANCEL")
    {
        if (!g_mixdownBusy.load())
        {
            silverdaw::log::info("bridge", "MIXDOWN_CANCEL ignored — no render in progress");
            return;
        }
        silverdaw::log::info("bridge", "recv MIXDOWN_CANCEL");
        g_mixdownCancel.store(true);
    }
    else if (type == "EDIT_UNDO")
    {
        silverdaw::log::info("bridge", "recv EDIT_UNDO");
        handleEditUndo(engine, projectState, bridge, session, peakPool, decodedCache);
    }
    else if (type == "EDIT_REDO")
    {
        silverdaw::log::info("bridge", "recv EDIT_REDO");
        handleEditRedo(engine, projectState, bridge, session, peakPool, decodedCache);
    }
    else if (type == "TRANSITION_CREATE")
    {
        silverdaw::log::info("bridge", "recv TRANSITION_CREATE track=" +
                                           payload.getProperty("trackId", "").toString());
        silverdaw::applyTransitionCreate(payload, projectState);
        finishTransitionEdit(engine, projectState, bridge, session);
    }
    else if (type == "TRANSITION_DELETE")
    {
        silverdaw::log::info("bridge", "recv TRANSITION_DELETE id=" +
                                           payload.getProperty("transitionId", "").toString());
        silverdaw::applyTransitionDelete(payload, projectState);
        finishTransitionEdit(engine, projectState, bridge, session);
    }
    else if (type == "TRANSITION_SET_RECIPE")
    {
        silverdaw::log::info("bridge", "recv TRANSITION_SET_RECIPE id=" +
                                           payload.getProperty("transitionId", "").toString());
        silverdaw::applyTransitionSetRecipe(payload, projectState);
        finishTransitionEdit(engine, projectState, bridge, session);
    }
    else
    {
        silverdaw::log::warn("bridge", "unhandled message type: " + type);
    }

    // Mirror to `beginUndoTransactionIfNeeded`. Called AFTER the handler
    // has applied its mutation so the terminal `gestureEnd: true` event
    // folds into the open transaction, then clears the coalesce state
    // for the next gesture.
    endUndoTransactionIfNeeded(type, payload);

    // §12.1 — a geometry edit can break a transition's overlap. Re-derive
    // edge-fades and auto-delete invalidated transitions (joining this edit's
    // still-open undo step). No-op fast path when the project has no
    // transitions, so transition-free projects are unaffected.
    if (transitionGeometryMayHaveChanged(type))
    {
        reconcileTransitionsAfterGeometryEdit(engine, projectState, bridge, session);
    }

    // Undo-state epilogue. Any mutating envelope (or an undo/redo itself)
    // can change `canUndo` / `canRedo`. PROJECT_LOAD / PROJECT_NEW and
    // the recovery / autosave paths each clear the undo history via
    // `replaceTree`, so they fall under the mutating branch too.
    if (isUndoableEnvelopeType(type) || type == "EDIT_UNDO" || type == "EDIT_REDO" ||
        type == "PROJECT_NEW" || type == "PROJECT_LOAD" || type == "PROJECT_LOAD_RECOVERY")
    {
        silverdaw::broadcastEditUndoState(projectState, bridge);
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
    if (bridgePort < 0)
    {
        // `resolveBridgePort` already logged the reason. Print a one-line
        // hint to stderr too so a stand-alone manual run sees the failure
        // even when file logging is disabled.
        std::cerr << "[main] missing or invalid --port; expected: " << argv[0]
                  << " --port <" << kMinBridgePort << "-" << kMaxBridgePort << ">\n";
        return 2;
    }
    const juce::String bridgeToken = resolveBridgeToken(argc, argv);

    // Initialises MessageManager, JUCE singletons, etc. Required even for headless apps.
    const juce::ScopedJuceInitialiser_GUI juceInit;

    silverdaw::AudioEngine engine;
    const auto preferredAudioTypeName =
        juce::SystemStats::getEnvironmentVariable("SILVERDAW_OUTPUT_DEVICE_TYPE", {});
    const auto preferredAudioDeviceName =
        juce::SystemStats::getEnvironmentVariable("SILVERDAW_OUTPUT_DEVICE_NAME", {});
    if (const auto err = engine.initialise(preferredAudioTypeName, preferredAudioDeviceName);
        err.isNotEmpty())
    {
        silverdaw::log::error("engine", "audio device init failed: " + err);
    }

    silverdaw::ProjectState projectState;
    silverdaw::ProjectSession session;

    // Disk-backed cache for waveform peaks. Reused across renderer reloads
    // and even backend restarts so the same file never recomputes peaks
    // twice. See `PeaksCache.h` for the on-disk format.
    const silverdaw::PeaksCache peaksCache;

    // Disk-backed cache for fully-decoded audio. Every imported file is
    // decoded once on the worker pool and written out as a 16-bit PCM
    // WAV; the engine reads back from the cache for every subsequent
    // clip-add, which sidesteps the per-clip MP3 / WMA decode cost
    // entirely. See `DecodedCache.h`.
    const silverdaw::DecodedCache decodedCache;

    if (bridgeToken.isEmpty())
    {
        silverdaw::log::warn("bridge",
                             "WARNING: no AUTH token set (SILVERDAW_BRIDGE_TOKEN unset and --token not given); "
                             "accepting all loopback clients. DO NOT USE IN PRODUCTION.");
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
        [&engine, &projectState, &peakPool, &peaksCache, &decodedCache, &session](
            silverdaw::BridgeServer& self, const juce::String& type, const juce::var& payload)
        {
            // Crash firewall. This lambda runs on the JUCE message thread via
            // `callAsync`; without this guard any exception escaping a single
            // handler would unwind out of `runDispatchLoop()` → `main()` and
            // terminate the whole engine. Catch-and-continue keeps the process
            // alive and surfaces the failure as a non-fatal `ENGINE_ERROR`.
            //
            // Trade-off: a handler that threw part-way may leave an UndoManager
            // transaction open or a partially-applied edit. Full transactional
            // rollback is out of scope; the next mutating envelope opens a fresh
            // transaction, and the renderer can reload to a clean state. We
            // accept a possibly-imperfect edit over a dead engine.
            try
            {
                dispatchBridgeMessage(type, payload, engine, projectState, self, peakPool, peaksCache,
                                      decodedCache, session);
            }
            catch (const std::exception& e)
            {
                silverdaw::log::error("bridge", "handler threw for type=" + type + ": " +
                                                    juce::String(e.what()) + " — engine kept alive");
                auto* p = new juce::DynamicObject();
                p->setProperty("message", juce::String(e.what()));
                p->setProperty("context", type);
                self.broadcast("ENGINE_ERROR", juce::var(p));
            }
            catch (...)
            {
                silverdaw::log::error("bridge",
                                      "handler threw unknown exception for type=" + type + " — engine kept alive");
                auto* p = new juce::DynamicObject();
                p->setProperty("message", juce::String("Unknown engine error"));
                p->setProperty("context", type);
                self.broadcast("ENGINE_ERROR", juce::var(p));
            }
        },
        [&projectState, &session](const silverdaw::BridgeServer::SendToClient& sendToClient)
        {
            // PROJECT_STATE is sent only to the newly-authenticated client,
            // not broadcast — other clients (if any) already have their own
            // snapshot from when they connected. `reset` is omitted on the
            // connect path so the renderer treats it as additive.
            sendToClient("PROJECT_STATE", silverdaw::buildProjectStateEnvelope(session, projectState, false));
            // Seed the renderer's Undo / Redo menu state so the Edit menu
            // reflects the backend's UndoManager from the first paint.
            sendToClient("EDIT_UNDO_STATE", silverdaw::buildEditUndoStateEnvelope(projectState));
        });

    if (!bridge.start(bridgePort))
    {
        silverdaw::log::error("bridge", "failed to start; exiting");
        return 1;
    }

    // Bridge is up — wire ProjectState's dirty-flag transitions through
    // it as `PROJECT_DIRTY { dirty }` envelopes so the renderer can
    // surface the unsaved-changes indicator and gate New / Open / Quit.
    // The callback runs on whichever thread caused the transition;
    // because every ValueTree mutation we perform happens on the JUCE
    // message thread (via `dispatchBridgeMessage`), the broadcast also
    // runs there and `BridgeServer::broadcast` is internally locked.
    projectState.setDirtyChangedCallback(
        [&bridge](bool dirty)
        {
            auto* p = new juce::DynamicObject();
            p->setProperty("dirty", dirty);
            bridge.broadcast("PROJECT_DIRTY", juce::var(p));
        });

    // Rebroadcast AUDIO_DEVICES_LIST whenever JUCE's
    // `audioDeviceListChanged` fires (USB plug / unplug, Windows audio
    // reconfig, current-device removal). The engine has already
    // refreshed its cached snapshot + handled any forced fallback by
    // the time this callback runs, so the renderer's mirror updates
    // in one round-trip and the transport-bar selector reflects the
    // change without polling.
    engine.setDeviceListChangedCallback(
        [&bridge, &engine]()
        {
            silverdaw::broadcastAudioDevicesList(bridge,
                                      silverdaw::buildAudioDevicesListEnvelope(engine.getAudioDevicesSnapshot()),
                                      /*dedupe*/ true);
        });

    silverdaw::PlayheadEmitter emitter(engine, bridge);
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
