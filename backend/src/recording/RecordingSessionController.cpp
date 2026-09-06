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
        if (engine != nullptr)
        {
            engine->cancelCountInClick();
            engine->stop();
        }
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

    const double countInMs = countInLengthMs(session->countInBars, barLengthMs());

    const double sampleRate = device.getSampleRate();
    const double windowSeconds =
        session->windowEndMs.has_value()
            ? juce::jmax(1.0, (*session->windowEndMs - session->anchorMs) / 1000.0)
            : kMaxRecordingSeconds;
    const auto expectedSamples = static_cast<juce::int64>((windowSeconds + 1.0) * sampleRate);

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

    // The take starts exactly where the user asked. A count-in no longer moves the
    // transport, so there is no preroll in front of the anchor and nothing to trim
    // but the round-trip latency (ADR 0030, Amendment 11).
    session->transportStartMs = session->anchorMs;
    session->countInMs = countInMs;

    tap.resetCaptureStats();
    tap.setMaxSamples(static_cast<juce::int64>(kMaxRecordingSeconds * sampleRate));

    if (countInMs > 0.0)
    {
        // Count in from a standstill: the playhead sits on the anchor while the click
        // counts, and nothing is captured until it finishes — a count-in is not part of
        // the performance. Status (and so the click) is settled first so the count's
        // first beat is not missed by a block.
        session->status = "countIn";
        applySessionMetronome();
        // Parked outright rather than seeked: a seek requested while the transport is
        // rolling is deferred behind an output fade, which would leave the project
        // playing on under the count.
        engine->parkTransportAt(session->anchorMs);
        engine->startCountInClick(session->countInBars * kBeatsPerBar);
    }
    else
    {
        session->status = "recording";
        applySessionMetronome();
        tap.setWriter(writer->getThreadedWriter());
        if (! beginTransport())
        {
            tap.setWriter(nullptr);
            tap.waitForQuiescence();
            writer->abort();
            writer.reset();
            session->status = "error";
            session->errorCode = "transportFailed";
            session->error = "Playback could not start, so the take was not begun.";
            if (onStateChanged) onStateChanged();
            return false;
        }
    }

    session->rollTicks = juce::Time::getHighResolutionTicks();
    if (onStateChanged) onStateChanged();
    return true;
}

/** The count-in has finished: capture and the arrangement both start, together, on
 *  the anchor. Called from the timer tick that saw the click expire. */
void RecordingSessionController::beginRecordingAfterCountIn()
{
    if (! session.has_value() || engine == nullptr || writer == nullptr) return;

    tap.resetCaptureStats();
    tap.setWriter(writer->getThreadedWriter());
    // `setStatus` hands the borrowed click straight back, so the click through the
    // take itself is the session's own setting.
    setStatus("recording");
    if (! beginTransport())
    {
        tap.setWriter(nullptr);
        tap.waitForQuiescence();
        writer->abort();
        writer.reset();
        session->errorCode = "transportFailed";
        session->error = "Playback could not start, so the take was not begun.";
        setStatus("error");
        return;
    }
    session->rollTicks = juce::Time::getHighResolutionTicks();
}

/** Opens the transport at the anchor and latches the play the take belongs to, so
 *  finalisation only trusts a start stamp from this very play. */
bool RecordingSessionController::beginTransport()
{
    if (engine == nullptr || ! session.has_value()) return false;
    if (! engine->playFromAnchorForRecording(session->anchorMs))
    {
        silverdaw::log::warn("recording", "transport did not start; take abandoned");
        return false;
    }
    session->playEpoch = engine->getPlayEpoch();
    return true;
}

/**
 * Wall-clock gap between capture starting and the arrangement actually starting,
 * in milliseconds, signed.
 *
 * Positive means capture was running before the transport opened — the usual case,
 * because the writer is attached first and `play()` then spends real time priming
 * read-ahead buffers and the plugin pipeline, possibly followed by a silent wake
 * pre-roll on the audio thread. Negative means the first captured block landed after
 * the transport's first advancing block, which is entirely normal when the two
 * devices' callbacks happen to interleave that way; it must NOT be clamped away or
 * every such take is pushed early by up to a full input period.
 *
 * Zero when either end is unavailable, which leaves the plain round-trip trim.
 */
double RecordingSessionController::measuredTransportSkewMs() const
{
    if (engine == nullptr || ! session.has_value()) return 0.0;

    std::uint32_t epoch = 0;
    const auto transportTicks = engine->getTransportStartTicks(&epoch);
    const auto captureTicks = tap.getFirstBlockTicks();
    // A stamp from any play but this take's says nothing about this take's start.
    if (transportTicks <= 0 || captureTicks <= 0 || epoch != session->playEpoch) return 0.0;

    const auto perSecond = juce::Time::getHighResolutionTicksPerSecond();
    if (perSecond <= 0) return 0.0;
    return static_cast<double>(transportTicks - captureTicks) * 1000.0
           / static_cast<double>(perSecond);
}

bool RecordingSessionController::stop(const juce::String& sessionId)
{
    if (! session.has_value() || session->sessionId != sessionId) return false;
    if (session->status != "countIn" && session->status != "recording") return false;

    if (session->status == "countIn")
    {
        // Nothing has been captured yet, so there is no take to finalise — stopping
        // during the count is a change of mind, not a failed recording. Finalising a
        // zero-sample file here would report "the input delivered no signal", which is
        // both wrong and alarming.
        abandonCountIn();
        return true;
    }

    finishCapture({}, {});
    return true;
}

