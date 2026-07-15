#include "ScratchSessionController.h"

namespace silverdaw::scratch
{

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

bool ScratchSessionController::beginReplayBacking()
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    if (!backingReadyLocked())
        return false;
    // A take is recorded with the bed running from its head (beginArmedRecordingLocked
    // seeks the bed to 0), so the pattern's t=0 aligns with the bed's origin.
    // Rewind and start the bed so replay hears it in time.
    backingSource.seekUs(0);
    startBackingLocked();
    return true;
}

void ScratchSessionController::endReplayBacking()
{
    std::lock_guard<std::mutex> lock(sessionMutex);
    stopBackingLocked();
    backingSource.seekUs(0);
}

} // namespace silverdaw::scratch
