#include "ScratchSessionController.h"

#include <cmath>

namespace silverdaw::scratch
{

ScratchSessionController::ScratchSessionController(ScratchAudioSource& source,
                                                  BackingMonitorSource& backing)
    : scratchSource(source), backingSource(backing)
{
}

// ── Session lifecycle ─────────────────────────────────────────────────────────

juce::String ScratchSessionController::beginSession(const juce::String& clipId)
{
    clearSession();
    std::lock_guard<std::mutex> lock(sessionMutex);
    Session s;
    s.sessionId = juce::Uuid().toString();
    s.clipId = clipId;
    s.status = "preparing";
    // The pointer/virtual deck is always deck 1, so resolve its crossfader side
    // up front: the on-screen fader and keyboard cut are authoritative from open
    // rather than inert until the platter is first touched. A physical MIDI
    // claim overwrites crossfaderDeck later.
    s.crossfaderDeck = DeckSide::deck1;
    const auto id = s.sessionId;
    session = std::move(s);
    return id;
}

bool ScratchSessionController::completeSession(
    const juce::String& sessionId,
    std::shared_ptr<const juce::AudioBuffer<float>> preparedAudio,
    double preparedSampleRate)
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    if (!session || session->sessionId != sessionId
        || preparedAudio == nullptr || preparedAudio->getNumSamples() <= 0
        || preparedAudio->getNumChannels() <= 0 || preparedSampleRate <= 0.0)
    {
        return false;
    }
    // activate is safe: it quiesces the callback internally.
    scratchSource.activate(std::move(preparedAudio), preparedSampleRate);
    session->status = "ready";
    session->preparationProgress = 1.0;
    session->error.clear();
    return true;
}

bool ScratchSessionController::setPreparationProgress(
    const juce::String& sessionId, double progress)
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    if (!session || session->sessionId != sessionId
        || session->status != "preparing")
        return false;
    session->preparationProgress = juce::jlimit(0.0, 1.0, progress);
    return true;
}

bool ScratchSessionController::failSession(const juce::String& sessionId,
                                           const juce::String& error)
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    if (!session || session->sessionId != sessionId)
        return false;
    // deactivate is safe: it quiesces the callback internally.
    scratchSource.deactivate();
    backingSource.deactivate();
    session->status = "error";
    session->error = error.isNotEmpty() ? error : juce::String("Scratch preparation failed");
    return true;
}

bool ScratchSessionController::closeSession(const juce::String& sessionId)
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    if (!session || session->sessionId != sessionId)
        return false;
    // Abort any in-progress recording.
    recorder.abort();
    scratchSource.deactivate();
    backingSource.deactivate();
    session.reset();
    return true;
}

void ScratchSessionController::clearSession()
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    if (!session)
        return;
    recorder.abort();
    scratchSource.deactivate();
    backingSource.deactivate();
    session.reset();
}

bool ScratchSessionController::hasActiveSession() const
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    return session.has_value();
}

// ── Backing bed (ADR 0021, Amendment 1) ───────────────────────────────────────

bool ScratchSessionController::beginBackingPreparation(const juce::String& sessionId)
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    if (!session || session->sessionId != sessionId || session->status == "recording")
        return false;
    backingSource.deactivate();
    session->backingStatus = "preparing";
    session->backingError.clear();
    session->backingDurationUs = 0;
    return true;
}

bool ScratchSessionController::completeBacking(
    const juce::String& sessionId,
    std::shared_ptr<const juce::AudioBuffer<float>> preparedAudio,
    double preparedSampleRate)
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    if (!session || session->sessionId != sessionId
        || session->backingStatus != "preparing"
        || preparedAudio == nullptr || preparedAudio->getNumSamples() <= 0
        || preparedAudio->getNumChannels() <= 0 || preparedSampleRate <= 0.0)
    {
        return false;
    }
    backingSource.activate(std::move(preparedAudio), preparedSampleRate);
    backingSource.setGain(static_cast<float>(session->backingGain));
    session->backingStatus = "ready";
    session->backingError.clear();
    session->backingDurationUs = backingSource.durationUs();
    return true;
}

