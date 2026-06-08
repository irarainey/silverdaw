#include "ProjectCommands.h"

#include "AudioConstants.h"
#include "AudioEngine.h"
#include "BridgeServer.h"
#include "DecodedCache.h"
#include "Log.h"
#include "PayloadHelpers.h"
#include "ProjectFile.h"
#include "ProjectState.h"

namespace silverdaw
{

using silverdaw::bridge::tryGetNumber;
using silverdaw::bridge::tryGetRequiredString;

void handleProjectNew(silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                      silverdaw::BridgeServer& bridge, silverdaw::ProjectSession& session)
{
    // Capture old clip ids before replacing the tree to avoid leaking sources.
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

    // Capture old clip ids before load so failures leave the engine intact.
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
    // Restore the persisted playhead after `engine.stop()` resets to 0.
    const double persistedPlayhead = projectState.getPlayheadMs();
    if (persistedPlayhead > 0.0)
    {
        engine.setPositionMs(persistedPlayhead);
    }
    // Prime read-ahead at the restored playhead to avoid first-play gaps.
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
        // Defensively fall back to the current project path.
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

    // Capture playhead on save without marking it as a user edit.
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
        // Only the default project name follows the chosen file basename.
        if (projectState.getName() == silverdaw::ProjectState::kDefaultName)
        {
            const auto stem = juce::File(filePath).getFileNameWithoutExtension();
            if (stem.isNotEmpty())
            {
                projectState.setName(stem);
            }
        }
        // markClean emits PROJECT_DIRTY(false).
        projectState.markClean();
    }
    bridge.broadcast("PROJECT_SAVED", juce::var(p));
    silverdaw::log::info("project",
                         juce::String("PROJECT_SAVE ") + (isSaveAs ? "(as) " : "") +
                             (result.wasOk() ? "ok" : "fail: " + result.getErrorMessage()) + " path=" + filePath);
    if (result.wasOk() && isSaveAs)
    {
        // Save As changes filePath/name without a separate rename ack.
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

    // PROJECT_SET_VIEW already keeps selection and panel state current.
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

// Autosave must not touch currentPath or clear dirty state.
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

    // Dirty-suppressed playhead/scroll capture avoids autosave feedback loops.
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

// Recovery points Save back at the original path and forces a deliberate save.
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
    // Prime read-ahead at the restored playhead; see PROJECT_LOAD.
    engine.primeTracksForPlayback(silverdaw::kLoadPrimeBudgetMs);

    // Never expose the autosave path as the user's working file.
    session.currentPath = originalPath;

    bridge.broadcast("PROJECT_STATE", silverdaw::buildProjectStateEnvelope(session, projectState, true));

    // ProjectFile::load marks clean, so re-dirty recovered projects explicitly.
    projectState.markDirty();

    silverdaw::log::info("project",
                         juce::String("PROJECT_LOAD_RECOVERY ok autosavePath=") + autosavePath +
                             " originalPath=" + originalPath);
}

} // namespace silverdaw
