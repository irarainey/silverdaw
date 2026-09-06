#include "RecordingCommands.h"

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "EditUndoState.h"
#include "LibraryAnalysis.h"
#include "Log.h"
#include "PayloadHelpers.h"
#include "PeaksCache.h"
#include "ProjectSession.h"
#include "ProjectState.h"
#include "Waveform.h"
#include "WaveformCommands.h"
#include "recording/CaptureDevice.h"
#include "recording/RecordingCleanup.h"
#include "recording/RecordingFinalise.h"
#include "recording/RecordingSessionController.h"

#include <juce_events/juce_events.h>

#include <memory>
#include <optional>

namespace silverdaw
{

using silverdaw::bridge::readOptionalString;
using silverdaw::bridge::tryGetNumber;
using silverdaw::bridge::tryGetRequiredString;

namespace
{
constexpr int kRecordingProtocolVersion = 1;

// The finished recording, waiting for the user to keep or discard it. It is a
// file on disk and nothing else: no library item exists until the commit.

/** One writable form of the take: the file plus the peaks already computed for
 *  it, so switching between the mono capture and its stereo duplicate never
 *  recomputes what is already on disk. */
struct TakeVariant
{
    juce::File file;
    int channelCount = 0;
    juce::File cacheFile;
    int peakCount = 0;
    int laneCount = 0;
    double peaksPerSecond = 0.0;
};

struct FinishedRecording
{
    juce::String sessionId;
    juce::String recordingId;
    juce::File file;
    juce::String suggestedName;
    double durationMs = 0.0;
    double sampleRate = 0.0;
    int channelCount = 1;
    double anchorMs = 0.0;
    double bpm = 120.0;
    double beatAnchorSec = 0.0;
    std::optional<int> musicalBeats;
    /** Committed as musical material (project tempo, beat markers) or as a plain
     *  sample with neither. */
    bool musical = true;
    /** True while `file` is the stereo duplicate of a mono capture. */
    bool stereoDuplicated = false;
    /** The take's other form, once it has been built: the mono capture while the
     *  duplicate is in hand, and the duplicate again after switching back. Kept so
     *  the choice is instant and reversible, and deleted with the take. */
    std::optional<TakeVariant> alternate;
    juce::File cacheFile;
    int peakCount = 0;
    int laneCount = 0;
    double peaksPerSecond = 0.0;
    double latencyOffsetMs = 0.0;
    double driftPpm = 0.0;
    juce::int64 droppedSamples = 0;
};

/** The form the take is currently in, ready to be put aside for the other one. */
TakeVariant currentVariant(const FinishedRecording& take)
{
    return {take.file,      take.channelCount, take.cacheFile,
            take.peakCount, take.laneCount,    take.peaksPerSecond};
}

void adoptVariant(FinishedRecording& take, const TakeVariant& variant)
{
    take.file = variant.file;
    take.channelCount = variant.channelCount;
    take.cacheFile = variant.cacheFile;
    take.peakCount = variant.peakCount;
    take.laneCount = variant.laneCount;
    take.peaksPerSecond = variant.peaksPerSecond;
}

// One recording session at a time, message-thread owned. Held here rather than
// in the engine because capture is deliberately outside the engine's device
// manager (ADR 0030).
recording::RecordingSessionController& controller()
{
    static recording::RecordingSessionController instance;
    return instance;
}

std::optional<FinishedRecording>& finished()
{
    static std::optional<FinishedRecording> instance;
    return instance;
}

void discardFinished()
{
    if (auto& pending = finished(); pending.has_value())
    {
        pending->file.deleteFile();
        // The form the user did not settle on is a working file and goes with it.
        if (pending->alternate.has_value()) pending->alternate->file.deleteFile();
        pending.reset();
    }
}

juce::String sanitiseRecordingFileName(juce::String name)
{
    name = name.trim();
    if (name.isEmpty()) name = "Recording";
    static constexpr const char* bad = "<>:\"/\\|?*";
    for (int i = 0; bad[i] != '\0'; ++i)
        name = name.replaceCharacter(bad[i], '_');
    return name.trim().isNotEmpty() ? name.trim() : juce::String("Recording");
}

// "Recording 1", "Recording 2", … — the next free number in the project, so the
// default name only has to be unsurprising and unique.
juce::String nextRecordingName(const ProjectState& projectState)
{
    int highest = 0;
    const auto library = projectState.libraryAsJson();
    if (const auto* items = library.getArray())
    {
        for (const auto& item : *items)
        {
            for (const char* key : {"name", "fileName"})
            {
                const auto text = item.getProperty(key, juce::var())
                                      .toString()
                                      .upToLastOccurrenceOf(".wav", false, true);
                if (! text.startsWithIgnoreCase("Recording ")) continue;
                const auto number = text.fromFirstOccurrenceOf(" ", false, false).trim();
                if (number.isNotEmpty() && number.containsOnly("0123456789"))
                    highest = juce::jmax(highest, number.getIntValue());
            }
        }
    }
    return "Recording " + juce::String(highest + 1);
}

juce::File uniqueRecordingWav(const juce::File& directory, const juce::String& baseName)
{
    auto file = directory.getChildFile(baseName + ".wav");
    for (int i = 2; file.existsAsFile() && i < 10000; ++i)
        file = directory.getChildFile(baseName + " (" + juce::String(i) + ").wav");
    return file;
}

juce::var buildStateEnvelope(const recording::RecordingStateSnapshot& snapshot)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("protocolVersion", kRecordingProtocolVersion);
    obj->setProperty("sessionId", snapshot.sessionId);
    obj->setProperty("status", snapshot.status);
    if (snapshot.input.has_value())
    {
        auto* input = new juce::DynamicObject();
        input->setProperty("typeName", snapshot.input->typeName);
        input->setProperty("deviceName", snapshot.input->deviceName);
        juce::Array<juce::var> names;
        for (const auto& name : snapshot.input->channelNames)
            names.add(name);
        input->setProperty("channelNames", names);
        input->setProperty("sampleRate", snapshot.input->sampleRate);
        input->setProperty("inputLatencyMs", snapshot.input->inputLatencyMs);
        obj->setProperty("input", juce::var(input));
    }
    else
    {
        obj->setProperty("input", juce::var());
    }
    obj->setProperty("firstChannel", snapshot.firstChannel);
    obj->setProperty("channelCount", snapshot.channelCount);
    obj->setProperty("countInBars", snapshot.countInBars);
    obj->setProperty("clickEnabled", snapshot.clickEnabled);
    juce::Array<juce::var> backingTrackIds;
    for (const auto& trackId : snapshot.backingTrackIds)
        backingTrackIds.add(trackId);
    obj->setProperty("backingTrackIds", backingTrackIds);
    obj->setProperty("backingGain", snapshot.backingGain);
    obj->setProperty("inputGainDb", snapshot.inputGainDb);
    obj->setProperty("recordingMode", snapshot.recordingMode);
    obj->setProperty("monitorEnabled", snapshot.monitorEnabled);
    obj->setProperty("cleanupEnabled", snapshot.cleanupEnabled);
    obj->setProperty("windowMode", snapshot.windowMode);
    obj->setProperty("hasSelection", snapshot.hasSelection);
    obj->setProperty("anchorMs", snapshot.anchorMs);
    obj->setProperty("windowEndMs", snapshot.windowEndMs.has_value() ? juce::var(*snapshot.windowEndMs)
                                                                     : juce::var());
    if (snapshot.countInBarsRemaining.has_value())
        obj->setProperty("countInBarsRemaining", *snapshot.countInBarsRemaining);
    obj->setProperty("recordedMs", snapshot.recordedMs);
    obj->setProperty("droppedSamples", static_cast<int>(snapshot.droppedSamples));
    if (snapshot.errorCode.isNotEmpty()) obj->setProperty("errorCode", snapshot.errorCode);
    if (snapshot.error.isNotEmpty()) obj->setProperty("error", snapshot.error);
    return juce::var(obj);
}

void broadcastState(BridgeServer& bridge)
{
    if (! controller().hasSession()) return;
    bridge.broadcast("RECORD_SESSION_STATE", buildStateEnvelope(controller().getSnapshot()));
}

void broadcastReady(BridgeServer& bridge, const FinishedRecording& ready)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("protocolVersion", kRecordingProtocolVersion);
    obj->setProperty("sessionId", ready.sessionId);
    obj->setProperty("recordingId", ready.recordingId);
    obj->setProperty("filePath", ready.file.getFullPathName());
    obj->setProperty("suggestedName", ready.suggestedName);
    obj->setProperty("durationMs", ready.durationMs);
    obj->setProperty("sampleRate", ready.sampleRate);
    obj->setProperty("channelCount", ready.channelCount);
    // What the take is right now, so the review's stereo option shows the truth
    // rather than what the renderer last asked for.
    obj->setProperty("stereoDuplicated", ready.stereoDuplicated);
    obj->setProperty("anchorMs", ready.anchorMs);
    obj->setProperty("bpm", ready.bpm);
    obj->setProperty("beatAnchorSec", ready.beatAnchorSec);
    if (ready.musicalBeats.has_value()) obj->setProperty("musicalBeats", *ready.musicalBeats);
    obj->setProperty("musical", ready.musical);
    obj->setProperty("cachePath", ready.cacheFile.getFullPathName());
    obj->setProperty("peakCount", ready.peakCount);
    obj->setProperty("peaksPerSecond", ready.peaksPerSecond);
    obj->setProperty("latencyOffsetMs", ready.latencyOffsetMs);
    obj->setProperty("driftPpm", ready.driftPpm);
    obj->setProperty("droppedSamples", static_cast<int>(ready.droppedSamples));
    bridge.broadcast("RECORD_RECORDING_READY", juce::var(obj));
}

