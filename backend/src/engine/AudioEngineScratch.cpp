#include "AudioEngine.h"

namespace silverdaw
{

juce::String AudioEngine::beginScratchSession(const juce::String& clipId)
{
    return scratchController.beginSession(clipId);
}

bool AudioEngine::completeScratchSession(
    const juce::String& sessionId,
    std::shared_ptr<const juce::AudioBuffer<float>> preparedAudio,
    double preparedSampleRate)
{
    return scratchController.completeSession(sessionId, std::move(preparedAudio), preparedSampleRate);
}

bool AudioEngine::failScratchSession(const juce::String& sessionId,
                                     const juce::String& error)
{
    return scratchController.failSession(sessionId, error);
}

bool AudioEngine::setScratchPreparationProgress(
    const juce::String& sessionId, double progress)
{
    return scratchController.setPreparationProgress(sessionId, progress);
}

bool AudioEngine::closeScratchSession(const juce::String& sessionId)
{
    return scratchController.closeSession(sessionId);
}

bool AudioEngine::beginScratchBackingPreparation(const juce::String& sessionId)
{
    return scratchController.beginBackingPreparation(sessionId);
}

bool AudioEngine::completeScratchBacking(
    const juce::String& sessionId,
    std::shared_ptr<const juce::AudioBuffer<float>> preparedAudio,
    double preparedSampleRate)
{
    return scratchController.completeBacking(sessionId, std::move(preparedAudio), preparedSampleRate);
}

bool AudioEngine::failScratchBacking(const juce::String& sessionId,
                                     const juce::String& error)
{
    return scratchController.failBacking(sessionId, error);
}

bool AudioEngine::clearScratchBacking(const juce::String& sessionId)
{
    return scratchController.clearBacking(sessionId);
}

bool AudioEngine::controlScratchSession(const scratch::SessionControlPayload& control)
{
    return scratchController.controlSession(control);
}

bool AudioEngine::scratchMidiTogglePlay()
{
    return scratchController.midiTogglePlay();
}

bool AudioEngine::scratchMidiCueToStart()
{
    return scratchController.midiCueToStart();
}

bool AudioEngine::scratchMidiSetTouch(const juce::String& deviceIdentifier,
                                      scratch::DeckSide deck,
                                      bool touched)
{
    return scratchController.midiSetTouch(deviceIdentifier, deck, touched);
}

bool AudioEngine::scratchMidiMovePlatter(const juce::String& deviceIdentifier,
                                         scratch::DeckSide deck,
                                         double deltaTurns,
                                         double timestampMs)
{
    return scratchController.midiMovePlatter(deviceIdentifier, deck, deltaTurns, timestampMs);
}

bool AudioEngine::scratchMidiSetCrossfader(const juce::String& deviceIdentifier,
                                           double directedValue,
                                           double displayValue,
                                           bool reverseCrossfader)
{
    return scratchController.midiSetCrossfader(
        deviceIdentifier, directedValue, displayValue, reverseCrossfader);
}

bool AudioEngine::setScratchMidiCrossfaderDirection(
    const juce::String& deviceIdentifier, bool reverseCrossfader)
{
    return scratchController.setMidiCrossfaderDirection(
        deviceIdentifier, reverseCrossfader);
}

bool AudioEngine::hasActiveScratchSession() const
{
    return scratchController.hasActiveSession();
}

void AudioEngine::setScratchMidiSelectedDeck(
    const juce::String& deviceIdentifier, scratch::DeckSide deck,
    bool reverseCrossfader)
{
    scratchController.setSelectedMidiDeck(
        deviceIdentifier, deck, reverseCrossfader);
}

bool AudioEngine::releaseScratchMidiOwner(
    const juce::String& deviceIdentifier,
    std::optional<scratch::DeckSide> deck)
{
    return scratchController.releaseMidiOwner(deviceIdentifier, deck);
}

bool AudioEngine::reconcileScratchSessionSourceEnd()
{
    return scratchController.reconcileSourceEnd();
}

std::optional<AudioEngine::ScratchSessionSnapshot>
AudioEngine::getScratchSessionSnapshot() const
{
    return scratchController.getSnapshot();
}

std::optional<scratch::Pattern> AudioEngine::takeScratchRecordingPattern()
{
    return scratchController.takeCompletedPattern();
}

} // namespace silverdaw
