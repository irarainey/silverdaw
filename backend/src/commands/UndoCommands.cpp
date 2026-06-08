#include "UndoCommands.h"

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "DecodedCache.h"
#include "Log.h"
#include "ProjectState.h"

namespace silverdaw
{

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

namespace
{

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

UndoCoalesceState& undoCoalesceState()
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

} // namespace

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

} // namespace silverdaw