bool ScratchSessionController::failBacking(const juce::String& sessionId,
                                           const juce::String& error)
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    if (!session || session->sessionId != sessionId
        || session->backingStatus != "preparing")
        return false;
    backingSource.deactivate();
    session->backingStatus = "error";
    session->backingError =
        error.isNotEmpty() ? error : juce::String("Backing preparation failed");
    session->backingDurationUs = 0;
    return true;
}

bool ScratchSessionController::clearBacking(const juce::String& sessionId)
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    if (!session || session->sessionId != sessionId || session->status == "recording")
        return false;
    backingSource.deactivate();
    session->backingStatus = "none";
    session->backingError.clear();
    session->backingDurationUs = 0;
    return true;
}

bool ScratchSessionController::backingReadyLocked() const
{
    return session && session->backingStatus == "ready" && backingSource.isActive();
}

void ScratchSessionController::startBackingLocked()
{
    if (backingReadyLocked())
        backingSource.setPlaying(true);
}

void ScratchSessionController::stopBackingLocked()
{
    backingSource.setPlaying(false);
}

// ── Unified control ───────────────────────────────────────────────────────────

bool ScratchSessionController::controlSession(const SessionControlPayload& control)
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    if (!session || session->sessionId != control.sessionId
        || !scratchSource.isActive())
    {
        return false;
    }
    auto& s = *session;
    reconcileSourceEndLocked();

    switch (control.action)
    {
        case ControlAction::play:
            // The on-screen/keyboard transport drives the backing bed only; the
            // scratch clip is heard solely when the platter is jogged. Without a
            // prepared backing there is nothing for the transport to run.
            if (!backingReadyLocked())
                return false;
            if (backingSource.isAtForwardBoundary())
                backingSource.seekUs(0);
            startBackingLocked();
            s.status = (s.status == "recording") ? "recording" : "playing";
            return true;

        case ControlAction::pause:
            if (s.status == "recording")
                return false;
            stopBackingLocked();
            s.status = "paused";
            return true;

        case ControlAction::seek:
            if (!backingReadyLocked())
                return false;
            backingSource.seekUs(control.positionUs);
            return true;

        case ControlAction::platterTouch:
        {
            if (!control.deck)
            {
                return false;
            }
            if (control.touched)
            {
                if (!claimDeck(*control.deck))
                    return false;
                s.lastPlatterMoveMs = juce::Time::getMillisecondCounterHiRes();
                if (s.armed)
                    beginArmedRecordingLocked();
            }
            else
            {
                if (!s.ownerDeck || s.ownerDeviceIdentifier
                    || *s.ownerDeck != *control.deck)
                {
                    return false;
                }
                scratchSource.setTouched(false);
                s.ownerDeck.reset();
                s.ownerDeviceIdentifier.reset();
                resetOwnerTimestamp();
            }
            updateGain();
            if (recorder.state() == ScratchActionRecorder::State::recording)
            {
                const auto snap = scratchSource.snapshot();
                recorder.recordPlatter(snap.platterTurns, snap.touched);
            }
            return true;
        }

        case ControlAction::platterMove:
        {
            if (!control.deck || !claimDeck(*control.deck))
                return false;
            if (s.armed)
                beginArmedRecordingLocked();
            applyPlatterMove(
                control.deltaTurns, juce::Time::getMillisecondCounterHiRes());
            if (recorder.state() == ScratchActionRecorder::State::recording)
            {
                const auto snap = scratchSource.snapshot();
                recorder.recordPlatter(snap.platterTurns, snap.touched);
            }
            return true;
        }

        case ControlAction::crossfader:
        {
            const auto displayValue = juce::jlimit(0.0, 1.0, control.crossfader);
            s.crossfaderDisplay = displayValue;
            s.crossfader = s.midiCrossfaderReversed
                ? 1.0 - displayValue
                : displayValue;
            s.crossfaderHasBeenAdjusted = true;
            updateGain();
            if (recorder.state() == ScratchActionRecorder::State::recording)
                recorder.recordCrossfader(s.crossfader);
            return true;
        }

        case ControlAction::backingGain:
        {
            s.backingGain = juce::jlimit(0.0, 1.0, control.gain);
            backingSource.setGain(static_cast<float>(s.backingGain));
            return true;
        }

        case ControlAction::scratchGain:
        {
            s.scratchMonitorGain = juce::jlimit(0.0, 1.0, control.gain);
            updateGain();
            return true;
        }

        case ControlAction::backingLoop:
        {
            s.backingLoop = control.loop;
            return true;
        }

        case ControlAction::recordArm:
            if (s.status == "recording")
                return false;
            s.armed = true;
            return true;

        case ControlAction::recordDisarm:
            if (!s.armed)
                return false;
            s.armed = false;
            return true;

        case ControlAction::recordStart:
            if (s.status == "recording")
                return false;
            return beginArmedRecordingLocked();

        case ControlAction::recordStop:
        {
            if (s.status != "recording")
                return false;
            // Update recording owner to actual claimed deck before stop.
            if (s.ownerDeck.has_value())
                recorder.updateOwnerDeck(*s.ownerDeck);
            // Supply the authoritative current platter/crossfader snapshot so
            // the mandatory final keyframes reflect the true source state at
            // the moment of stop, not merely the last recorded sample.
            const auto snap = scratchSource.snapshot();
            ScratchActionRecorder::FinalSnapshot finalState;
            finalState.platterTurns = snap.platterTurns;
            finalState.touched = snap.touched;
            finalState.crossfader = s.crossfader;
            recorder.stop(finalState);
            scratchSource.setPlaying(false);
            stopBackingLocked();
            s.status = "ready";
            s.armed = false;
            return true;
        }
    }
    return false;
}