/** Drop a take that never started: cancel the click, throw the empty file away and go
 *  back to idle exactly as if Record had not been pressed. */
void RecordingSessionController::abandonCountIn()
{
    if (! session.has_value()) return;

    if (engine != nullptr)
    {
        engine->cancelCountInClick();
        engine->stop();
    }
    tap.setWriter(nullptr);
    if (writer != nullptr) writer->abort();
    writer.reset();

    session->recordingId = {};
    setStatus(device.isOpen() ? "idle" : "error");
    refreshWindow();
    if (onStateChanged) onStateChanged();
}

void RecordingSessionController::finishCapture(const juce::String& errorCode,
                                               const juce::String& message)
{
    if (! session.has_value()) return;

    if (engine != nullptr)
    {
        engine->cancelCountInClick();
        engine->stop();
    }

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

    // The performer heard the arrangement late and Silverdaw received them late, so the
    // round trip is trimmed off the head. There is no count-in preroll to trim any more:
    // the count-in clicks with the transport parked and capture only starts after it.
    //
    // Plugin delay compensation is deliberately NOT part of this sum. `primePluginPipeline`
    // pushes the alignment through the delay lines before the gate opens (ADR 0026), so the
    // first live block already carries anchor audio and the performer never waits out the
    // alignment. `PlayheadEmitter` subtracts it only because the raw sample counter is run
    // ahead to compensate — that is a counter offset, not an audible delay. Adding it here
    // would drag every take early by the whole alignment.
    const double latencyMs = (session->input.has_value() ? session->input->inputLatencyMs : 0.0)
                             + (engine != nullptr ? engine->getOutputLatencyMs() : 0.0);
    pending.latencyMs = latencyMs;
    // Capture is attached before `play()` is called, but `play()` primes read-ahead buffers and
    // the plugin pipeline on the message thread and may then sit through a silent wake pre-roll
    // on the audio thread — none of which moves the playhead. The take is late by that gap on
    // top of the round trip, and it is far too big to ignore: priming runs to a budget of
    // seconds and the wake pre-roll alone is 250 ms. Measure it from the two ends rather than
    // assuming capture and the transport started together.
    //
    // The skew stays SIGNED. The first written input block landing after the first advancing
    // output block is entirely normal, and clamping that to zero would push the take early by
    // up to a full input period. Only the combined trim is floored at zero.
    const double skewMs = measuredTransportSkewMs();
    pending.headTrimMs = juce::jmax(0.0, latencyMs + skewMs);

    // Only trust the measured rate over a long enough span. The two stamps are taken at the
    // start of their blocks, so they bracket every written block except the last, whose real
    // length is what must come off the total — the configured buffer size is not a safe
    // stand-in, since JUCE allows the block size to vary and the length cap can shorten it.
    // Dropped blocks disqualify the measurement outright: their wall time is inside the span
    // while their samples are not in the total, which biases the rate low, and resampling a
    // file that has holes in it does not repair the holes anyway.
    const auto lastBlock = static_cast<juce::int64>(tap.getLastBlockSamples());
    const auto unbracketed = lastBlock > 0 ? lastBlock : static_cast<juce::int64>(device.getBufferSize());
    pending.measuredSampleRate =
        spanSeconds >= kMinDriftMeasurementSeconds && captured > unbracketed
                && pending.droppedSamples == 0
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

/**
 * Raw transport position the auto-stop fires at for a bounded window.
 *
 * The window end is a musical instant the *performer* has to reach, but the raw
 * transport counter runs ahead of what they can hear: by the output latency (audio
 * already handed to the device but not yet played) and, with latency-inducing effects
 * in use, by the plugin alignment as well (ADR 0026). Their response then needs the
 * input latency to come back. Stopping the moment the raw counter hits the window end
 * therefore detaches the writer before the last notes of the take have been captured,
 * and no amount of offline trimming can put them back.
 *
 * Running on is safe: a musical take is trimmed back to its exact bar length during
 * finalise, so the only cost is a little extra capture.
 */
double RecordingSessionController::windowStopPositionMs() const
{
    if (! session.has_value() || ! session->windowEndMs.has_value()) return 0.0;
    if (engine == nullptr) return *session->windowEndMs;

    const double roundTripMs = (session->input.has_value() ? session->input->inputLatencyMs : 0.0)
                               + engine->getOutputLatencyMs() + engine->getPluginLatencyMs();
    return *session->windowEndMs + juce::jmax(0.0, roundTripMs);
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
    if (session->status == "countIn")
    {
        // Nothing is captured and the playhead has not moved yet; the click expiring on
        // the audio thread is what starts the take.
        if (engine == nullptr || ! engine->isCountInClickActive()) beginRecordingAfterCountIn();
        return;
    }

    if (tap.hasHitLengthCap()
        || (session->windowEndMs.has_value() && positionMs >= windowStopPositionMs()))
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
    if (session->status == "countIn")
    {
        // The count-in runs on the audio thread with the transport parked, so what is
        // left of it comes from the click itself, not from the playhead.
        const double remaining = engine != nullptr ? engine->getCountInClickRemainingMs() : 0.0;
        const double bar = juce::jmax(1.0, barLengthMs());
        snapshot.countInBarsRemaining =
            juce::jlimit(0, 2, static_cast<int>(std::ceil(remaining / bar)));
        snapshot.recordedMs = 0.0;
    }
    else
    {
        // Capture only starts once the count-in is over, so everything captured is take.
        snapshot.recordedMs = juce::jmax(0.0, capturedMs);
    }
    return snapshot;
}

} // namespace silverdaw::recording
