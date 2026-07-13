#include "ScratchPatternEvaluator.h"

#include <algorithm>
#include <cmath>

namespace silverdaw::scratch
{

namespace
{
// Nominal platter speed: 33⅓ RPM = 1 turn per 1.8 seconds.
constexpr double kSecondsPerTurn = 1.8;
constexpr double kMicrosecondsPerSecond = 1000000.0;
} // namespace

EvalResult ScratchPatternEvaluator::evaluate(const PatternReplaySnapshot& snapshot,
                                             std::int64_t timeUs) noexcept
{
    EvalResult result;

    if (snapshot.empty())
    {
        result.beyondEnd = true;
        result.playbackRate = 0.0;
        result.crossfaderGain = 0.0;
        return result;
    }

    const std::int64_t duration = snapshot.durationUs();

    // Before pattern start or beyond pattern end → silence.
    if (timeUs < 0 || timeUs >= duration)
    {
        result.beyondEnd = true;
        result.platterTurns = 0.0;
        result.playbackRate = 0.0;
        result.touched = false;
        result.crossfaderGain = 0.0;
        return result;
    }

    result.beyondEnd = false;
    result.platterTurns = interpolatePlatter(snapshot.platter, timeUs);
    result.touched = interpolateTouch(snapshot.platter, timeUs);

    // Instantaneous rate: platter velocity → source rate.
    // Platter velocity in turns/us → turns/sec → multiply by source samples per turn.
    const double velocityTurnsPerUs = platterVelocity(snapshot.platter, timeUs);
    // Convert to playback rate: turns/sec / (1 turn per kSecondsPerTurn) = rate multiplier.
    const double velocityTurnsPerSec = velocityTurnsPerUs * kMicrosecondsPerSecond;
    result.playbackRate = velocityTurnsPerSec * kSecondsPerTurn;

    // Crossfader gain.
    const double xfaderPos = interpolateCrossfader(snapshot.crossfader, timeUs);
    result.crossfaderGain = linearV1Gain(xfaderPos, snapshot.ownerDeck);

    return result;
}

double ScratchPatternEvaluator::sourcePositionSamples(
    const PatternReplaySnapshot& snapshot,
    std::int64_t timeUs,
    double sourceSampleRate) noexcept
{
    if (snapshot.empty() || timeUs < 0 || timeUs >= snapshot.durationUs())
        return 0.0;

    // Platter turns at this time, relative to initial source offset.
    const double turns = interpolatePlatter(snapshot.platter, timeUs);
    // Each turn = kSecondsPerTurn seconds of source audio.
    const double sourceSeconds = (snapshot.sourceOffsetTurns + turns) * kSecondsPerTurn;
    return sourceSeconds * sourceSampleRate;
}

double ScratchPatternEvaluator::instantaneousRate(
    const PatternReplaySnapshot& snapshot,
    std::int64_t timeUs) noexcept
{
    if (snapshot.empty() || timeUs < 0 || timeUs >= snapshot.durationUs())
        return 0.0;

    const double velocityTurnsPerUs = platterVelocity(snapshot.platter, timeUs);
    const double velocityTurnsPerSec = velocityTurnsPerUs * kMicrosecondsPerSecond;
    return velocityTurnsPerSec * kSecondsPerTurn;
}

PatternReplaySnapshot ScratchPatternEvaluator::buildSnapshot(const Pattern& pattern)
{
    PatternReplaySnapshot snap;
    snap.cropStartUs = pattern.cropStartUs;
    snap.cropEndUs = pattern.cropEndUs;
    snap.sourceOffsetTurns = pattern.sourceOffsetTurns;
    snap.ownerDeck = pattern.ownerDeck;

    const std::int64_t cropDuration = pattern.cropEndUs - pattern.cropStartUs;
    if (cropDuration <= 0)
        return snap;

    // Build a fully-rebased version of the original platter lane for interpolation.
    std::vector<PlatterKeyframe> originalRebased;
    for (const auto& kf : pattern.platter)
        originalRebased.push_back({kf.timeUs - pattern.cropStartUs, kf.turns, kf.touched});

    // Collect keyframes strictly inside the crop window.
    for (const auto& kf : pattern.platter)
    {
        const std::int64_t relTime = kf.timeUs - pattern.cropStartUs;
        if (relTime < 0) continue;
        if (relTime > cropDuration) break;
        snap.platter.push_back({relTime, kf.turns, kf.touched});
    }

    // Ensure boundary at time 0.
    if (snap.platter.empty() || snap.platter.front().timeUs > 0)
    {
        const double turnsAtStart = interpolatePlatter(originalRebased, 0);
        const bool touchedAtStart = interpolateTouch(originalRebased, 0);
        snap.platter.insert(snap.platter.begin(), {0, turnsAtStart, touchedAtStart});
    }
    // Ensure boundary at cropDuration.
    if (snap.platter.back().timeUs < cropDuration)
    {
        const double turnsAtEnd = interpolatePlatter(originalRebased, cropDuration);
        const bool touchedAtEnd = interpolateTouch(originalRebased, cropDuration);
        snap.platter.push_back({cropDuration, turnsAtEnd, touchedAtEnd});
    }

    // Build rebased crossfader lane for interpolation.
    std::vector<CrossfaderKeyframe> originalXfRebased;
    for (const auto& kf : pattern.crossfader)
        originalXfRebased.push_back({kf.timeUs - pattern.cropStartUs, kf.value});

    // Collect crossfader keyframes strictly inside the crop window.
    for (const auto& kf : pattern.crossfader)
    {
        const std::int64_t relTime = kf.timeUs - pattern.cropStartUs;
        if (relTime < 0) continue;
        if (relTime > cropDuration) break;
        snap.crossfader.push_back({relTime, kf.value});
    }

    // Ensure boundary at time 0.
    if (snap.crossfader.empty() || snap.crossfader.front().timeUs > 0)
    {
        const double valAtStart = interpolateCrossfader(originalXfRebased, 0);
        snap.crossfader.insert(snap.crossfader.begin(), {0, valAtStart});
    }
    // Ensure boundary at cropDuration.
    if (snap.crossfader.back().timeUs < cropDuration)
    {
        const double valAtEnd = interpolateCrossfader(originalXfRebased, cropDuration);
        snap.crossfader.push_back({cropDuration, valAtEnd});
    }

    return snap;
}

double ScratchPatternEvaluator::linearV1Gain(double position, DeckSide ownerDeck) noexcept
{
    const double clamped = std::clamp(position, 0.0, 1.0);
    // Deck 1 = left side: gain = 1 - position (fully left = 1.0, fully right = 0.0).
    // Deck 2 = right side: gain = position (fully right = 1.0, fully left = 0.0).
    if (ownerDeck == DeckSide::deck1)
        return 1.0 - clamped;
    return clamped;
}

double ScratchPatternEvaluator::interpolatePlatter(
    const std::vector<PlatterKeyframe>& lane,
    std::int64_t timeUs) noexcept
{
    if (lane.empty()) return 0.0;
    if (timeUs <= lane.front().timeUs) return lane.front().turns;
    if (timeUs >= lane.back().timeUs) return lane.back().turns;

    // Binary search for the segment containing timeUs.
    auto it = std::upper_bound(lane.begin(), lane.end(), timeUs,
        [](std::int64_t t, const PlatterKeyframe& kf) { return t < kf.timeUs; });

    if (it == lane.begin()) return lane.front().turns;
    const auto& b = *it;
    const auto& a = *std::prev(it);

    const std::int64_t segDuration = b.timeUs - a.timeUs;
    if (segDuration <= 0) return a.turns;

    const double t = static_cast<double>(timeUs - a.timeUs) / static_cast<double>(segDuration);
    return a.turns + t * (b.turns - a.turns);
}

bool ScratchPatternEvaluator::interpolateTouch(
    const std::vector<PlatterKeyframe>& lane,
    std::int64_t timeUs) noexcept
{
    if (lane.empty()) return false;
    if (timeUs <= lane.front().timeUs) return lane.front().touched;

    // Find the last keyframe at or before timeUs (step function).
    auto it = std::upper_bound(lane.begin(), lane.end(), timeUs,
        [](std::int64_t t, const PlatterKeyframe& kf) { return t < kf.timeUs; });

    if (it == lane.begin()) return lane.front().touched;
    return std::prev(it)->touched;
}

double ScratchPatternEvaluator::interpolateCrossfader(
    const std::vector<CrossfaderKeyframe>& lane,
    std::int64_t timeUs) noexcept
{
    if (lane.empty()) return 1.0;
    if (timeUs <= lane.front().timeUs) return lane.front().value;
    if (timeUs >= lane.back().timeUs) return lane.back().value;

    auto it = std::upper_bound(lane.begin(), lane.end(), timeUs,
        [](std::int64_t t, const CrossfaderKeyframe& kf) { return t < kf.timeUs; });

    if (it == lane.begin()) return lane.front().value;
    const auto& b = *it;
    const auto& a = *std::prev(it);

    const std::int64_t segDuration = b.timeUs - a.timeUs;
    if (segDuration <= 0) return a.value;

    const double t = static_cast<double>(timeUs - a.timeUs) / static_cast<double>(segDuration);
    return a.value + t * (b.value - a.value);
}

double ScratchPatternEvaluator::platterVelocity(
    const std::vector<PlatterKeyframe>& lane,
    std::int64_t timeUs) noexcept
{
    if (lane.size() < 2) return 0.0;
    if (timeUs <= lane.front().timeUs) return 0.0;
    if (timeUs >= lane.back().timeUs) return 0.0;

    // Find the segment containing timeUs.
    auto it = std::upper_bound(lane.begin(), lane.end(), timeUs,
        [](std::int64_t t, const PlatterKeyframe& kf) { return t < kf.timeUs; });

    if (it == lane.begin() || it == lane.end()) return 0.0;
    const auto& b = *it;
    const auto& a = *std::prev(it);

    const std::int64_t segDuration = b.timeUs - a.timeUs;
    if (segDuration <= 0) return 0.0;

    // Linear slope = constant velocity within segment.
    return (b.turns - a.turns) / static_cast<double>(segDuration);
}

} // namespace silverdaw::scratch