bool ScratchSessionController::beginArmedRecordingLocked()
{
    auto& s = *session;
    if (s.status == "recording")
        return false;

    // Seek to crop start first, then capture authoritative position.
    scratchSource.seekUs(0);
    backingSource.seekUs(0);

    ScratchActionRecorder::Config cfg;
    cfg.draftId = juce::Uuid().toString();
    cfg.draftName = "Scratch " + juce::Time::getCurrentTime().toString(true, true, false);
    cfg.sessionId = s.sessionId;
    cfg.clipId = s.clipId;
    // Use existing owner if claimed; otherwise provisional deck 1 for pointer.
    cfg.ownerDeck = s.ownerDeck.value_or(DeckSide::deck1);
    cfg.initialCrossfader = s.crossfader;
    cfg.cropStartUs = 0;
    const auto snap = scratchSource.snapshot();
    cfg.initialPlatterTurns = snap.platterTurns;
    cfg.initialTouched = snap.touched;
    if (!recorder.start(cfg))
        return false;
    scratchSource.setPlaying(true);
    startBackingLocked();
    s.status = "recording";
    s.armed = false;
    return true;
}

// ── MIDI entry points ─────────────────────────────────────────────────────────

bool ScratchSessionController::midiTogglePlay()
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    if (!session || !scratchSource.isActive())
        return false;
    auto& s = *session;
    // Recording owns transport; a physical Play press must not disturb it.
    if (s.status == "recording")
        return false;
    reconcileSourceEndLocked();
    // Honour backing readiness: with no prepared bed there is nothing to run and
    // the deck cannot know whether it was prepared, so the button stays inert.
    if (!backingReadyLocked())
        return false;
    if (s.status == "playing")
    {
        stopBackingLocked();
        s.status = "paused";
    }
    else
    {
        if (backingSource.isAtForwardBoundary())
            backingSource.seekUs(0);
        startBackingLocked();
        s.status = "playing";
    }
    return true;
}

