#include "ProjectCommands.h"

#include "AudioConstants.h"
#include "AudioEngine.h"
#include "BridgeServer.h"
#include "DecodedCache.h"
#include "EnginePlaybackPath.h"
#include "LibraryAnalysis.h"
#include "Log.h"
#include "PayloadHelpers.h"
#include "ProjectFile.h"
#include "ProjectState.h"

namespace silverdaw
{

using silverdaw::bridge::tryGetNumber;
using silverdaw::bridge::tryGetRequiredString;

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

} // namespace silverdaw
