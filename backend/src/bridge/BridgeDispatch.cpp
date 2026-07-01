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
#include "StemSeparationCommands.h"
#include "StemSeparator.h"
#include "TrackCommands.h"
#include "TransitionCommands.h"
#include "TransportCommands.h"
#include "UndoCommands.h"
#include "WaveformCommands.h"

#include <atomic>
#include <memory>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

namespace silverdaw
{
namespace
{
// Mixdown state gates playback and carries the engine-polled cancel flag.
std::atomic<bool> g_mixdownBusy{false};
std::atomic<bool> g_mixdownCancel{false};

// Stem separation runs single-slot on the shared pool; activeJobId is touched
// only on the message thread so it needs no lock.
std::atomic<bool> g_stemBusy{false};
std::atomic<bool> g_stemCancel{false};
juce::String g_stemActiveJobId;

// Lazily constructed so the ONNX environment is only spun up if a build with
// stem separation actually receives a STEM_SEPARATE.
silverdaw::StemSeparator& stemSeparator()
{
    static std::unique_ptr<silverdaw::StemSeparator> instance = silverdaw::createDefaultStemSeparator();
    return *instance;
}

// Bundles the long, shared dispatch parameter list so each per-domain router
// stays readable. References only: the context outlives every dispatch call.
struct DispatchContext
{
    const juce::String& type;
    const juce::var& payload;
    silverdaw::AudioEngine& engine;
    silverdaw::ProjectState& projectState;
    silverdaw::BridgeServer& bridge;
    juce::ThreadPool& peakPool;
    const silverdaw::PeaksCache& cache;
    const silverdaw::DecodedCache& decodedCache;
    silverdaw::ProjectSession& session;
};
} // namespace

// Hoist payload readers so dispatch branches stay readable.
using silverdaw::bridge::tryGetNumber;
using silverdaw::bridge::tryGetRequiredString;
using silverdaw::bridge::tryGetString;
using silverdaw::bridge::readOptionalNumber;
using silverdaw::bridge::readOptionalBool;
using silverdaw::bridge::readOptionalString;
using silverdaw::broadcastApplied;

namespace
{
// Each dispatchXxx returns true if it owned `type`. Branch bodies are unchanged
// from the original monolithic switch; only the routing is grouped by domain.

bool dispatchClip(const DispatchContext& ctx)
{
    const auto& type = ctx.type;
    const auto& payload = ctx.payload;
    auto& engine = ctx.engine;
    auto& projectState = ctx.projectState;
    auto& bridge = ctx.bridge;
    auto& peakPool = ctx.peakPool;
    const auto& cache = ctx.cache;
    const auto& decodedCache = ctx.decodedCache;
    auto& session = ctx.session;

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
    else if (type == "CLIP_SET_REVERSED")
    {
        silverdaw::handleClipSetReversed(payload, engine, projectState);
    }
    else if (type == "CLIP_SET_BRAKE")
    {
        silverdaw::handleClipSetBrake(payload, engine, projectState);
    }
    else if (type == "CLIP_SET_BACKSPIN")
    {
        silverdaw::handleClipSetBackspin(payload, engine, projectState);
    }
    else if (type == "CLIP_REMOVE")
    {
        silverdaw::log::info("bridge", "recv CLIP_REMOVE clipId=" + payload.getProperty("clipId", "").toString());
        silverdaw::handleClipRemove(payload, engine, projectState, bridge);
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
        silverdaw::handleClipSaveAsSample(payload, engine, projectState, bridge, peakPool, cache,
                                          session.currentPath);
    }
    else if (type == "CLIP_SLICE_TO_SAMPLES")
    {
        silverdaw::handleClipSliceToSamples(payload, engine, projectState, bridge, peakPool, cache,
                                            session.currentPath);
    }
    else if (type == "CLIP_SET_ENVELOPE")
    {
        silverdaw::log::debug("bridge", "recv CLIP_SET_ENVELOPE clipId=" +
                                            payload.getProperty("clipId", "").toString());
        silverdaw::handleClipSetEnvelope(payload, engine, projectState, bridge);
    }
    else
    {
        return false;
    }
    return true;
}

bool dispatchLibrary(const DispatchContext& ctx)
{
    const auto& type = ctx.type;
    const auto& payload = ctx.payload;
    auto& engine = ctx.engine;
    auto& projectState = ctx.projectState;
    auto& bridge = ctx.bridge;
    auto& peakPool = ctx.peakPool;
    const auto& cache = ctx.cache;
    const auto& decodedCache = ctx.decodedCache;
    auto& session = ctx.session;

    if (type == "LIBRARY_ITEM_RELINK")
    {
        silverdaw::log::info("bridge", "recv LIBRARY_ITEM_RELINK itemId=" + payload.getProperty("itemId", "").toString() +
                                            " path=" + payload.getProperty("filePath", "").toString());
        silverdaw::handleLibraryItemRelink(payload, engine, projectState, bridge, session, peakPool, decodedCache);
    }
    else if (type == "LIBRARY_ITEM_SAVE_AS_SAMPLE")
    {
        silverdaw::handleLibraryItemSaveAsSample(payload, engine, projectState, bridge, peakPool, cache,
                                                 session.currentPath);
    }
    else if (type == "LIBRARY_ADD")
    {
        silverdaw::handleLibraryAdd(payload, engine, projectState, bridge, peakPool, decodedCache);
    }
    else if (type == "LIBRARY_REMOVE")
    {
        silverdaw::handleLibraryRemove(payload, projectState, session);
    }
    else if (type == "LIBRARY_DELETE_ARTIFACTS")
    {
        silverdaw::handleLibraryDeleteArtifacts(payload, session, engine);
    }
    else if (type == "LIBRARY_REANALYSE")
    {
        silverdaw::handleLibraryReanalyse(payload, engine, projectState, bridge, peakPool, decodedCache);
    }
    else if (type == "LIBRARY_ITEM_SET_AUDIO_TYPE")
    {
        silverdaw::handleLibraryItemSetAudioType(payload, projectState);
    }
    else if (type == "LIBRARY_ITEM_SET_COVER_HIDDEN")
    {
        silverdaw::handleLibraryItemSetCoverHidden(payload, projectState);
    }
    else if (type == "LIBRARY_ITEM_SET_MANUAL_TEMPO")
    {
        silverdaw::handleLibraryItemSetManualTempo(payload, engine, projectState, bridge);
    }
    else
    {
        return false;
    }
    return true;
}

bool dispatchTransport(const DispatchContext& ctx)
{
    const auto& type = ctx.type;
    const auto& payload = ctx.payload;
    auto& engine = ctx.engine;
    auto& projectState = ctx.projectState;

    if (type == "TRANSPORT_PLAY")
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
    else
    {
        return false;
    }
    return true;
}

bool dispatchPreview(const DispatchContext& ctx)
{
    const auto& type = ctx.type;
    const auto& payload = ctx.payload;
    auto& engine = ctx.engine;
    auto& projectState = ctx.projectState;
    auto& bridge = ctx.bridge;
    const auto& decodedCache = ctx.decodedCache;

    if (type == "PREVIEW_LOAD")
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
    else if (type == "PREVIEW_SET_REVERSED")
    {
        silverdaw::handlePreviewSetReversed(payload, engine);
    }
    else if (type == "PREVIEW_SET_BRAKE")
    {
        silverdaw::handlePreviewSetBrake(payload, engine, projectState);
    }
    else if (type == "PREVIEW_SET_BACKSPIN")
    {
        silverdaw::handlePreviewSetBackspin(payload, engine, projectState);
    }
    else
    {
        return false;
    }
    return true;
}

bool dispatchTrack(const DispatchContext& ctx)
{
    const auto& type = ctx.type;
    const auto& payload = ctx.payload;
    auto& engine = ctx.engine;
    auto& projectState = ctx.projectState;
    auto& bridge = ctx.bridge;

    if (type == "TRACK_ADD")
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
    else if (type == "TRACK_SET_AUTOMATION")
    {
        silverdaw::log::debug("bridge", "recv TRACK_SET_AUTOMATION trackId=" +
                                            payload.getProperty("trackId", "").toString() +
                                            " paramId=" + payload.getProperty("paramId", "").toString());
        silverdaw::handleTrackSetAutomation(payload, engine, projectState, bridge);
    }
    else
    {
        return false;
    }
    return true;
}

bool dispatchProjectFx(const DispatchContext& ctx)
{
    const auto& type = ctx.type;
    const auto& payload = ctx.payload;
    auto& engine = ctx.engine;
    auto& projectState = ctx.projectState;
    auto& bridge = ctx.bridge;

    if (type == "PROJECT_SET_REVERB")
    {
        silverdaw::log::debug("bridge", "recv PROJECT_SET_REVERB");
        silverdaw::handleProjectSetReverb(payload, engine, projectState, bridge);
    }
    else if (type == "PROJECT_SET_DELAY")
    {
        silverdaw::log::debug("bridge", "recv PROJECT_SET_DELAY");
        silverdaw::handleProjectSetDelay(payload, engine, projectState, bridge);
    }
    else
    {
        return false;
    }
    return true;
}

bool dispatchWaveform(const DispatchContext& ctx)
{
    const auto& type = ctx.type;
    const auto& payload = ctx.payload;
    auto& engine = ctx.engine;
    auto& projectState = ctx.projectState;
    auto& bridge = ctx.bridge;
    auto& peakPool = ctx.peakPool;
    const auto& cache = ctx.cache;

    if (type == "WAVEFORM_REQUEST")
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
    else
    {
        return false;
    }
    return true;
}

bool dispatchProject(const DispatchContext& ctx)
{
    const auto& type = ctx.type;
    const auto& payload = ctx.payload;
    auto& engine = ctx.engine;
    auto& projectState = ctx.projectState;
    auto& bridge = ctx.bridge;
    auto& peakPool = ctx.peakPool;
    const auto& decodedCache = ctx.decodedCache;
    auto& session = ctx.session;

    if (type == "PROJECT_NEW")
    {
        silverdaw::log::info("bridge", "recv PROJECT_NEW");
        silverdaw::handleProjectNew(engine, projectState, bridge, session);
    }
    else if (type == "PROJECT_SAVE")
    {
        silverdaw::log::info("bridge", "recv PROJECT_SAVE");
        silverdaw::handleProjectSave(payload, engine, projectState, bridge, session, /*isSaveAs*/ false,
                                     peakPool, decodedCache);
    }
    else if (type == "PROJECT_SAVE_AS")
    {
        silverdaw::log::info("bridge", "recv PROJECT_SAVE_AS path=" + payload.getProperty("filePath", "").toString());
        silverdaw::handleProjectSave(payload, engine, projectState, bridge, session, /*isSaveAs*/ true,
                                     peakPool, decodedCache);
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
    else if (type == "PROJECT_SET_BAR_COUNTER_START")
    {
        silverdaw::handleProjectSetBarCounterStart(payload, projectState);
    }
    else if (type == "PROJECT_SET_MIXDOWN_START_BAR")
    {
        silverdaw::handleProjectSetMixdownStartBar(payload, projectState);
    }
    else if (type == "PROJECT_SET_METRONOME")
    {
        silverdaw::handleProjectSetMetronome(payload, engine, projectState);
    }
    else
    {
        return false;
    }
    return true;
}

bool dispatchMarker(const DispatchContext& ctx)
{
    const auto& type = ctx.type;
    const auto& payload = ctx.payload;
    auto& projectState = ctx.projectState;

    if (type == "PROJECT_MARKER_ADD")
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
    else
    {
        return false;
    }
    return true;
}

bool dispatchAudioDevice(const DispatchContext& ctx)
{
    const auto& type = ctx.type;
    const auto& payload = ctx.payload;
    auto& engine = ctx.engine;
    auto& bridge = ctx.bridge;
    auto& peakPool = ctx.peakPool;

    if (type == "AUDIO_DEVICES_REQUEST")
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
    else if (type == "AUDIO_KEEP_AWAKE_SET")
    {
        silverdaw::log::info("bridge", "recv AUDIO_KEEP_AWAKE_SET enabled=" +
                                           payload.getProperty("enabled", false).toString());
        silverdaw::handleAudioKeepAwakeSet(payload, engine);
    }
    else if (type == "BRAKE_SETTINGS_SET")
    {
        silverdaw::handleSetBrakeSettings(payload, engine);
    }
    else if (type == "BACKSPIN_SETTINGS_SET")
    {
        silverdaw::handleSetBackspinSettings(payload, engine);
    }
    else if (type == "AUDIO_FILE_PROBE")
    {
        silverdaw::handleAudioFileProbe(payload, engine, bridge, peakPool);
    }
    else
    {
        return false;
    }
    return true;
}

bool dispatchMixdown(const DispatchContext& ctx)
{
    const auto& type = ctx.type;
    const auto& payload = ctx.payload;
    auto& engine = ctx.engine;
    auto& projectState = ctx.projectState;
    auto& bridge = ctx.bridge;
    auto& peakPool = ctx.peakPool;
    const auto& decodedCache = ctx.decodedCache;

    if (type == "MIXDOWN_START")
    {
        silverdaw::handleMixdownStart(payload, engine, projectState, bridge, peakPool, decodedCache,
                                      g_mixdownBusy, g_mixdownCancel);
    }
    else if (type == "MIXDOWN_CANCEL")
    {
        silverdaw::handleMixdownCancel(g_mixdownBusy, g_mixdownCancel);
    }
    else
    {
        return false;
    }
    return true;
}

bool dispatchStem(const DispatchContext& ctx)
{
    const auto& type = ctx.type;
    const auto& payload = ctx.payload;
    auto& projectState = ctx.projectState;
    auto& bridge = ctx.bridge;
    auto& peakPool = ctx.peakPool;
    const auto& decodedCache = ctx.decodedCache;
    auto& session = ctx.session;

    if (type == "STEM_SEPARATE")
    {
        silverdaw::handleStemSeparate(payload, projectState, bridge, peakPool, decodedCache,
                                      stemSeparator(), g_stemBusy, g_stemCancel, g_stemActiveJobId,
                                      session.currentPath);
    }
    else if (type == "STEM_SEPARATE_CANCEL")
    {
        silverdaw::handleStemSeparateCancel(payload, g_stemBusy, g_stemCancel, g_stemActiveJobId);
    }
    else
    {
        return false;
    }
    return true;
}

bool dispatchUndo(const DispatchContext& ctx)
{
    const auto& type = ctx.type;
    auto& engine = ctx.engine;
    auto& projectState = ctx.projectState;
    auto& bridge = ctx.bridge;
    auto& peakPool = ctx.peakPool;
    const auto& decodedCache = ctx.decodedCache;
    auto& session = ctx.session;

    if (type == "EDIT_UNDO")
    {
        silverdaw::log::info("bridge", "recv EDIT_UNDO");
        silverdaw::handleEditUndo(engine, projectState, bridge, session, peakPool, decodedCache);
    }
    else if (type == "EDIT_REDO")
    {
        silverdaw::log::info("bridge", "recv EDIT_REDO");
        silverdaw::handleEditRedo(engine, projectState, bridge, session, peakPool, decodedCache);
    }
    else if (type == "EDIT_GROUP_BEGIN")
    {
        const auto label = silverdaw::bridge::readOptionalString(ctx.payload, "label")
                               .value_or(juce::String{});
        silverdaw::log::info("bridge", "recv EDIT_GROUP_BEGIN label=" + label);
        silverdaw::beginUndoGroup(label, projectState);
    }
    else if (type == "EDIT_GROUP_END")
    {
        silverdaw::log::info("bridge", "recv EDIT_GROUP_END");
        silverdaw::endUndoGroup();
    }
    else
    {
        return false;
    }
    return true;
}

bool dispatchTransition(const DispatchContext& ctx)
{
    const auto& type = ctx.type;
    const auto& payload = ctx.payload;
    auto& engine = ctx.engine;
    auto& projectState = ctx.projectState;
    auto& bridge = ctx.bridge;
    auto& session = ctx.session;

    if (type == "TRANSITION_CREATE")
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
        return false;
    }
    return true;
}
} // namespace

// Wire-protocol order is fixed as (type, payload).
// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
void dispatchBridgeMessage(const juce::String& type, const juce::var& payload, silverdaw::AudioEngine& engine,
                           silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                           juce::ThreadPool& peakPool, const silverdaw::PeaksCache& cache,
                           const silverdaw::DecodedCache& decodedCache, silverdaw::ProjectSession& session)
{
    // Answer on the message thread so PING proves command-thread responsiveness.
    if (type == "PING")
    {
        auto* p = new juce::DynamicObject();
        p->setProperty("id", payload.getProperty("id", 0));
        bridge.broadcast("PONG", juce::var(p));
        return;
    }

    // Mutations get one undo transaction; high-rate drag streams coalesce by target.
    silverdaw::beginUndoTransactionIfNeeded(type, payload, projectState);

    // Route to the first domain that owns the type. Type strings are unique, so
    // the chaining order only affects readability, not behaviour.
    const DispatchContext ctx{type,  payload, engine,       projectState, bridge,
                              peakPool, cache,   decodedCache, session};
    const bool handled = dispatchClip(ctx) || dispatchLibrary(ctx) || dispatchTransport(ctx) ||
                         dispatchPreview(ctx) || dispatchTrack(ctx) || dispatchProjectFx(ctx) ||
                         dispatchWaveform(ctx) || dispatchProject(ctx) || dispatchMarker(ctx) ||
                         dispatchAudioDevice(ctx) || dispatchMixdown(ctx) || dispatchStem(ctx) ||
                         dispatchUndo(ctx) || dispatchTransition(ctx);
    if (!handled)
    {
        silverdaw::log::warn("bridge", "unhandled message type: " + type);
    }

    // Run after mutation so terminal gesture events fold into the open transaction.
    silverdaw::endUndoTransactionIfNeeded(type, payload);

    // Geometry edits can invalidate transition overlaps; reconcile inside the same undo step.
    if (silverdaw::transitionGeometryMayHaveChanged(type))
    {
        silverdaw::reconcileTransitionsAfterGeometryEdit(engine, projectState, bridge, session);
    }

    // Mutations and project replacement can change undo/redo menu state.
    if (silverdaw::isUndoableEnvelopeType(type) || type == "EDIT_UNDO" || type == "EDIT_REDO" ||
        type == "PROJECT_NEW" || type == "PROJECT_LOAD" || type == "PROJECT_LOAD_RECOVERY")
    {
        silverdaw::broadcastEditUndoState(projectState, bridge);
    }
}

} // namespace silverdaw
