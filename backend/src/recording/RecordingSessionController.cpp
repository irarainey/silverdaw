#include "RecordingSessionController.h"

#include "AudioEngine.h"
#include "Log.h"
#include "ProjectState.h"

#include <cmath>

namespace silverdaw::recording
{
namespace
{
constexpr int kTimerIntervalMs = 33;
constexpr int kBeatsPerBar = 4;
// Below this the wall-clock span is too short for the drift ratio to mean
// anything, so the nominal rate is used unchanged.
constexpr double kMinDriftMeasurementSeconds = 5.0;

juce::String makeId(const juce::String& prefix)
{
    return prefix + juce::Uuid().toDashedString();
}

/** The tracks the arrangement is currently playing — mute and solo already
 *  folded in — used to seed a fresh session's backing selection. */
juce::StringArray audibleTrackIds(const ProjectState& projectState)
{
    juce::StringArray audible;
    for (const auto& trackId : projectState.getTrackIds())
    {
        if (projectState.getEffectiveTrackGain(trackId) > 0.0F) audible.add(trackId);
    }
    return audible;
}
} // namespace

RecordingSessionController::RecordingSessionController() = default;

RecordingSessionController::~RecordingSessionController()
{
    stopTimer();
    closeDevice();
}

juce::String RecordingSessionController::open(AudioEngine& engineRef, ProjectState& projectStateRef,
                                              const juce::File& directory,
                                              const juce::String& typeName,
                                              const juce::String& deviceName)
{
    if (session.has_value())
    {
        // Only one record surface exists, so a second open means the previous
        // session was abandoned without a close — a renderer that never adopted a
        // session id cannot send one. Retiring it here is what stops the borrowed
        // click, backing, loop and monitor from outliving the dialog.
        log::warn("recording", "opening over abandoned session " + session->sessionId);
        close(session->sessionId);
    }

    engine = &engineRef;
    projectState = &projectStateRef;
    recordingsDirectory = directory;

    Session fresh;
    fresh.sessionId = makeId("rec-");
    // The click starts off, whatever the timeline is doing: a fresh dialog offers
    // no count-in and no click, and the performer asks for one if they want it.
    // The session still hands the project's own metronome setting back on close.
    fresh.clickEnabled = false;
    // Start from what the timeline is already playing, so the default backing
    // sounds like the arrangement does; from there the selection is the session's
    // own, and a muted track can be ticked in for a single take.
    fresh.backingTrackIds = audibleTrackIds(projectStateRef);
    session = fresh;

    openDevice(typeName, deviceName);
    refreshWindow();
    applySessionMetronome();
    applySessionLoop();
    applySessionBackingGain();
    applySessionMonitor();
    startTimer(kTimerIntervalMs);
    if (onStateChanged) onStateChanged();
    return session->sessionId;
}

void RecordingSessionController::close(const juce::String& sessionId)
{
    if (! session.has_value()) return;
    // An empty id means "whichever session is open". The renderer sends that when
    // it never adopted an id — a state broadcast it had already noted as closed,
    // say — and the borrowed engine state has to come back either way.
    if (sessionId.isNotEmpty() && session->sessionId != sessionId) return;

    if (session->status == "countIn" || session->status == "recording")
    {
        // An abandoned session leaves nothing behind, not even a file.
        if (engine != nullptr) engine->stop();
        tap.setWriter(nullptr);
        tap.waitForQuiescence();
        if (writer != nullptr) writer->abort();
    }
    writer.reset();
    stopTimer();
    closeDevice();
    session.reset();
    // Whatever the session borrowed the click for — forced on for a count-in, off
    // through review — the project's own setting is what survives the dialog.
    applySessionMetronome();
    // Same for the backing: audibility goes straight back to what the project
    // says, whether the session had silenced a track or brought a muted one in.
    applySessionBacking();
    // The project's loop is its own again, exactly as it was armed.
    applySessionLoop();
    // And the backing level: the arrangement plays at its own volume again.
    applySessionBackingGain();
    // The monitor goes with it — nothing should be listening to an input once the
    // dialog has gone.
    applySessionMonitor();
    if (onStateChanged) onStateChanged();
}

void RecordingSessionController::openDevice(const juce::String& typeName,
                                            const juce::String& deviceName)
{
    closeDevice();
    if (! session.has_value()) return;

    juce::String error;
    const auto result = device.open(typeName, deviceName, error);
    if (result != CaptureOpenResult::ok)
    {
        session->input.reset();
        session->status = "error";
        session->errorCode = result == CaptureOpenResult::noDevice ? "noInput" : "openFailed";
        session->error = error.isNotEmpty() ? error : juce::String("No audio input is available");
        return;
    }

    RecordingInputInfo info;
    info.typeName = device.getTypeName();
    info.deviceName = device.getDeviceName();
    info.channelNames = device.getInputChannelNames();
    info.sampleRate = device.getSampleRate();
    info.inputLatencyMs = device.getInputLatencyMs();
    session->input = info;
    session->firstChannel = 0;
    session->channelCount = juce::jmin(2, juce::jmax(1, device.getInputChannelCount()));
    session->status = "idle";
    session->errorCode = {};
    session->error = {};

    tap.setChannelSelection(session->firstChannel, session->channelCount);
    tap.setGain(juce::Decibels::decibelsToGain(static_cast<float>(session->inputGainDb)));
    // The tap feeds the monitor for as long as the device is open; whether any of
    // it is heard is the source's own decision.
    if (engine != nullptr) tap.setMonitorSink(&engine->getInputMonitor());
    tap.resetCaptureStats();
    device.start(tap);
}

void RecordingSessionController::closeDevice()
{
    tap.setWriter(nullptr);
    tap.setMonitorSink(nullptr);
    if (engine != nullptr) engine->getInputMonitor().setEnabled(false);
    if (device.isOpen())
    {
        device.stop();
        device.close();
    }
}

bool RecordingSessionController::selectInput(const juce::String& sessionId,
                                             const juce::String& typeName,
                                             const juce::String& deviceName)
{
    if (! session.has_value() || session->sessionId != sessionId) return false;
    if (session->status == "countIn" || session->status == "recording") return false;

    openDevice(typeName, deviceName);
    if (onStateChanged) onStateChanged();
    return true;
}

bool RecordingSessionController::selectChannels(const juce::String& sessionId, int firstChannel,
                                                int channelCount)
{
    if (! session.has_value() || session->sessionId != sessionId) return false;
    if (session->status == "countIn" || session->status == "recording") return false;

    const int available = juce::jmax(1, device.getInputChannelCount());
    const int count = juce::jlimit(1, 2, channelCount);
    session->firstChannel = juce::jlimit(0, juce::jmax(0, available - count), firstChannel);
    session->channelCount = juce::jmin(count, available - session->firstChannel);
    tap.setChannelSelection(session->firstChannel, session->channelCount);
    if (onStateChanged) onStateChanged();
    return true;
}

bool RecordingSessionController::setCountInBars(const juce::String& sessionId, int bars)
{
    if (! session.has_value() || session->sessionId != sessionId) return false;
    session->countInBars = juce::jlimit(0, kMaxCountInBars, bars);
    if (onStateChanged) onStateChanged();
    return true;
}

bool RecordingSessionController::setClickEnabled(const juce::String& sessionId, bool enabled)
{
    if (! session.has_value() || session->sessionId != sessionId) return false;
    session->clickEnabled = enabled;
    // Audible immediately, including mid-take: the click is monitoring, and a
    // performer who wants it gone should not have to stop to lose it.
    applySessionMetronome();
    if (onStateChanged) onStateChanged();
    return true;
}

bool RecordingSessionController::setBackingTracks(const juce::String& sessionId,
                                                  const juce::StringArray& trackIds)
{
    if (! session.has_value() || session->sessionId != sessionId) return false;
    // Mid-take the backing is what the performer is playing to; changing it under
    // them would leave a take recorded against something that no longer exists.
    if (session->status == "countIn" || session->status == "recording") return false;

    juce::StringArray resolved;
    if (projectState != nullptr)
    {
        for (const auto& trackId : trackIds)
        {
            if (projectState->hasTrack(trackId) && ! resolved.contains(trackId))
                resolved.add(trackId);
        }
    }
    session->backingTrackIds = resolved;
    applySessionBacking();
    if (onStateChanged) onStateChanged();
    return true;
}

bool RecordingSessionController::setBackingGain(const juce::String& sessionId, double gain)
{
    if (! session.has_value() || session->sessionId != sessionId) return false;
    session->backingGain = juce::jlimit(0.0, 1.0, gain);
    // Live, including mid-take: the backing level is monitoring, and a performer
    // who cannot hear themselves over it should not have to stop to fix it.
    applySessionBackingGain();
    if (onStateChanged) onStateChanged();
    return true;
}

bool RecordingSessionController::setInputGain(const juce::String& sessionId, double gainDb)
{
    if (! session.has_value() || session->sessionId != sessionId) return false;
    session->inputGainDb = juce::jlimit(kMinInputGainDb, kMaxInputGainDb, gainDb);
    tap.setGain(juce::Decibels::decibelsToGain(static_cast<float>(session->inputGainDb)));
    if (onStateChanged) onStateChanged();
    return true;
}

bool RecordingSessionController::setRecordingMode(const juce::String& sessionId,
                                                   const juce::String& mode)
{
    if (! session.has_value() || session->sessionId != sessionId) return false;
    if (mode != "music" && mode != "simple") return false;
    // Nothing about the capture changes: the mode only decides what the finished
    // file is committed as, so it can be changed right up to the commit.
    session->recordingMode = mode;
    if (onStateChanged) onStateChanged();
    return true;
}

bool RecordingSessionController::setMonitorEnabled(const juce::String& sessionId, bool enabled)
{
    if (! session.has_value() || session->sessionId != sessionId) return false;
    session->monitorEnabled = enabled;
    applySessionMonitor();
    if (onStateChanged) onStateChanged();
    return true;
}

bool RecordingSessionController::setCleanupEnabled(const juce::String& sessionId, bool enabled)
{
    if (! session.has_value() || session->sessionId != sessionId) return false;
    session->cleanupEnabled = enabled;
    if (onStateChanged) onStateChanged();
    return true;
}

bool RecordingSessionController::setWindowMode(const juce::String& sessionId,
                                                const juce::String& mode)
{
    if (! session.has_value() || session->sessionId != sessionId) return false;
    if (mode != "playhead" && mode != "start" && mode != "selection") return false;
    session->windowMode = mode;
    refreshWindow();
    if (onStateChanged) onStateChanged();
    return true;
}

double RecordingSessionController::barLengthMs() const
{
    const double bpm = projectState != nullptr ? projectState->getBpm() : 120.0;
    return 60000.0 / juce::jmax(1.0, bpm) * kBeatsPerBar;
}

void RecordingSessionController::refreshWindow()
{
    if (! session.has_value() || engine == nullptr || projectState == nullptr) return;
    if (session->status == "countIn" || session->status == "recording") return;

    const auto selection = projectState->getViewTimelineSelection();
    const bool usable = selection.has_value() && selection->endMs > selection->startMs;
    const auto window = resolveRecordWindow(session->windowMode,
                                            engine->getPositionMs(),
                                            usable,
                                            usable ? selection->startMs : 0.0,
                                            usable ? selection->endMs : 0.0);
    session->windowMode = window.mode;
    session->anchorMs = window.anchorMs;
    session->windowEndMs = window.endMs;
}

bool RecordingSessionController::start(const juce::String& sessionId,
                                       const juce::String& fileBaseName,
                                       const juce::String& suggestedName)
{
    if (! session.has_value() || session->sessionId != sessionId) return false;
    if (engine == nullptr || projectState == nullptr) return false;
    if (session->status == "countIn" || session->status == "recording") return false;
    if (! session->input.has_value() || ! device.isOpen())
    {
        session->status = "error";
        if (session->errorCode.isEmpty()) session->errorCode = "noInput";
        if (onStateChanged) onStateChanged();
        return false;
    }

    refreshWindow();

    const double countInMs = session->countInBars * barLengthMs();
    session->anchorMs =
        resolveCountInAnchorMs(session->anchorMs, countInMs, session->windowEndMs.has_value());

    const double sampleRate = device.getSampleRate();
    const double windowSeconds =
        session->windowEndMs.has_value()
            ? juce::jmax(1.0, (*session->windowEndMs - session->anchorMs) / 1000.0)
            : kMaxRecordingSeconds;
    const auto expectedSamples =
        static_cast<juce::int64>((windowSeconds + countInMs / 1000.0 + 1.0) * sampleRate);

    auto pending = std::make_shared<RecordingWriter>();
    juce::String error;
    const auto file = recordingsDirectory.getChildFile(fileBaseName + ".wav");
    if (! pending->start(file, sampleRate, session->channelCount, expectedSamples, error))
    {
        session->status = "error";
        session->errorCode = error.containsIgnoreCase("disk space") ? "diskFull" : "writeFailed";
        session->error = error;
        if (onStateChanged) onStateChanged();
        return false;
    }

    writer = pending;
    session->recordingId = makeId("rrec-");
    session->suggestedName = suggestedName;
    session->errorCode = {};
    session->error = {};

    // Count-in is the existing metronome over a preroll, not a new audio path:
    // the transport simply starts early and the preroll is trimmed at finalise.
    session->transportStartMs = juce::jmax(0.0, session->anchorMs - countInMs);

    tap.resetCaptureStats();
    tap.setMaxSamples(static_cast<juce::int64>(kMaxRecordingSeconds * sampleRate));
    tap.setWriter(writer->getThreadedWriter());

    // Status (and so the click) is settled before the transport rolls: a count-in
    // whose first beat is at the preroll's start must not miss it by a block.
    session->status = session->transportStartMs < session->anchorMs ? "countIn" : "recording";
    applySessionMetronome();

    engine->setPositionMs(session->transportStartMs, true);
    engine->play();
    session->rollTicks = juce::Time::getHighResolutionTicks();
    if (onStateChanged) onStateChanged();
    return true;
}

bool RecordingSessionController::stop(const juce::String& sessionId)
{
    if (! session.has_value() || session->sessionId != sessionId) return false;
    if (session->status != "countIn" && session->status != "recording") return false;

    finishCapture({}, {});
    return true;
}

void RecordingSessionController::finishCapture(const juce::String& errorCode,
                                               const juce::String& message)
{
    if (! session.has_value()) return;

    if (engine != nullptr) engine->stop();

    // Detach here, but let the caller flush the writer: draining the ThreadedWriter
    // and waiting for the capture callback to quiesce must not block the message
    // thread (ADR 0006).
    tap.setWriter(nullptr);

    const double sampleRate = device.getSampleRate();
    const auto captured = tap.getCapturedSamples();
    const auto spanTicks = tap.getLastBlockTicks() - tap.getFirstBlockTicks();
    const double spanSeconds =
        spanTicks > 0 ? static_cast<double>(spanTicks)
                            / static_cast<double>(juce::Time::getHighResolutionTicksPerSecond())
                      : 0.0;

    PendingFinalise pending;
    pending.sessionId = session->sessionId;
    pending.recordingId = session->recordingId;
    pending.suggestedName = session->suggestedName;
    pending.writer = writer;
    pending.tap = &tap;
    pending.rawFile = writer != nullptr ? writer->getFile() : juce::File();
    pending.sampleRate = sampleRate;
    pending.channelCount = session->channelCount;
    pending.droppedSamples = tap.getDroppedSamples();
    pending.anchorMs = session->anchorMs;
    pending.bpm = projectState != nullptr ? projectState->getBpm() : 120.0;
    pending.musical = recordingModeIsMusical(session->recordingMode);
    pending.cleanup = session->cleanupEnabled;

    // The performer heard the arrangement late and Silverdaw received them late,
    // so the round trip is trimmed off the head along with the count-in.
    const double latencyMs = (session->input.has_value() ? session->input->inputLatencyMs : 0.0)
                             + (engine != nullptr ? engine->getOutputLatencyMs() : 0.0);
    pending.latencyMs = latencyMs;
    pending.headTrimMs = (session->anchorMs - session->transportStartMs) + latencyMs;

    // Only trust the measured rate over a long enough span; one buffer of the
    // captured total was never bracketed by the two stamps.
    const auto unbracketed = static_cast<juce::int64>(device.getBufferSize());
    pending.measuredSampleRate =
        spanSeconds >= kMinDriftMeasurementSeconds && captured > unbracketed
            ? static_cast<double>(captured - unbracketed) / spanSeconds
            : sampleRate;

    const double beatMs = 60000.0 / juce::jmax(1.0, pending.bpm);
    const double anchorBeats = session->anchorMs / beatMs;
    // Seconds from the file's start to the first whole beat of the project grid.
    pending.beatAnchorSec = (std::ceil(anchorBeats) - anchorBeats) * beatMs / 1000.0;

    // A beat count is claimed only when the window makes it true by construction
    // (ADR 0024); a hand-stopped recording carries tempo but no bar count. The
    // capture always overruns the window end by however long the auto-stop took to
    // reach the message thread, so the finalised file is trimmed back to the exact
    // musical length — otherwise the beat count divided by the file's real duration
    // would resolve to a tempo slightly off the project's.
    if (errorCode.isEmpty() && pending.musical && session->windowEndMs.has_value())
    {
        const double windowBeats = (*session->windowEndMs - session->anchorMs) / beatMs;
        const double rounded = std::round(windowBeats);
        if (rounded >= 1.0 && std::abs(windowBeats - rounded) * beatMs < 2.0)
        {
            pending.musicalBeats = static_cast<int>(rounded);
            pending.exactDurationMs = rounded * beatMs;
        }
    }

    juce::String failure = errorCode;
    juce::String failureMessage = message;
    if (failure.isEmpty() && ! tap.hasSeenAnySignal())
    {
        // A device that opens and yields pure digital silence is the signature of
        // absent Windows microphone consent, not of a quiet performance.
        failure = "silentInput";
        failureMessage = "The input delivered no signal at all";
    }
    if (failure.isEmpty() && captured <= 0)
    {
        failure = "writeFailed";
        failureMessage = "Nothing was captured";
    }
    if (failure.isEmpty() && tap.hasHitLengthCap())
    {
        pending.errorCode = "lengthCap";
        pending.error = "The recording reached the maximum length and was stopped";
    }
    else if (failure.isNotEmpty())
    {
        pending.errorCode = failure;
        pending.error = failureMessage;
    }

    writer.reset();
    session->status = failure.isEmpty() ? "finalising" : "error";
    session->errorCode = failure.isEmpty() ? juce::String() : failure;
    session->error = failure.isEmpty() ? juce::String() : failureMessage;
    // The take is over: whatever the count-in borrowed goes back to the project.
    applySessionMetronome();
    if (onStateChanged) onStateChanged();
    if (onCaptureComplete) onCaptureComplete(std::move(pending));
}

bool RecordingSessionController::discard(const juce::String& sessionId)
{
    if (! session.has_value() || session->sessionId != sessionId) return false;

    session->recordingId = {};
    session->status = device.isOpen() ? "idle" : "error";
    session->errorCode = device.isOpen() ? juce::String() : session->errorCode;
    session->error = device.isOpen() ? juce::String() : session->error;
    applySessionMetronome();
    refreshWindow();
    if (onStateChanged) onStateChanged();
    return true;
}

/** Point the engine's click at whatever the session's current status calls for.
 *  With no session left, that is simply the project's own setting. */
void RecordingSessionController::applySessionMetronome()
{
    if (engine == nullptr) return;
    const bool projectEnabled = projectState != nullptr && projectState->getMetronomeEnabled();
    engine->setMetronomeEnabled(
        session.has_value() ? sessionMetronomeEnabled(session->status, session->clickEnabled)
                            : projectEnabled);
}

/** Silence the tracks the session is not playing along to, bring in the ones it
 *  is, and hand audibility back to the project when there is no session.
 *  Engine-only, so nothing here touches the project's mute or solo — or marks
 *  the project as edited. */
void RecordingSessionController::applySessionBacking()
{
    if (engine == nullptr || projectState == nullptr) return;

    std::vector<std::pair<juce::String, bool>> audibility;
    const auto trackIds = projectState->getTrackIds();
    audibility.reserve(static_cast<std::size_t>(trackIds.size()));
    for (const auto& trackId : trackIds)
    {
        const bool projectAudible = projectState->getEffectiveTrackGain(trackId) > 0.0F;
        const bool selected = session.has_value() && session->backingTrackIds.contains(trackId);
        audibility.emplace_back(
            trackId, backingTrackAudible(session.has_value(), selected, projectAudible));
    }
    engine->setTracksAudible(audibility);
}

/** Hold the project's loop off for as long as the dialog is open, and hand it
 *  back on close. A take over a selected range has to stop at the end of that
 *  range; a wrapping transport would carry the capture round again and never
 *  reach the stop check (ADR 0030, Amendment 5). Engine-only: the range itself
 *  stays exactly as the project armed it. */
void RecordingSessionController::applySessionLoop()
{
    if (engine == nullptr) return;
    engine->setTimelineLoopSuspended(session.has_value());
}

/** Trim the arrangement to the session's backing level, and hand it back at
 *  unity when there is no session. Engine-only, ahead of the click and the
 *  preview voice, so neither the count-in nor the review audition is affected. */
void RecordingSessionController::applySessionBackingGain()
{
    if (engine == nullptr) return;
    engine->setArrangementMonitorGain(static_cast<float>(
        sessionBackingGain(session.has_value(), session.has_value() ? session->backingGain : 1.0)));
}

/** Route the capture into the engine's monitor source, or unhook it. The tap
 *  always feeds the sink while a device is open; the source's own enable is what
 *  decides audibility, so toggling monitoring never has to touch the capture
 *  thread's routing (ADR 0030, Amendment 1). */
void RecordingSessionController::applySessionMonitor()
{
    if (engine == nullptr) return;
    auto& monitor = engine->getInputMonitor();
    monitor.setEnabled(sessionMonitorAudible(session.has_value(),
                                             session.has_value() && session->monitorEnabled,
                                             session.has_value() ? session->status
                                                                 : juce::String()));
}

void RecordingSessionController::enterReview(const juce::String& sessionId,
                                             const juce::String& recordingId)
{
    if (! session.has_value() || session->sessionId != sessionId) return;
    if (session->recordingId != recordingId) return;
    session->status = "review";
    applySessionMetronome();
    applySessionMonitor();
    if (onStateChanged) onStateChanged();
}

void RecordingSessionController::reportFailure(const juce::String& sessionId,
                                               const juce::String& errorCode,
                                               const juce::String& message)
{
    if (! session.has_value() || session->sessionId != sessionId) return;
    session->status = "error";
    session->errorCode = errorCode;
    session->error = message;
    if (onStateChanged) onStateChanged();
}

void RecordingSessionController::timerCallback()
{
    if (! session.has_value()) return;

    float peakL = 0.0F;
    float peakR = 0.0F;
    tap.consumePeaks(peakL, peakR);
    if (onInputLevel) onInputLevel(peakL, peakR);

    const bool rolling = session->status == "countIn" || session->status == "recording";
    if (! rolling) return;

    if (tap.wasDeviceStopped())
    {
        const auto detail = tap.getDeviceError();
        finishCapture("deviceLost",
                      detail.isNotEmpty() ? detail : juce::String("The audio input was disconnected"));
        return;
    }

    const double positionMs = engine != nullptr ? engine->getPositionMs() : 0.0;
    if (session->status == "countIn" && positionMs >= session->anchorMs)
    {
        // The count-in only borrows the metronome; `setStatus` hands it straight
        // back, so the click through the take itself is the project's setting.
        setStatus("recording");
    }

    if (tap.hasHitLengthCap()
        || (session->windowEndMs.has_value() && positionMs >= *session->windowEndMs))
    {
        finishCapture({}, {});
        return;
    }

    // Levels stream every tick; the state envelope only needs to keep the elapsed
    // readout honest, so it goes out at a fraction of that rate.
    if (++stateTicks >= 6)
    {
        stateTicks = 0;
        if (onStateChanged) onStateChanged();
    }
}

void RecordingSessionController::setStatus(const juce::String& status)
{
    if (! session.has_value() || session->status == status) return;
    session->status = status;
    // The click follows the status: forced on for a count-in, off through review,
    // the project's own setting everywhere else.
    applySessionMetronome();
    // And so does the monitor: audible while you are performing, silent once the
    // take is playing back to you.
    applySessionMonitor();
    if (onStateChanged) onStateChanged();
}

juce::String RecordingSessionController::getSessionId() const
{
    return session.has_value() ? session->sessionId : juce::String();
}

juce::String RecordingSessionController::getStatus() const
{
    return session.has_value() ? session->status : juce::String("idle");
}

juce::String RecordingSessionController::getPendingRecordingId() const
{
    return session.has_value() ? session->recordingId : juce::String();
}

RecordingStateSnapshot RecordingSessionController::getSnapshot() const
{
    RecordingStateSnapshot snapshot;
    if (! session.has_value()) return snapshot;

    snapshot.sessionId = session->sessionId;
    snapshot.status = session->status;
    snapshot.input = session->input;
    snapshot.firstChannel = session->firstChannel;
    snapshot.channelCount = session->channelCount;
    snapshot.countInBars = session->countInBars;
    snapshot.clickEnabled = session->clickEnabled;
    snapshot.backingTrackIds = session->backingTrackIds;
    snapshot.backingGain = session->backingGain;
    snapshot.inputGainDb = session->inputGainDb;
    snapshot.recordingMode = session->recordingMode;
    snapshot.monitorEnabled = session->monitorEnabled;
    snapshot.cleanupEnabled = session->cleanupEnabled;
    snapshot.windowMode = session->windowMode;
    snapshot.anchorMs = session->anchorMs;
    snapshot.windowEndMs = session->windowEndMs;
    snapshot.errorCode = session->errorCode;
    snapshot.error = session->error;
    snapshot.droppedSamples = tap.getDroppedSamples();

    if (projectState != nullptr)
    {
        const auto selection = projectState->getViewTimelineSelection();
        snapshot.hasSelection = selection.has_value() && selection->endMs > selection->startMs;
    }

    const double sampleRate = juce::jmax(1.0, device.getSampleRate());
    const double capturedMs = static_cast<double>(tap.getCapturedSamples()) * 1000.0 / sampleRate;
    const double countInMs = session->anchorMs - session->transportStartMs;
    if (session->status == "countIn")
    {
        const double elapsed = engine != nullptr
                                   ? juce::jmax(0.0, engine->getPositionMs() - session->transportStartMs)
                                   : 0.0;
        const double bar = juce::jmax(1.0, barLengthMs());
        snapshot.countInBarsRemaining =
            juce::jlimit(0, 2, static_cast<int>(std::ceil((countInMs - elapsed) / bar)));
        snapshot.recordedMs = 0.0;
    }
    else
    {
        snapshot.recordedMs = juce::jmax(0.0, capturedMs - countInMs);
    }
    return snapshot;
}

} // namespace silverdaw::recording
