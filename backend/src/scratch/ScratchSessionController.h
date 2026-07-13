#pragma once

#include "ScratchActionRecorder.h"
#include "ScratchAudioSource.h"
#include "ScratchProtocol.h"

#include <juce_core/juce_core.h>

#include <cstdint>
#include <mutex>
#include <optional>

namespace silverdaw::scratch
{

// Owns scratch-session identity, status, transport-control ownership, MIDI
// ownership, crossfader state, and recording coordination.  Every public method
// is message-thread or MIDI-thread safe; the audio callback must never acquire
// the internal mutex.
//
// ScratchAudioSource is owned externally (fixed topology in the mixer graph)
// and passed by reference.  The controller never reads the source inside its
// own lock — it reads atomic snapshots or calls lock-free setters only.
class ScratchSessionController
{
  public:
    struct Snapshot
    {
        juce::String sessionId;
        juce::String clipId;
        juce::String status;
        juce::String error;
        double preparationProgress = 0.0;
        std::int64_t positionUs = 0;
        std::int64_t durationUs = 0;
        double platterTurns = 0.0;
        double playbackRate = 0.0;
        double crossfader = 0.0;
        std::optional<DeckSide> selectedDeck;
        std::optional<DeckSide> ownerDeck;
        std::optional<juce::String> ownerDeviceIdentifier;
        bool touched = false;
    };

    explicit ScratchSessionController(ScratchAudioSource& source);

    // Session lifecycle — message-thread only.
    juce::String beginSession(const juce::String& clipId);
    bool completeSession(const juce::String& sessionId,
                         std::shared_ptr<const juce::AudioBuffer<float>> preparedAudio,
                         double preparedSampleRate);
    bool failSession(const juce::String& sessionId, const juce::String& error);
    bool setPreparationProgress(const juce::String& sessionId, double progress);
    bool closeSession(const juce::String& sessionId);
    void clearSession();

    // Unified control entry point — message-thread only.
    bool controlSession(const SessionControlPayload& control);

    // MIDI entry points — may be called from MIDI thread.
    bool midiTogglePlay(const juce::String& deviceIdentifier, DeckSide deck);
    bool midiSetTouch(const juce::String& deviceIdentifier, DeckSide deck, bool touched);
    bool midiMovePlatter(const juce::String& deviceIdentifier, DeckSide deck,
                         double deltaTurns, double timestampMs);
    bool midiSetCrossfader(const juce::String& deviceIdentifier, double directedValue);
    void setSelectedMidiDeck(DeckSide deck);
    bool releaseMidiOwner(const juce::String& deviceIdentifier,
                          std::optional<DeckSide> deck = std::nullopt);
    bool reconcileSourceEnd();

    // Snapshot for bridge emission — any thread.
    std::optional<Snapshot> getSnapshot() const;

    // Retrieve completed recording pattern (moves ownership).
    std::optional<Pattern> takeCompletedPattern();

    bool hasActiveSession() const;

  private:
    struct Session
    {
        juce::String sessionId;
        juce::String clipId;
        juce::String status{"preparing"};
        juce::String error;
        double preparationProgress = 0.0;
        std::optional<DeckSide> selectedDeck;
        std::optional<DeckSide> ownerDeck;
        std::optional<juce::String> ownerDeviceIdentifier;
        std::optional<DeckSide> crossfaderDeck;
        std::optional<juce::String> midiCrossfaderEligibleDeviceIdentifier;
        double crossfader = 0.0;
        double lastPlatterMoveMs = 0.0;
        // Pickup crossfader: effective value stays unchanged until the directed
        // physical value crosses/catches the current effective value.
        bool midiCrossfaderPickedUp = false;
        bool midiCrossfaderSeenFirst = false;
        double midiCrossfaderLastPhysical = 0.0;
    };

    ScratchAudioSource& scratchSource;
    ScratchActionRecorder recorder;
    mutable std::mutex sessionMutex;
    std::optional<Session> session;

    // Private helpers; callers hold sessionMutex and have validated an active source.
    bool claimDeck(DeckSide deck);
    bool claimMidiDeck(const juce::String& deviceIdentifier, DeckSide deck, bool touchesPlatter);
    void applyPlatterMove(double deltaTurns, double timestampMs);
    bool reconcileSourceEndLocked();
    void updateGain();
    void resetOwnerTimestamp();
};

} // namespace silverdaw::scratch