bool ScratchSessionController::midiSetTouch(const juce::String& deviceIdentifier,
                                            DeckSide deck, bool touched)
{
    if (touched)
    {
        std::lock_guard<std::mutex> lock(sessionMutex);
        if (!session || !scratchSource.isActive()
            || !claimMidiDeck(deviceIdentifier, deck, true))
            return false;
        session->lastPlatterMoveMs = juce::Time::getMillisecondCounterHiRes();
        if (session->armed)
            beginArmedRecordingLocked();
        if (recorder.state() == ScratchActionRecorder::State::recording)
        {
            const auto snap = scratchSource.snapshot();
            recorder.recordPlatter(snap.platterTurns, true);
        }
        return true;
    }
    // Release path.
    return releaseMidiOwner(deviceIdentifier, deck);
}

bool ScratchSessionController::midiMovePlatter(const juce::String& deviceIdentifier,
                                               DeckSide deck,
                                               double deltaTurns,
                                               double timestampMs)
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    if (!session || !scratchSource.isActive()
        || !claimMidiDeck(deviceIdentifier, deck, true))
        return false;
    if (session->armed)
        beginArmedRecordingLocked();
    applyPlatterMove(deltaTurns, timestampMs);

    if (recorder.state() == ScratchActionRecorder::State::recording)
    {
        const auto snap = scratchSource.snapshot();
        recorder.recordPlatter(snap.platterTurns, snap.touched);
    }
    return true;
}

bool ScratchSessionController::midiSetCrossfader(const juce::String& deviceIdentifier,
                                                 double directedValue,
                                                 double displayValue,
                                                 bool reverseCrossfader)
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    if (!session || !scratchSource.isActive()
        || deviceIdentifier.isEmpty())
    {
        return false;
    }
    // Crossfader controls are mixer-wide. They may align and update the
    // editor before a platter claims ownership, but never claim a platter.
    if (!session->midiCrossfaderEligibleDeviceIdentifier)
        session->midiCrossfaderEligibleDeviceIdentifier = deviceIdentifier;
    if (*session->midiCrossfaderEligibleDeviceIdentifier != deviceIdentifier)
        return false;
    // Keep the display-only direction mirror in step with the applied routing so
    // the UI colours the bar by the active direction, not the (gain-entangled)
    // midiCrossfaderReversed flag.
    session->crossfaderDisplayReversed = reverseCrossfader;
    session->crossfader = juce::jlimit(0.0, 1.0, directedValue);
    session->crossfaderDisplay = displayValue >= 0.0
        ? juce::jlimit(0.0, 1.0, displayValue)
        : (session->midiCrossfaderReversed
               ? 1.0 - session->crossfader
               : session->crossfader);
    session->crossfaderHasBeenAdjusted = true;
    updateGain();

    if (recorder.state() == ScratchActionRecorder::State::recording)
        recorder.recordCrossfader(session->crossfader);
    return true;
}

bool ScratchSessionController::setMidiCrossfaderDirection(
    const juce::String& deviceIdentifier, bool reverseCrossfader)
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    if (!session || !scratchSource.isActive()
        || !session->midiCrossfaderEligibleDeviceIdentifier
        || *session->midiCrossfaderEligibleDeviceIdentifier != deviceIdentifier
        || session->midiCrossfaderReversed == reverseCrossfader)
    {
        return false;
    }
    session->midiCrossfaderReversed = reverseCrossfader;
    session->crossfaderDisplayReversed = reverseCrossfader;
    session->crossfader = 1.0 - session->crossfader;
    updateGain();
    return true;
}

void ScratchSessionController::setSelectedMidiDeck(
    const juce::String& deviceIdentifier, DeckSide deck, bool reverseCrossfader)
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    if (!session)
        return;
    session->selectedDeck = deck;
    session->crossfaderDeck = deck;
    session->midiCrossfaderEligibleDeviceIdentifier = deviceIdentifier;
    session->midiCrossfaderReversed = reverseCrossfader;
    session->crossfaderDisplayReversed = reverseCrossfader;
    if (!session->crossfaderHasBeenAdjusted)
    {
        const auto deckEdge = deck == DeckSide::deck1 ? 0.0 : 1.0;
        session->crossfader = reverseCrossfader ? 1.0 - deckEdge : deckEdge;
        session->crossfaderDisplay = deckEdge;
    }
    if (scratchSource.isActive())
        updateGain();
}