void broadcastCommitFailure(BridgeServer& bridge, const juce::String& itemId,
                            const juce::String& error)
{
    // A failed commit answers on SAMPLE_SAVED like every other library bake, so
    // the renderer has exactly one correlation path for the result.
    auto* obj = new juce::DynamicObject();
    obj->setProperty("itemId", itemId);
    obj->setProperty("ok", false);
    obj->setProperty("error", error);
    bridge.broadcast("SAMPLE_SAVED", juce::var(obj));
}

// Finalises off the message thread: flushing the writer and waiting for the
// capture callback to quiesce must never block it (ADR 0006).
void scheduleFinalise(recording::PendingFinalise pending, AudioEngine& engine, BridgeServer& bridge,
                      juce::ThreadPool& peakPool, const PeaksCache& cache,
                      const juce::File& directory)
{
    peakPool.addJob(
        [pending, directory, &engine, &bridge, &cache]() mutable
        {
            if (pending.tap != nullptr) pending.tap->waitForQuiescence();
            const bool wrote = pending.writer != nullptr && pending.writer->finish();
            const auto rawFile = pending.rawFile;
            pending.writer.reset();

            const auto fail = [&bridge, &pending, &rawFile](const juce::String& code,
                                                            const juce::String& message)
            {
                rawFile.deleteFile();
                juce::MessageManager::callAsync(
                    [&bridge, sessionId = pending.sessionId, code, message]
                    {
                        controller().reportFailure(sessionId, code, message);
                        broadcastState(bridge);
                    });
            };

            if (pending.errorCode.isNotEmpty())
            {
                fail(pending.errorCode, pending.error);
                return;
            }
            if (! wrote)
            {
                fail("writeFailed", "The recording could not be written");
                return;
            }

            FinishedRecording ready;
            ready.sessionId = pending.sessionId;
            ready.recordingId = pending.recordingId;
            ready.suggestedName = pending.suggestedName;
            ready.file =
                uniqueRecordingWav(directory, sanitiseRecordingFileName(pending.suggestedName));

            recording::FinaliseRequest request;
            request.sourceFile = rawFile;
            request.destinationFile = ready.file;
            request.nominalSampleRate = pending.sampleRate;
            request.measuredSampleRate = pending.measuredSampleRate;
            request.timelineSampleRate = pending.timelineSampleRate;
            request.latencyMs = pending.headTrimMs;
            request.exactDurationMs = pending.exactDurationMs.value_or(0.0);

            const auto result = recording::finaliseRecording(request, engine.getFormatManager());
            rawFile.deleteFile();
            if (! result.ok)
            {
                ready.file.deleteFile();
                fail("writeFailed", result.error);
                return;
            }

            if (pending.cleanup)
            {
                // Before the peaks: the waveform the user reviews has to be the
                // audio that was kept, not what it looked like before cleanup.
                recording::CleanupRequest cleanupRequest;
                cleanupRequest.file = ready.file;
                cleanupRequest.sampleRate = result.sampleRate;
                const auto cleaned =
                    recording::cleanRecording(cleanupRequest, engine.getFormatManager());
                if (! cleaned.ok)
                {
                    // A take that could not be cleaned is still a good take, so the
                    // failure is logged and the original is kept rather than lost.
                    log::warn("recording", "cleanup failed: " + cleaned.error);
                }
            }

            const auto peaks = waveform::computePeaks(ready.file, engine.getFormatManager(),
                                                      waveform::kDefaultPeaksPerSecond);
            if (peaks.peaks.empty())
            {
                ready.file.deleteFile();
                fail("writeFailed", "The recording waveform could not be built");
                return;
            }
            cache.store(ready.file, peaks);

            ready.durationMs = result.durationMs;
            ready.sampleRate = result.sampleRate;
            ready.channelCount = juce::jlimit(1, 2, result.channelCount);
            ready.anchorMs = pending.anchorMs;
            ready.bpm = pending.bpm;
            ready.beatAnchorSec = pending.beatAnchorSec;
            // Only claim the beat count when the file really is that many beats long:
            // a short capture that could not be trimmed to the window would otherwise
            // resolve to a tempo that is not the project's (ADR 0024 rule 2).
            ready.musicalBeats = (! pending.exactDurationMs.has_value() || result.exactLength)
                                     ? pending.musicalBeats
                                     : std::nullopt;
            ready.musical = pending.musical;
            ready.cacheFile = cache.getCacheFilePath(ready.file, waveform::kDefaultPeaksPerSecond);
            ready.peakCount = peaks.bucketsPerLane();
            ready.laneCount = peaks.laneCount;
            ready.peaksPerSecond = effectivePeaksPerSecond(peaks);
            ready.latencyOffsetMs = result.latencyOffsetMs;
            ready.driftPpm = result.driftPpm;
            ready.droppedSamples = pending.droppedSamples;

            juce::MessageManager::callAsync(
                [&bridge, ready]
                {
                    if (controller().getSessionId() != ready.sessionId)
                    {
                        // The session closed while finalising; leave nothing behind.
                        ready.file.deleteFile();
                        return;
                    }
                    discardFinished();
                    finished() = ready;
                    broadcastReady(bridge, ready);
                    controller().enterReview(ready.sessionId, ready.recordingId);
                    broadcastState(bridge);
                });
        });
}
} // namespace

