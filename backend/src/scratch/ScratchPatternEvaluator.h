#pragma once

// Closed-form deterministic scratch-pattern trajectory evaluator.
// Shared by live saved-pattern audition, timeline playback, and offline render.
// Given timeUs, evaluates platter turns/touch and crossfader by interpolation
// with exact boundary behavior. Derives playback source trajectory/rate
// independently of callback block size and seek history.

#include "ScratchProtocol.h"

#include <cstdint>
#include <vector>

namespace silverdaw::scratch
{

// Immutable prepared snapshot of a pattern for audio-thread evaluation.
// Constructed on the message thread, published to audio via atomic pointer swap.
struct PatternReplaySnapshot
{
    // Pattern identity and timing.
    std::int64_t cropStartUs = 0;
    std::int64_t cropEndUs = 0;
    double sourceOffsetTurns = 0.0;
    DeckSide ownerDeck = DeckSide::deck1;

    // Platter keyframes (sorted by timeUs, within crop window, rebased to crop start).
    std::vector<PlatterKeyframe> platter;

    // Crossfader keyframes (sorted by timeUs, within crop window, rebased to crop start).
    std::vector<CrossfaderKeyframe> crossfader;

    // Derived: pattern duration in microseconds (cropEnd - cropStart).
    std::int64_t durationUs() const noexcept { return cropEndUs - cropStartUs; }

    // True when no valid pattern data is present.
    bool empty() const noexcept { return platter.empty() || crossfader.empty(); }
};

// Result of evaluating the pattern at a specific time point.
struct EvalResult
{
    double platterTurns = 0.0;     // Absolute platter position in turns at this time.
    double playbackRate = 0.0;     // Instantaneous source playback rate (turns/sec → rate).
    bool touched = false;          // Whether platter is touched (hold) at this time.
    double crossfaderPosition = 0.0; // Evaluated lane position, 0.0 = left and 1.0 = right.
    double crossfaderGain = 1.0;   // Gain derived from crossfader position and curve.
    bool beyondEnd = false;        // True when timeUs >= pattern duration (silence).
};

// Pure, stateless evaluator. Thread-safe for concurrent reads.
class ScratchPatternEvaluator
{
  public:
    // Evaluate the pattern trajectory at a given time offset from crop start.
    // timeUs is relative to pattern start (0 = crop start).
    // Returns silence (beyondEnd=true) when timeUs >= pattern duration or < 0.
    static EvalResult evaluate(const PatternReplaySnapshot& snapshot,
                               std::int64_t timeUs) noexcept;

    // Evaluate source position in samples given pattern time, source sample rate,
    // and the source offset (initial platter position at crop start).
    // This is the key function for audio-thread reads.
    static double sourcePositionSamples(const PatternReplaySnapshot& snapshot,
                                        std::int64_t timeUs,
                                        double sourceSampleRate) noexcept;

    // Compute the instantaneous playback rate at timeUs for the VinylScratchProcessor.
    // Rate is in source-samples-per-output-sample units assuming same sample rate.
    static double instantaneousRate(const PatternReplaySnapshot& snapshot,
                                    std::int64_t timeUs) noexcept;

    // Build an immutable replay snapshot from a stored pattern.
    // Crops keyframes to the pattern's crop window and rebases times to zero.
    static PatternReplaySnapshot buildSnapshot(const Pattern& pattern);

    // Compute linear-v1 crossfader gain for the owner deck side.
    // position: 0.0 = fully left, 1.0 = fully right.
    static double linearV1Gain(double position, DeckSide ownerDeck) noexcept;

  private:
    // Interpolate platter turns at timeUs using linear interpolation between keyframes.
    static double interpolatePlatter(const std::vector<PlatterKeyframe>& lane,
                                     std::int64_t timeUs) noexcept;

    // Determine touch state at timeUs (uses the last keyframe at or before timeUs).
    static bool interpolateTouch(const std::vector<PlatterKeyframe>& lane,
                                 std::int64_t timeUs) noexcept;

    // Interpolate crossfader value at timeUs using linear interpolation.
    static double interpolateCrossfader(const std::vector<CrossfaderKeyframe>& lane,
                                        std::int64_t timeUs) noexcept;

    // Compute instantaneous platter velocity (turns per microsecond) at timeUs.
    static double platterVelocity(const std::vector<PlatterKeyframe>& lane,
                                  std::int64_t timeUs) noexcept;
};

} // namespace silverdaw::scratch