bool ScratchSessionController::releaseMidiOwner(
    const juce::String& deviceIdentifier,
    std::optional<DeckSide> deck)
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    if (!session || !scratchSource.isActive()
        || !session->ownerDeviceIdentifier
        || *session->ownerDeviceIdentifier != deviceIdentifier
        || (deck && session->ownerDeck != deck))
    {
        return false;
    }
    scratchSource.setTouched(false);
    if (recorder.state() == ScratchActionRecorder::State::recording)
    {
        const auto snap = scratchSource.snapshot();
        recorder.recordPlatter(snap.platterTurns, false);
    }
    session->ownerDeck.reset();
    session->ownerDeviceIdentifier.reset();
    resetOwnerTimestamp();
    updateGain();
    return true;
}

bool ScratchSessionController::claimDeck(DeckSide deck)
{
    auto& s = *session;
    if (s.ownerDeviceIdentifier || (s.ownerDeck && *s.ownerDeck != deck))
        return false;
    if (!s.ownerDeck)
    {
        s.ownerDeck = deck;
        s.crossfaderDeck = deck;
        if (!s.crossfaderHasBeenAdjusted)
        {
            const auto deckEdge = deck == DeckSide::deck1 ? 0.0 : 1.0;
            s.crossfader =
                s.midiCrossfaderReversed ? 1.0 - deckEdge : deckEdge;
            s.crossfaderDisplay = deckEdge;
        }
        resetOwnerTimestamp();
    }
    scratchSource.setTouched(true);
    updateGain();
    return true;
}

bool ScratchSessionController::claimMidiDeck(
    const juce::String& deviceIdentifier, DeckSide deck, bool touchesPlatter)
{
    auto& s = *session;
    if (deviceIdentifier.isEmpty()
        || (s.ownerDeck && *s.ownerDeck != deck)
        || (s.ownerDeviceIdentifier && *s.ownerDeviceIdentifier != deviceIdentifier)
        || (s.ownerDeck && !s.ownerDeviceIdentifier))
    {
        return false;
    }
    if (!s.ownerDeck)
    {
        s.ownerDeck = deck;
        s.selectedDeck = deck;
        s.ownerDeviceIdentifier = deviceIdentifier;
        s.crossfaderDeck = deck;
        s.midiCrossfaderEligibleDeviceIdentifier = deviceIdentifier;
        if (!s.crossfaderHasBeenAdjusted)
        {
            const auto deckEdge = deck == DeckSide::deck1 ? 0.0 : 1.0;
            s.crossfader =
                s.midiCrossfaderReversed ? 1.0 - deckEdge : deckEdge;
            s.crossfaderDisplay = deckEdge;
        }
        resetOwnerTimestamp();
        updateGain();
    }
    if (touchesPlatter)
        scratchSource.setTouched(true);
    return true;
}

void ScratchSessionController::applyPlatterMove(
    double deltaTurns, double timestampMs)
{
    auto& s = *session;
    const auto safeTimestampMs =
        std::isfinite(timestampMs) && timestampMs > 0.0
            ? timestampMs
            : juce::Time::getMillisecondCounterHiRes();
    const auto elapsedSeconds =
        s.lastPlatterMoveMs > 0.0
            ? juce::jlimit(
                  1.0 / 1000.0, 0.25,
                  (safeTimestampMs - s.lastPlatterMoveMs) / 1000.0)
            : 1.0 / 60.0;
    const auto semanticRate = juce::jlimit(
        -8.0, 8.0,
        deltaTurns * VinylScratchProcessor::kSecondsPerTurn / elapsedSeconds);
    scratchSource.setManualRate(semanticRate);
    s.lastPlatterMoveMs = safeTimestampMs;
}