void handleRecordInputsRequest(const juce::var& payload, BridgeServer& bridge)
{
    const bool refresh = static_cast<bool>(payload.getProperty("refresh", false));
    auto* obj = new juce::DynamicObject();
    juce::Array<juce::var> types;
    for (const auto& listing : recording::enumerateCaptureInputs(refresh))
    {
        auto* type = new juce::DynamicObject();
        type->setProperty("name", listing.typeName);
        juce::Array<juce::var> devices;
        for (const auto& device : listing.devices)
            devices.add(device);
        type->setProperty("devices", devices);
        types.add(juce::var(type));
    }
    obj->setProperty("types", types);
    bridge.broadcast("RECORD_INPUTS_LIST", juce::var(obj));
}

void handleRecordSessionOpen(const juce::var& payload, AudioEngine& engine,
                             ProjectState& projectState, BridgeServer& bridge,
                             juce::ThreadPool& peakPool, const PeaksCache& cache,
                             ProjectSession& session)
{
    if (controller().hasSession())
    {
        // Only one record surface can exist, so a live session here is a stale one.
        controller().close(controller().getSessionId());
        discardFinished();
    }

    const auto input = payload.getProperty("input", juce::var());
    const auto typeName = readOptionalString(input, "typeName").value_or(juce::String{});
    const auto deviceName = readOptionalString(input, "deviceName").value_or(juce::String{});
    const auto directory = projectArtifactsBaseDir(session.currentPath, "recordings");

    auto& active = controller();
    active.onStateChanged = [&bridge] { broadcastState(bridge); };
    active.onInputLevel = [&bridge](float peakL, float peakR)
    {
        if (! controller().hasSession()) return;
        auto* obj = new juce::DynamicObject();
        obj->setProperty("sessionId", controller().getSessionId());
        obj->setProperty("peakL", peakL);
        obj->setProperty("peakR", peakR);
        bridge.broadcast("RECORD_INPUT_LEVEL", juce::var(obj));
    };
    active.onCaptureComplete = [&engine, &bridge, &peakPool, &cache,
                                directory](recording::PendingFinalise pending)
    { scheduleFinalise(std::move(pending), engine, bridge, peakPool, cache, directory); };

    const auto sessionId = active.open(engine, projectState, directory, typeName, deviceName);
    log::info("recording", "RECORD_SESSION_OPEN session=" + sessionId + " device=" + deviceName);
    broadcastState(bridge);
}

