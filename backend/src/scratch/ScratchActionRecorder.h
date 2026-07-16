#pragma once

#include "ScratchProtocol.h"

#include <juce_core/juce_core.h>

#include <atomic>
#include <cstdint>
#include <mutex>
#include <optional>
#include <vector>

namespace silverdaw::scratch
{

// Records scratch action keyframes from concurrent MIDI/message-thread controls.
// Uses a focused mutex for control-thread synchronization (never called from audio).
// No allocations/locks/logging on the audio callback path.
class ScratchActionRecorder
{
  public:
    struct Config
    {
        juce::String draftId;
        juce::String draftName;
        juce::String sessionId;
        juce::String clipId;
        DeckSide ownerDeck = DeckSide::deck1;
        double initialPlatterTurns = 0.0;
        double initialCrossfader = 0.0;
        bool initialTouched = false;
        std::int64_t cropStartUs = 0;
    };

    enum class State
    {
        idle,
        recording,
        completed,
        aborted
    };

    ScratchActionRecorder() = default;

    // Start recording with given config. Returns false if already recording.
    bool start(const Config& config);

    // Stop recording and finalize the pattern. Returns false if not recording.
    // The caller must supply the authoritative final platter/crossfader state
    // so the mandatory boundary keyframes reflect the true source snapshot at
    // the moment of stop, not merely the last recorded sample.
    struct FinalSnapshot
    {
        double platterTurns = 0.0;
        bool touched = false;
        double crossfader = 0.0;
    };
    bool stop(const FinalSnapshot& finalState);

    // Abort without producing a pattern (session close/error/recovery).
    void abort();

    // Record a platter position sample. Thread-safe (control threads only).
    void recordPlatter(double absoluteTurns, bool touched);
    void recordPlatterAt(std::int64_t timeUs, double absoluteTurns, bool touched);

    // Record a crossfader value. Thread-safe (control threads only).
    void recordCrossfader(double value);

    // Update the owner deck before stop, when the actual first claimed deck
    // differs from the provisional deck used at recordStart.
    void updateOwnerDeck(DeckSide deck);

    State state() const noexcept { return currentState.load(std::memory_order_acquire); }

    // Retrieve the completed pattern (moves ownership). Returns nullopt if not completed.
    std::optional<Pattern> takeCompletedPattern();

    // Current recording duration in microseconds (for display).
    std::int64_t currentDurationUs() const noexcept;

    // Check if the recorder belongs to a specific session.
    bool belongsToSession(const juce::String& sessionId) const;

  private:
    mutable std::mutex mutex;
    std::atomic<State> currentState{State::idle};
    Config config;
    std::int64_t startTimeUs = 0;
    std::vector<PlatterKeyframe> platterLane;
    std::vector<CrossfaderKeyframe> crossfaderLane;
    std::optional<Pattern> completedPattern;

    std::int64_t elapsedUs() const;
    static std::int64_t monotonicUs();

    // Simplify the platter lane with Ramer–Douglas–Peucker within each
    // constant-touch run, preserving touch transitions and direction reversals.
    static void coalescePlatter(std::vector<PlatterKeyframe>& lane);
    // Simplify the crossfader lane with Ramer–Douglas–Peucker.
    static void coalesceCrossfader(std::vector<CrossfaderKeyframe>& lane);
};

} // namespace silverdaw::scratch
