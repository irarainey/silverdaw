#include "ScratchSessionController.h"

namespace silverdaw::scratch
{

// ── MIDI entry points ─────────────────────────────────────────────────────────

bool ScratchSessionController::midiSetTouch(const juce::String& deviceIdentifier,
                                            DeckSide deck, bool touched)
{
    // Pattern replay (ADR 0021, Amendment 15/17) drives the source directly;
    // MIDI touch must not claim ownership or mutate touch state meanwhile.
    if (scratchSource.isPatternReplaying())
        return false;
    if (touched)
    {
        std::lock_guard<std::mutex> lock(sessionMutex);
        if (!session || !scratchSource.isActive()
            || !claimMidiDeck(deviceIdentifier, deck, true))
            return false;
        // Fresh-gesture timing baseline (see pointer touch): the first move
        // seeds its own elapsed rather than measuring the touch→move gap.
        session->lastPlatterMoveMs = 0.0;
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
    if (!session || !scratchSource.isActive() || scratchSource.isPatternReplaying()
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
    if (!session || !scratchSource.isActive() || scratchSource.isPatternReplaying()
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

} // namespace silverdaw::scratch