void handleRecordSessionControl(const juce::var& payload, ProjectState& projectState,
                                BridgeServer& bridge)
{
    const auto sessionId = tryGetRequiredString(payload, "sessionId").value_or(juce::String{});
    const auto action = tryGetRequiredString(payload, "action").value_or(juce::String{});
    if (sessionId.isEmpty() || action.isEmpty()) return;

    auto& active = controller();
    if (action == "selectInput")
    {
        const auto input = payload.getProperty("input", juce::var());
        active.selectInput(sessionId, readOptionalString(input, "typeName").value_or(juce::String{}),
                           readOptionalString(input, "deviceName").value_or(juce::String{}));
    }
    else if (action == "selectChannels")
    {
        active.selectChannels(sessionId,
                              static_cast<int>(tryGetNumber(payload, "firstChannel").value_or(0.0)),
                              static_cast<int>(tryGetNumber(payload, "channelCount").value_or(1.0)));
    }
    else if (action == "setCountInBars")
    {
        active.setCountInBars(sessionId,
                              static_cast<int>(tryGetNumber(payload, "bars").value_or(0.0)));
    }
    else if (action == "setClickEnabled")
    {
        active.setClickEnabled(sessionId,
                               static_cast<bool>(payload.getProperty("enabled", false)));
    }
    else if (action == "setBackingTracks")
    {
        juce::StringArray trackIds;
        if (const auto* ids = payload.getProperty("trackIds", juce::var()).getArray())
        {
            for (const auto& id : *ids)
            {
                if (id.isString()) trackIds.add(id.toString());
            }
        }
        active.setBackingTracks(sessionId, trackIds);
    }
    else if (action == "setBackingGain")
    {
        active.setBackingGain(sessionId, tryGetNumber(payload, "gain").value_or(1.0));
    }
    else if (action == "setInputGain")
    {
        active.setInputGain(sessionId, tryGetNumber(payload, "gainDb").value_or(0.0));
    }
    else if (action == "setRecordingMode")
    {
        active.setRecordingMode(sessionId,
                                tryGetRequiredString(payload, "mode").value_or(juce::String{}));
    }
    else if (action == "setMonitorEnabled")
    {
        active.setMonitorEnabled(sessionId,
                                 static_cast<bool>(payload.getProperty("enabled", false)));
    }
    else if (action == "setCleanupEnabled")
    {
        active.setCleanupEnabled(sessionId,
                                 static_cast<bool>(payload.getProperty("enabled", false)));
    }
    else if (action == "setWindowMode")
    {
        active.setWindowMode(sessionId,
                             tryGetRequiredString(payload, "mode").value_or(juce::String{}));
    }
    else if (action == "start")
    {
        discardFinished();
        active.start(sessionId, "capture-" + juce::Uuid().toDashedString(),
                     nextRecordingName(projectState));
    }
    else if (action == "stop")
    {
        active.stop(sessionId);
    }
    else if (action == "discard")
    {
        discardFinished();
        active.discard(sessionId);
    }
    else
    {
        log::warn("recording", "RECORD_SESSION_CONTROL unknown action=" + action);
        return;
    }
    broadcastState(bridge);
}

