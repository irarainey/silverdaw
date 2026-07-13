#include "ScratchSessionController.h"

#include <cmath>

namespace silverdaw::scratch
{

ScratchSessionController::ScratchSessionController(ScratchAudioSource& source)
    : scratchSource(source)
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
    session.reset();
}

bool ScratchSessionController::hasActiveSession() const
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    return session.has_value();
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
            if (scratchSource.isAtForwardBoundary())
                scratchSource.seekUs(0);
            scratchSource.setPlaying(true);
            s.status = (s.status == "recording") ? "recording" : "playing";
            return true;

        case ControlAction::pause:
            if (s.status == "recording")
                return false;
            scratchSource.setPlaying(false);
            s.status = "paused";
            return true;

        case ControlAction::seek:
            scratchSource.seekUs(control.positionUs);
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
            s.crossfader = juce::jlimit(0.0, 1.0, control.crossfader);
            updateGain();
            if (recorder.state() == ScratchActionRecorder::State::recording)
                recorder.recordCrossfader(s.crossfader);
            return true;
        }

        case ControlAction::recordStart:
        {
            if (s.status == "recording")
                return false;

            // Seek to crop start first, then capture authoritative position.
            scratchSource.seekUs(0);

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
            s.status = "recording";
            return true;
        }

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
            s.status = "ready";
            return true;
        }
    }
    return false;
}

// ── MIDI entry points ─────────────────────────────────────────────────────────

bool ScratchSessionController::midiTogglePlay(const juce::String& deviceIdentifier,
                                              DeckSide deck)
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    if (!session || !scratchSource.isActive()
        || !claimMidiDeck(deviceIdentifier, deck, false))
        return false;
    reconcileSourceEndLocked();
    // A transport press is an explicit recovery point for a missed jog-touch
    // release, which would otherwise leave motor playback silently suspended.
    scratchSource.setTouched(false);
    if (!scratchSource.snapshot().playing && scratchSource.isAtForwardBoundary())
        scratchSource.seekUs(0);
    const auto shouldPlay = !scratchSource.snapshot().playing;
    scratchSource.setPlaying(shouldPlay);
    if (session->status != "recording")
        session->status = shouldPlay ? "playing" : "paused";
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
    applyPlatterMove(deltaTurns, timestampMs);

    if (recorder.state() == ScratchActionRecorder::State::recording)
    {
        const auto snap = scratchSource.snapshot();
        recorder.recordPlatter(snap.platterTurns, snap.touched);
    }
    return true;
}

bool ScratchSessionController::midiSetCrossfader(const juce::String& deviceIdentifier,
                                                 double directedValue)
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
    const auto physical = juce::jlimit(0.0, 1.0, directedValue);

    // Pickup/catch-up: effective value stays unchanged until physical crosses it.
    if (!session->midiCrossfaderPickedUp)
    {
        if (!session->midiCrossfaderSeenFirst)
        {
            // First physical value seen — record it but don't change effective yet.
            session->midiCrossfaderSeenFirst = true;
            session->midiCrossfaderLastPhysical = physical;
            return false;
        }
        const auto lastPhysical = session->midiCrossfaderLastPhysical;
        const auto effective = session->crossfader;
        // Detect crossing: previous physical was on one side, now on the other (or equal).
        const bool crossed =
            (lastPhysical < effective && physical >= effective)
            || (lastPhysical > effective && physical <= effective)
            || (physical == effective);
        session->midiCrossfaderLastPhysical = physical;
        if (!crossed)
            return false;
        session->midiCrossfaderPickedUp = true;
    }

    session->midiCrossfaderLastPhysical = physical;
    session->crossfader = physical;

    updateGain();

    if (recorder.state() == ScratchActionRecorder::State::recording)
        recorder.recordCrossfader(session->crossfader);
    return true;
}

void ScratchSessionController::setSelectedMidiDeck(DeckSide deck)
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    if (!session)
        return;
    session->selectedDeck = deck;
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
    session->midiCrossfaderPickedUp = false;
    session->midiCrossfaderSeenFirst = false;
    session->midiCrossfaderLastPhysical = 0.0;
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
        s.crossfader = deck == DeckSide::deck1 ? 0.0 : 1.0;
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
        s.crossfader = deck == DeckSide::deck1 ? 0.0 : 1.0;
        s.midiCrossfaderPickedUp = false;
        s.midiCrossfaderSeenFirst = false;
        s.midiCrossfaderLastPhysical = 0.0;
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
    if (!session || !scratchSource.isActive() || !scratchSource.consumeEndReached())
        return false;

    scratchSource.setPlaying(false);
    const auto sourceState = scratchSource.snapshot();
    if (session->status == "recording")
    {
        ScratchActionRecorder::FinalSnapshot finalState;
        finalState.platterTurns = sourceState.platterTurns;
        finalState.touched = sourceState.touched;
        finalState.crossfader = session->crossfader;
        recorder.stop(finalState);
    }
    // Reset source to start so the next Play begins fresh. Status becomes ready.
    scratchSource.seekUs(0);
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
        sideGain = 1.0 - s.crossfader;
    else if (deck == DeckSide::deck2)
        sideGain = s.crossfader;
    scratchSource.setGain(static_cast<float>(sideGain));
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
    result.crossfader = session->crossfader;
    result.selectedDeck = session->selectedDeck;
    result.ownerDeck = session->ownerDeck;
    result.ownerDeviceIdentifier = session->ownerDeviceIdentifier;
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
