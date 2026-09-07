#pragma once

#include <juce_core/juce_core.h>

#include <optional>
#include <vector>

namespace silverdaw::recording
{

/** How far apart two round-trip readings may sit and still be treated as the same measurement. */
inline constexpr double kCalibrationAgreementMs = 12.0;

/** Round trips outside this range are rejected outright: below it the measurement has found the
 *  burst it is about to emit rather than the one it emitted, and above it the capture is picking
 *  up a reflection or an unrelated noise. */
inline constexpr double kMinPlausibleRoundTripMs = 1.0;
inline constexpr double kMaxPlausibleRoundTripMs = 600.0;

/** Fraction of a burst's own peak that counts as its onset. */
inline constexpr float kOnsetFraction = 0.2F;

/**
 * Sample index at which each emitted burst arrives in a captured signal.
 *
 * Onset, not peak: a burst is windowed, so its peak sits several milliseconds after it starts
 * and the room adds more. Walking back from the peak to the first sample that crosses a
 * fraction of it recovers the arrival rather than the loudest point.
 *
 * `minSpacingSamples` keeps a single burst from being found twice — the search restarts past
 * the end of whatever it just matched.
 */
std::vector<juce::int64> findBurstOnsets(const float* samples, juce::int64 numSamples,
                                         float noiseFloor, juce::int64 minSpacingSamples);

/**
 * The round trip the readings agree on, or nothing when they do not.
 *
 * Median rather than mean, and then a check that most readings sit near it: a click that was
 * swallowed by a cold amp, or a cough picked up mid-run, must not drag the answer. A
 * measurement that cannot be corroborated is refused rather than reported with a caveat, since
 * a wrong number applied confidently is worse than no number at all.
 */
std::optional<double> agreedRoundTripMs(std::vector<double> readings, double toleranceMs);

} // namespace silverdaw::recording
