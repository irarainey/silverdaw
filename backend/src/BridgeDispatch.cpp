#include "BridgeDispatch.h"

#include "AudioEngine.h"
#include "AudioDeviceCommands.h"
#include "BridgeServer.h"
#include "ClipCommands.h"
#include "CommandHelpers.h"
#include "DecodedCache.h"
#include "EditUndoState.h"
#include "LibraryCommands.h"
#include "Log.h"
#include "MarkerCommands.h"
#include "MixdownCommands.h"
#include "PayloadHelpers.h"
#include "PeaksCache.h"
#include "PreviewCommands.h"
#include "ProjectCommands.h"
#include "ProjectFxCommands.h"
#include "ProjectSession.h"
#include "ProjectSettingsCommands.h"
#include "ProjectState.h"
#include "SampleExport.h"
#include "TrackCommands.h"
#include "TransitionCommands.h"
#include "TransportCommands.h"
#include "UndoCommands.h"
#include "WaveformCommands.h"

#include <atomic>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

namespace silverdaw
{
namespace
{
// Mixdown job state. `g_mixdownBusy` is set true while a render is in flight
// and gates `TRANSPORT_PLAY` so transport can't audibly start mid-render.
// `g_mixdownCancel` is the cancel flag the engine polls every block.
std::atomic<bool> g_mixdownBusy{false};
std::atomic<bool> g_mixdownCancel{false};
} // namespace

// Bridge payload validation helpers live in `PayloadHelpers.h` so the backend
// test binary can link them in. Hoist them in here so the dispatch branches
// (`tryGetNumber(payload, "X")` etc.) read unqualified.
using silverdaw::bridge::tryGetNumber;
using silverdaw::bridge::tryGetRequiredString;
using silverdaw::bridge::tryGetString;
using silverdaw::bridge::readOptionalNumber;
using silverdaw::bridge::readOptionalBool;
using silverdaw::bridge::readOptionalString;
using silverdaw::broadcastApplied;

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
    silverdaw::beginUndoTransactionIfNeeded(type, payload, projectState);
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
        silverdaw::handleClipSetLocked(payload, projectState);
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
        silverdaw::handleLibraryItemRelink(payload, engine, projectState, bridge, session, peakPool, decodedCache);
    }
    else if (type == "CLIP_RENAME")
    {
        silverdaw::handleClipRename(payload, projectState);
    }
    else if (type == "CLIP_REBIND")
    {
        silverdaw::handleClipRebind(payload, projectState);
    }
    else if (type == "CLIP_SET_WARP")
    {
        silverdaw::handleClipSetWarp(payload, engine, projectState, bridge);
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
        silverdaw::handleProjectNew(engine, projectState, bridge, session);
    }
    else if (type == "PROJECT_SAVE")
    {
        silverdaw::log::info("bridge", "recv PROJECT_SAVE");
        silverdaw::handleProjectSave(payload, engine, projectState, bridge, session, /*isSaveAs*/ false);
    }
    else if (type == "PROJECT_SAVE_AS")
    {
        silverdaw::log::info("bridge", "recv PROJECT_SAVE_AS path=" + payload.getProperty("filePath", "").toString());
        silverdaw::handleProjectSave(payload, engine, projectState, bridge, session, /*isSaveAs*/ true);
    }
    else if (type == "PROJECT_SAVE_VIEW_STATE")
    {
        silverdaw::log::info("bridge", "recv PROJECT_SAVE_VIEW_STATE");
        silverdaw::handleProjectSaveViewState(payload, engine, projectState, bridge, session);
    }
    else if (type == "PROJECT_LOAD")
    {
        silverdaw::log::info("bridge", "recv PROJECT_LOAD path=" + payload.getProperty("filePath", "").toString());
        silverdaw::handleProjectLoad(payload, engine, projectState, bridge, session, peakPool, decodedCache);
    }
    else if (type == "PROJECT_LOAD_RECOVERY")
    {
        silverdaw::log::info("bridge", "recv PROJECT_LOAD_RECOVERY autosavePath=" +
                                           payload.getProperty("autosavePath", "").toString());
        silverdaw::handleProjectLoadRecovery(payload, engine, projectState, bridge, session, peakPool, decodedCache);
    }
    else if (type == "PROJECT_AUTOSAVE")
    {
        silverdaw::log::debug("bridge", "recv PROJECT_AUTOSAVE path=" +
                                            payload.getProperty("filePath", "").toString());
        silverdaw::handleProjectAutosave(payload, engine, projectState, bridge);
    }
    else if (type == "PROJECT_RENAME")
    {
        silverdaw::log::info("bridge", "recv PROJECT_RENAME name=" + payload.getProperty("name", "").toString());
        silverdaw::handleProjectRename(payload, projectState, bridge);
    }
    else if (type == "PROJECT_SET_VIEW")
    {
        silverdaw::handleProjectSetView(payload, projectState);
    }
    else if (type == "PROJECT_SET_BPM")
    {
        silverdaw::handleProjectSetBpm(payload, engine, projectState, bridge);
    }
    else if (type == "PROJECT_SET_LENGTH")
    {
        silverdaw::handleProjectSetLength(payload, projectState);
    }
    else if (type == "PROJECT_SET_AUDIO_OUTPUT")
    {
        silverdaw::handleProjectSetAudioOutput(payload, projectState);
    }
    else if (type == "PROJECT_SET_TARGET_SAMPLE_RATE")
    {
        silverdaw::handleProjectSetTargetSampleRate(payload, projectState);
    }
    else if (type == "PROJECT_SET_EXPORT_SETTINGS")
    {
        silverdaw::handleProjectSetExportSettings(payload, projectState);
    }
    else if (type == "PROJECT_SET_MASTER_VOLUME")
    {
        silverdaw::handleProjectSetMasterVolume(payload, engine, projectState);
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
        silverdaw::handleAudioFileProbe(payload, engine, bridge, peakPool);
    }
    else if (type == "MIXDOWN_START")
    {
        silverdaw::handleMixdownStart(payload, engine, projectState, bridge, peakPool, decodedCache,
                                      g_mixdownBusy, g_mixdownCancel);
    }
    else if (type == "MIXDOWN_CANCEL")
    {
        silverdaw::handleMixdownCancel(g_mixdownBusy, g_mixdownCancel);
    }
    else if (type == "EDIT_UNDO")
    {
        silverdaw::log::info("bridge", "recv EDIT_UNDO");
        silverdaw::handleEditUndo(engine, projectState, bridge, session, peakPool, decodedCache);
    }
    else if (type == "EDIT_REDO")
    {
        silverdaw::log::info("bridge", "recv EDIT_REDO");
        silverdaw::handleEditRedo(engine, projectState, bridge, session, peakPool, decodedCache);
    }
    else if (type == "TRANSITION_CREATE")
    {
        silverdaw::log::info("bridge", "recv TRANSITION_CREATE track=" +
                                           payload.getProperty("trackId", "").toString());
        silverdaw::applyTransitionCreate(payload, projectState);
        silverdaw::finishTransitionEdit(engine, projectState, bridge, session);
    }
    else if (type == "TRANSITION_DELETE")
    {
        silverdaw::log::info("bridge", "recv TRANSITION_DELETE id=" +
                                           payload.getProperty("transitionId", "").toString());
        silverdaw::applyTransitionDelete(payload, projectState);
        silverdaw::finishTransitionEdit(engine, projectState, bridge, session);
    }
    else if (type == "TRANSITION_SET_RECIPE")
    {
        silverdaw::log::info("bridge", "recv TRANSITION_SET_RECIPE id=" +
                                           payload.getProperty("transitionId", "").toString());
        silverdaw::applyTransitionSetRecipe(payload, projectState);
        silverdaw::finishTransitionEdit(engine, projectState, bridge, session);
    }
    else
    {
        silverdaw::log::warn("bridge", "unhandled message type: " + type);
    }

    // Mirror to `beginUndoTransactionIfNeeded`. Called AFTER the handler
    // has applied its mutation so the terminal `gestureEnd: true` event
    // folds into the open transaction, then clears the coalesce state
    // for the next gesture.
    silverdaw::endUndoTransactionIfNeeded(type, payload);

    // §12.1 — a geometry edit can break a transition's overlap. Re-derive
    // edge-fades and auto-delete invalidated transitions (joining this edit's
    // still-open undo step). No-op fast path when the project has no
    // transitions, so transition-free projects are unaffected.
    if (silverdaw::transitionGeometryMayHaveChanged(type))
    {
        silverdaw::reconcileTransitionsAfterGeometryEdit(engine, projectState, bridge, session);
    }

    // Undo-state epilogue. Any mutating envelope (or an undo/redo itself)
    // can change `canUndo` / `canRedo`. PROJECT_LOAD / PROJECT_NEW and
    // the recovery / autosave paths each clear the undo history via
    // `replaceTree`, so they fall under the mutating branch too.
    if (silverdaw::isUndoableEnvelopeType(type) || type == "EDIT_UNDO" || type == "EDIT_REDO" ||
        type == "PROJECT_NEW" || type == "PROJECT_LOAD" || type == "PROJECT_LOAD_RECOVERY")
    {
        silverdaw::broadcastEditUndoState(projectState, bridge);
    }
}

} // namespace silverdaw