void handleRecordSessionClose(const juce::var& payload, BridgeServer& bridge)
{
    // An absent or empty id means "whichever session is open": the dialog sends
    // that when it never adopted an id, and the borrowed engine state still has
    // to come back (ADR 0030, Amendment 5).
    const auto sessionId = readOptionalString(payload, "sessionId").value_or(juce::String{});
    discardFinished();
    controller().close(sessionId);
    const auto label = sessionId.isNotEmpty() ? sessionId : juce::String("<current>");
    log::info("recording", "RECORD_SESSION_CLOSE session=" + label);
    broadcastState(bridge);
}

void handleRecordRecordingSetStereo(const juce::var& payload, AudioEngine& engine,
                                    BridgeServer& bridge, const PeaksCache& cache)
{
    auto& pending = finished();
    const auto recordingId = readOptionalString(payload, "recordingId").value_or(juce::String{});
    if (! pending.has_value()) return;
    if (recordingId.isNotEmpty() && pending->recordingId != recordingId) return;

    const bool enabled = static_cast<bool>(payload.getProperty("enabled", false));
    if (enabled == pending->stereoDuplicated) return;
    // Only a mono capture has a duplicate to offer; a stereo take is already what
    // it is going to be.
    if (enabled && pending->channelCount != 1) return;

    // The other form is built once and then kept: switching back and forth is a
    // decision the user is allowed to change their mind about, and rewriting the
    // file each time would make it feel like it costs something.
    if (pending->alternate.has_value())
    {
        const auto next = *pending->alternate;
        pending->alternate = currentVariant(*pending);
        adoptVariant(*pending, next);
        pending->stereoDuplicated = enabled;
    }
    else
    {
        if (! enabled) return;
        const auto destination = pending->file.getSiblingFile(
            pending->file.getFileNameWithoutExtension() + " (stereo).wav");
        if (! recording::duplicateMonoToStereo(pending->file, destination,
                                               engine.getFormatManager()))
        {
            log::warn("recording", "could not duplicate the take to stereo");
            return;
        }
        const auto peaks = waveform::computePeaks(destination, engine.getFormatManager(),
                                                  waveform::kDefaultPeaksPerSecond);
        if (peaks.peaks.empty())
        {
            destination.deleteFile();
            log::warn("recording", "stereo duplicate has no waveform; keeping the mono take");
            return;
        }
        cache.store(destination, peaks);

        TakeVariant stereo;
        stereo.file = destination;
        stereo.channelCount = 2;
        stereo.cacheFile = cache.getCacheFilePath(destination, waveform::kDefaultPeaksPerSecond);
        stereo.peakCount = peaks.bucketsPerLane();
        stereo.laneCount = peaks.laneCount;
        stereo.peaksPerSecond = effectivePeaksPerSecond(peaks);

        pending->alternate = currentVariant(*pending);
        adoptVariant(*pending, stereo);
        pending->stereoDuplicated = true;
    }

    // The review is auditioning a file that has just been swapped underneath it,
    // so the take is re-announced: the renderer reloads the waveform and plays the
    // form that will actually be saved.
    log::info("recording", juce::String("take now ")
                               + (pending->stereoDuplicated ? "stereo" : "mono") + " for "
                               + pending->recordingId);
    broadcastReady(bridge, *pending);
}

