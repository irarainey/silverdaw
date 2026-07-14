#pragma once

#include "ScratchActionRecorder.h"
#include "ScratchAudioSource.h"
#include "BackingMonitorSource.h"
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
        // Display-only: mirrors the MIDI crossfader direction preference for the
        // session (true = right-to-left). Lets the UI colour the fader bar by
        // position and direction alone — deck ownership never affects it.
        bool crossfaderReversed = false;
        std::optional<DeckSide> selectedDeck;
        std::optional<DeckSide> ownerDeck;
        std::optional<juce::String> ownerDeviceIdentifier;
        bool touched = false;
        bool armed = false;
        // Backing bed status: "none" | "preparing" | "ready" | "error".
        juce::String backingStatus{"none"};
        juce::String backingError;
        std::int64_t backingDurationUs = 0;
        std::int64_t backingPositionUs = 0;
        // Whether the backing bed auto-restarts on reaching its end.
        bool backingLoop = false;
        // Monitor-only trims (0..1); never baked into recorded patterns.
        double backingGain = 1.0;
        double scratchMonitorGain = 1.0;
    };

    explicit ScratchSessionController(ScratchAudioSource& source,
                                      BackingMonitorSource& backing);

    // Session lifecycle — message-thread only.
    juce::String beginSession(const juce::String& clipId);
    bool completeSession(const juce::String& sessionId,
                         std::shared_ptr<const juce::AudioBuffer<float>> preparedAudio,
                         double preparedSampleRate);
    bool failSession(const juce::String& sessionId, const juce::String& error);
    bool setPreparationProgress(const juce::String& sessionId, double progress);
    bool closeSession(const juce::String& sessionId);
    void clearSession();

    // Backing bed lifecycle (ADR 0021, Amendment 1) — message-thread only.
    bool beginBackingPreparation(const juce::String& sessionId);
    bool completeBacking(const juce::String& sessionId,
                         std::shared_ptr<const juce::AudioBuffer<float>> preparedAudio,
                         double preparedSampleRate);
    bool failBacking(const juce::String& sessionId, const juce::String& error);
    bool clearBacking(const juce::String& sessionId);

    // Unified control entry point — message-thread only.
    bool controlSession(const SessionControlPayload& control);

    // MIDI entry points — may be called from MIDI thread.
    // Backing-only transport driven by the deck's physical Play button. The
    // scratch clip is never MIDI-driven; this no-ops unless a backing bed is
    // prepared (ready). Returns true only when it acts (so the caller broadcasts).
    bool midiTogglePlay();
    bool midiSetTouch(const juce::String& deviceIdentifier, DeckSide deck, bool touched);
    bool midiMovePlatter(const juce::String& deviceIdentifier, DeckSide deck,
                         double deltaTurns, double timestampMs);
    bool midiSetCrossfader(const juce::String& deviceIdentifier, double directedValue,
                           double displayValue = -1.0, bool reverseCrossfader = false);
    bool setMidiCrossfaderDirection(const juce::String& deviceIdentifier,
                                    bool reverseCrossfader);
    void setSelectedMidiDeck(const juce::String& deviceIdentifier, DeckSide deck,
                             bool reverseCrossfader);
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
        double crossfaderDisplay = 0.0;
        double lastPlatterMoveMs = 0.0;
        bool midiCrossfaderReversed = false;
        // Display-only mirror of the crossfader direction preference (true =
        // right-to-left). Kept separate from midiCrossfaderReversed, which is
        // entangled with gain, so the UI can colour the bar by direction without
        // affecting audio.
        bool crossfaderDisplayReversed = false;
        // When armed, the first eligible platter gesture atomically claims the
        // deck and begins recording, so a performer never presses a button with
        // both hands on the gear.
        bool armed = false;
        // Before the physical fader is seen, the selected deck's preferred edge
        // is assumed open. Once adjusted, its directed position persists until close.
        bool crossfaderHasBeenAdjusted = false;
        // Backing bed (ADR 0021, Amendment 1). Status mirrors backingSource
        // readiness; when a bed is ready its window bounds forward play/record.
        juce::String backingStatus{"none"};
        juce::String backingError;
        std::int64_t backingDurationUs = 0;
        // When true, plain backing playback restarts at the bed's end instead of
        // stopping. Off by default; ignored while recording (the window bounds the take).
        bool backingLoop = false;
        // Monitor-only trims (0..1); never baked into recorded patterns.
        double backingGain = 1.0;
        double scratchMonitorGain = 0.75;
    };

    ScratchAudioSource& scratchSource;
    BackingMonitorSource& backingSource;
    ScratchActionRecorder recorder;
    mutable std::mutex sessionMutex;
    std::optional<Session> session;

    // Private helpers; callers hold sessionMutex and have validated an active source.
    bool claimDeck(DeckSide deck);
    bool claimMidiDeck(const juce::String& deviceIdentifier, DeckSide deck, bool touchesPlatter);
    // Called with the lock held on an active source when a gesture arrives while
    // armed; performs the same start sequence as recordStart and clears arming.
    bool beginArmedRecordingLocked();
    void applyPlatterMove(double deltaTurns, double timestampMs);
    bool reconcileSourceEndLocked();
    // Backing bed helpers; callers hold sessionMutex.
    bool backingReadyLocked() const;
    void startBackingLocked();
    void stopBackingLocked();
    void updateGain();
    void resetOwnerTimestamp();
};

} // namespace silverdaw::scratch