bool ScratchSessionController::reconcileSourceEnd()
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    return reconcileSourceEndLocked();
}

bool ScratchSessionController::reconcileSourceEndLocked()
{
    if (!session || !scratchSource.isActive())
        return false;

    if (backingReadyLocked())
    {
        // The backing window bounds the session. The short scratch source uses
        // boundary silence within its own bounds, so its end is ignored here;
        // only the elapsed backing window stops the session.
        scratchSource.consumeEndReached();
        if (!backingSource.consumeEndReached())
            return false;
        // Loop: on plain playback, restart the bed at its head instead of ending
        // the session. Recording still terminates at the window end (the take is
        // bounded by the window), so looping never applies while recording.
        if (session->backingLoop && session->status == "playing")
        {
            backingSource.seekUs(0);
            startBackingLocked();
            return false;
        }
    }
    else if (!scratchSource.consumeEndReached())
    {
        return false;
    }

    scratchSource.setPlaying(false);
    stopBackingLocked();
    const auto sourceState = scratchSource.snapshot();
    if (session->status == "recording")
    {
        ScratchActionRecorder::FinalSnapshot finalState;
        finalState.platterTurns = sourceState.platterTurns;
        finalState.touched = sourceState.touched;
        finalState.crossfader = session->crossfader;
        recorder.stop(finalState);
    }
    // Reset both sources to start so the next Play begins fresh. Status ready.
    scratchSource.seekUs(0);
    backingSource.seekUs(0);
    if (session->status == "playing" || session->status == "recording")
        session->status = "ready";
    return true;
}

void ScratchSessionController::updateGain()
{
    const auto& s = *session;
    double sideGain = 1.0;
    const auto deck = s.ownerDeck ? s.ownerDeck : s.crossfaderDeck;
    if (deck == DeckSide::deck1)
        sideGain = s.midiCrossfaderReversed
            ? s.crossfader
            : 1.0 - s.crossfader;
    else if (deck == DeckSide::deck2)
        sideGain = s.midiCrossfaderReversed
            ? 1.0 - s.crossfader
            : s.crossfader;
    scratchSource.setGain(static_cast<float>(sideGain * s.scratchMonitorGain));
}

void ScratchSessionController::resetOwnerTimestamp()
{
    session->lastPlatterMoveMs = 0.0;
}

// ── Snapshot ───────────────────────────────────────────────────────────────────

std::optional<ScratchSessionController::Snapshot>
ScratchSessionController::getSnapshot() const
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    if (!session)
        return std::nullopt;
    Snapshot result;
    result.sessionId = session->sessionId;
    result.clipId = session->clipId;
    result.status = session->status;
    result.error = session->error;
    result.preparationProgress = session->preparationProgress;
    result.crossfader = session->crossfaderDisplay;
    result.crossfaderReversed = session->crossfaderDisplayReversed;
    result.selectedDeck = session->selectedDeck;
    result.ownerDeck = session->ownerDeck;
    result.ownerDeviceIdentifier = session->ownerDeviceIdentifier;
    result.armed = session->armed;
    result.backingStatus = session->backingStatus;
    result.backingError = session->backingError;
    result.backingDurationUs = session->backingDurationUs;
    result.backingPositionUs = backingReadyLocked() ? backingSource.positionUs() : 0;
    result.backingLoop = session->backingLoop;
    result.backingGain = session->backingGain;
    result.scratchMonitorGain = session->scratchMonitorGain;
    if (scratchSource.isActive())
    {
        const auto sourceState = scratchSource.snapshot();
        result.positionUs = sourceState.positionUs;
        result.durationUs = sourceState.durationUs;
        result.platterTurns = sourceState.platterTurns;
        result.playbackRate = sourceState.playbackRate;
        result.touched = sourceState.touched;
    }
    return result;
}

std::optional<Pattern> ScratchSessionController::takeCompletedPattern()
{
    return recorder.takeCompletedPattern();
}

} // namespace silverdaw::scratch