void handleRecordRecordingCommit(const juce::var& payload, AudioEngine& engine,
                                 ProjectState& projectState, BridgeServer& bridge,
                                 juce::ThreadPool& peakPool, const PeaksCache& cache,
                                 const DecodedCache& decodedCache, PeakJobCoordinator& peakJobs,
                                 ProjectSession& session)
{
    const auto itemId = tryGetRequiredString(payload, "itemId").value_or(juce::String{});
    const auto recordingId = tryGetRequiredString(payload, "recordingId").value_or(juce::String{});
    if (itemId.isEmpty() || recordingId.isEmpty()) return;

    auto& pending = finished();
    if (! pending.has_value() || pending->recordingId != recordingId)
    {
        broadcastCommitFailure(bridge, itemId, "That recording is no longer available");
        return;
    }
    if (! pending->file.existsAsFile())
    {
        pending.reset();
        broadcastCommitFailure(bridge, itemId, "The recording file has gone");
        return;
    }

    const auto ready = *pending;
    // The form that was not kept is a working file, not a library item.
    if (pending->alternate.has_value()) pending->alternate->file.deleteFile();
    const auto name = tryGetRequiredString(payload, "name").value_or(ready.suggestedName);
    const auto destination =
        tryGetRequiredString(payload, "destination").value_or(juce::String{"library"});
    const bool toTimeline = destination == "timeline";

    // One transaction covers the item and, for the timeline, the clip: a single
    // Undo removes the whole thing.
    projectState.getUndoManager().beginNewTransaction("Add recording");
    projectState.addLibraryItem(itemId, ready.file.getFullPathName(), ready.file.getFileName(),
                                ready.durationMs, static_cast<int>(ready.sampleRate),
                                ready.channelCount, ready.file.getFullPathName(), {}, "sample", name);
    projectState.setLibraryItemAudioType(itemId, ready.musical ? "music" : "simple");
    projectState.setLibraryItemRecordingOrigin(itemId);
    // The tempo is known, not detected: the recording was played against this
    // project's grid, so it warps like any other music clip (ADR 0030). A simple
    // take gets none of it — no tempo, no beat count, so nothing draws beat
    // markers over material that has no beats.
    if (ready.musical)
    {
        applyManualTempo(itemId, ready.bpm, ready.beatAnchorSec, engine, projectState, bridge,
                         false);
        if (ready.musicalBeats.has_value())
            projectState.setLibraryItemMusicalBeats(itemId, *ready.musicalBeats);
    }

    auto* obj = new juce::DynamicObject();
    obj->setProperty("itemId", itemId);
    obj->setProperty("ok", true);
    obj->setProperty("filePath", ready.file.getFullPathName());
    obj->setProperty("fileName", ready.file.getFileName());
    obj->setProperty("name", name);
    obj->setProperty("durationMs", ready.durationMs);
    obj->setProperty("sampleRate", ready.sampleRate);
    obj->setProperty("channelCount", ready.channelCount);
    obj->setProperty("cachePath", ready.cacheFile.getFullPathName());
    obj->setProperty("peakCount", ready.peakCount);
    obj->setProperty("laneCount", ready.laneCount);
    obj->setProperty("peaksPerSecond", ready.peaksPerSecond);
    obj->setProperty("audioType", ready.musical ? "music" : "simple");
    // The grid travels with the announcement, not only in the LIBRARY_ITEM_ANALYSIS
    // that `applyManualTempo` has already broadcast: that one arrives *before* this
    // message creates the item in the renderer, and analysis for an item the
    // renderer does not have yet is dropped. A recording has no source item to
    // inherit a grid from either, so without this the take would appear with no
    // tempo and no beat markers until the project was reloaded.
    if (ready.musical)
    {
        obj->setProperty("bpm", ready.bpm);
        obj->setProperty("beatAnchorSec", ready.beatAnchorSec);
        if (ready.musicalBeats.has_value()) obj->setProperty("musicalBeats", *ready.musicalBeats);
    }
    obj->setProperty("recordingOrigin", true);
    bridge.broadcast("SAMPLE_SAVED", juce::var(obj));

    if (toTimeline)
    {
        // The renderer normally resolves the destination — it owns selection and
        // scrolling — but the policy lives here too so a commit that names no track
        // still lands sensibly: a recording only joins the selected track when that
        // track is empty, otherwise it gets one of its own rather than stacking on
        // top of what is already arranged there.
        auto trackId = readOptionalString(payload, "trackId").value_or(juce::String{});
        if (trackId.isEmpty() || ! projectState.hasTrack(trackId))
        {
            const auto selected = projectState.getViewSelectedTrack();
            trackId = projectState.hasTrack(selected)
                              && projectState.getTrackClipIds(selected).isEmpty()
                          ? selected
                          : juce::String{};
        }
        if (trackId.isEmpty())
        {
            trackId = juce::Uuid().toDashedString();
            projectState.addTrack(trackId);
        }

        auto* clipPayload = new juce::DynamicObject();
        clipPayload->setProperty("trackId", trackId);
        clipPayload->setProperty(
            "clipId", readOptionalString(payload, "clipId").value_or(juce::Uuid().toDashedString()));
        clipPayload->setProperty("libraryItemId", itemId);
        clipPayload->setProperty("positionMs", ready.anchorMs);
        clipPayload->setProperty("durationMs", ready.durationMs);
        clipPayload->setProperty("waveform", true);
        handleClipAdd(juce::var(clipPayload), engine, projectState, bridge, peakPool, cache,
                      decodedCache, peakJobs);
    }

    bridge.broadcast("PROJECT_STATE", buildProjectStateEnvelope(session, projectState, false));
    broadcastEditUndoState(projectState, bridge);
    log::info("recording", "recording committed item=" + itemId + " destination=" + destination);

    pending.reset();
    controller().discard(controller().getSessionId());
    broadcastState(bridge);
}

} // namespace silverdaw
