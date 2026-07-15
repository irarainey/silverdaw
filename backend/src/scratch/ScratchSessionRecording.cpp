#include "ScratchSessionController.h"

namespace silverdaw::scratch
{

// ── Recording ──────────────────────────────────────────────────────────────────

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

bool ScratchSessionController::midiRecordToggle()
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    if (!session || !scratchSource.isActive())
        return false;
    auto& s = *session;
    const bool wasRecording = s.status == "recording";
    // reconcileSourceEndLocked() can auto-finalize an in-progress take (the
    // backing/source window ended) inside this same call. When that happens the
    // press must be consumed as the take's "stop" — publishing the pattern that
    // just completed — and must not fall through to arm a new take immediately
    // afterwards.
    const bool autoFinalized = reconcileSourceEndLocked() && wasRecording;
    // Mirror the on-screen Record button's phases from the physical Play button:
    // recording → stop (publishes the take), armed → cancel, otherwise arm. The
    // armed take still begins on first platter touch via beginArmedRecordingLocked.
    if (s.status == "recording")
        return stopRecordingLocked();
    if (autoFinalized)
        return true;
    if (s.armed)
    {
        s.armed = false;
        return true;
    }
    s.armed = true;
    return true;
}

bool ScratchSessionController::stopRecordingLocked()
{
    auto& s = *session;
    // Update recording owner to actual claimed deck before stop.
    if (s.ownerDeck.has_value())
        recorder.updateOwnerDeck(*s.ownerDeck);
    // Supply the authoritative current platter/crossfader snapshot so the
    // mandatory final keyframes reflect the true source state at the moment of
    // stop, not merely the last recorded sample.
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

} // namespace silverdaw::scratch
