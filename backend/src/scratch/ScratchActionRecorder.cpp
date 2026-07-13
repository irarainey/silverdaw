#include "ScratchActionRecorder.h"

#include <algorithm>
#include <cmath>
#include <chrono>

namespace silverdaw::scratch
{
namespace
{
// Reserve one slot for the mandatory final keyframe appended at stop().
constexpr std::int64_t kMaxLivePlatterPoints = kMaxPatternPoints - 1;
constexpr std::int64_t kMaxLiveCrossfaderPoints = kMaxPatternPoints - 1;
constexpr std::int64_t kPlatterCaptureIntervalUs = 8000;
constexpr std::int64_t kCrossfaderCaptureIntervalUs = 16000;
constexpr double kPlatterCoalesceToleranceTurns = 0.002;
constexpr double kCrossfaderCoalesceTolerance = 0.01;
} // namespace

std::int64_t ScratchActionRecorder::monotonicUs()
{
    using Clock = std::chrono::steady_clock;
    const auto now = Clock::now();
    return std::chrono::duration_cast<std::chrono::microseconds>(
               now.time_since_epoch())
        .count();
}

std::int64_t ScratchActionRecorder::elapsedUs() const
{
    return monotonicUs() - startTimeUs;
}

bool ScratchActionRecorder::start(const Config& cfg)
{
    std::lock_guard<std::mutex> lock(mutex);
    if (currentState.load(std::memory_order_relaxed) == State::recording)
        return false;

    config = cfg;
    startTimeUs = monotonicUs();
    platterLane.clear();
    crossfaderLane.clear();
    completedPattern.reset();

    // Capture initial boundary values
    platterLane.push_back({0, cfg.initialPlatterTurns, cfg.initialTouched});
    crossfaderLane.push_back({0, cfg.initialCrossfader});

    currentState.store(State::recording, std::memory_order_release);
    return true;
}

bool ScratchActionRecorder::stop(const FinalSnapshot& finalState)
{
    std::lock_guard<std::mutex> lock(mutex);
    if (currentState.load(std::memory_order_relaxed) != State::recording)
        return false;

    const auto durationUs = elapsedUs();

    // Mandatory final boundary keyframes at exactly durationUs using the
    // authoritative current snapshot (platterTurns/touched/crossfader) rather
    // than simply repeating the last recorded sample.  This guarantees the
    // pattern's trailing state matches the true audio source at stop time.
    if (!platterLane.empty())
    {
        auto& last = platterLane.back();
        if (last.timeUs == durationUs)
        {
            // Replace in place with authoritative values.
            last.turns = finalState.platterTurns;
            last.touched = finalState.touched;
        }
        else if (last.timeUs < durationUs)
        {
            platterLane.push_back({durationUs, finalState.platterTurns, finalState.touched});
        }
    }
    if (!crossfaderLane.empty())
    {
        auto& last = crossfaderLane.back();
        if (last.timeUs == durationUs)
        {
            // Replace in place with authoritative values.
            last.value = finalState.crossfader;
        }
        else if (last.timeUs < durationUs)
        {
            crossfaderLane.push_back({durationUs, finalState.crossfader});
        }
    }

    coalescePlatter(platterLane);
    coalesceCrossfader(crossfaderLane);

    Pattern pattern;
    pattern.id = config.draftId;
    pattern.name = config.draftName;
    pattern.durationUs = durationUs;
    pattern.cropStartUs = 0;
    pattern.cropEndUs = durationUs;
    pattern.sourceOffsetTurns = config.initialPlatterTurns;
    pattern.ownerDeck = config.ownerDeck;
    pattern.platter = std::move(platterLane);
    pattern.crossfader = std::move(crossfaderLane);

    PatternProvenance provenance;
    provenance.sourceClipId = config.clipId;
    pattern.provenance = provenance;

    completedPattern = std::move(pattern);
    platterLane.clear();
    crossfaderLane.clear();
    currentState.store(State::completed, std::memory_order_release);
    return true;
}

void ScratchActionRecorder::abort()
{
    std::lock_guard<std::mutex> lock(mutex);
    platterLane.clear();
    crossfaderLane.clear();
    completedPattern.reset();
    currentState.store(State::aborted, std::memory_order_release);
}

void ScratchActionRecorder::recordPlatter(double absoluteTurns, bool touched)
{
    std::lock_guard<std::mutex> lock(mutex);
    if (currentState.load(std::memory_order_relaxed) != State::recording)
        return;

    const auto timeUs = elapsedUs();
    if (timeUs <= 0 && !platterLane.empty())
        return;

    // Enforce strictly increasing timestamps
    if (!platterLane.empty() && timeUs <= platterLane.back().timeUs)
        return;

    if (!platterLane.empty()
        && touched == platterLane.back().touched
        && timeUs - platterLane.back().timeUs < kPlatterCaptureIntervalUs)
        return;

    // Enforce bounds — reserve one slot for mandatory final keyframe.
    if (static_cast<std::int64_t>(platterLane.size()) >= kMaxLivePlatterPoints)
        return;

    if (!std::isfinite(absoluteTurns)
        || std::abs(absoluteTurns) > kMaxAbsoluteTurns)
        return;

    platterLane.push_back({timeUs, absoluteTurns, touched});
}

void ScratchActionRecorder::recordCrossfader(double value)
{
    std::lock_guard<std::mutex> lock(mutex);
    if (currentState.load(std::memory_order_relaxed) != State::recording)
        return;

    const auto timeUs = elapsedUs();
    if (timeUs <= 0 && !crossfaderLane.empty())
        return;

    if (!crossfaderLane.empty() && timeUs <= crossfaderLane.back().timeUs)
        return;

    if (!crossfaderLane.empty()
        && timeUs - crossfaderLane.back().timeUs < kCrossfaderCaptureIntervalUs)
        return;

    if (static_cast<std::int64_t>(crossfaderLane.size()) >= kMaxLiveCrossfaderPoints)
        return;

    if (!std::isfinite(value) || value < 0.0 || value > 1.0)
        return;

    crossfaderLane.push_back({timeUs, value});
}

std::optional<Pattern> ScratchActionRecorder::takeCompletedPattern()
{
    std::lock_guard<std::mutex> lock(mutex);
    if (currentState.load(std::memory_order_relaxed) != State::completed)
        return std::nullopt;

    auto result = std::move(completedPattern);
    completedPattern.reset();
    currentState.store(State::idle, std::memory_order_release);
    return result;
}

std::int64_t ScratchActionRecorder::currentDurationUs() const noexcept
{
    if (currentState.load(std::memory_order_acquire) != State::recording)
        return 0;
    return const_cast<ScratchActionRecorder*>(this)->elapsedUs();
}

bool ScratchActionRecorder::belongsToSession(const juce::String& sessionId) const
{
    std::lock_guard<std::mutex> lock(mutex);
    return config.sessionId == sessionId;
}

void ScratchActionRecorder::updateOwnerDeck(DeckSide deck)
{
    std::lock_guard<std::mutex> lock(mutex);
    if (currentState.load(std::memory_order_relaxed) == State::recording)
        config.ownerDeck = deck;
}

void ScratchActionRecorder::coalescePlatter(std::vector<PlatterKeyframe>& lane)
{
    if (lane.size() <= 2)
        return;

    std::vector<PlatterKeyframe> reduced;
    reduced.reserve(lane.size());
    reduced.push_back(lane.front());

    for (std::size_t i = 1; i + 1 < lane.size(); ++i)
    {
        const auto& prev = reduced.back();
        const auto& curr = lane[i];
        const auto& next = lane[i + 1];

        // Keep points where touch state changes
        if (curr.touched != prev.touched || curr.touched != next.touched)
        {
            reduced.push_back(curr);
            continue;
        }

        // Keep points where direction changes (sign of slope changes)
        const double slopePrev = curr.turns - prev.turns;
        const double slopeNext = next.turns - curr.turns;
        if ((slopePrev > kPlatterCoalesceToleranceTurns
             && slopeNext < -kPlatterCoalesceToleranceTurns)
            || (slopePrev < -kPlatterCoalesceToleranceTurns
                && slopeNext > kPlatterCoalesceToleranceTurns))
        {
            reduced.push_back(curr);
            continue;
        }

        // Keep points where the interpolated value differs significantly
        const auto timeFraction =
            static_cast<double>(curr.timeUs - prev.timeUs)
            / static_cast<double>(next.timeUs - prev.timeUs);
        const auto interpolated = prev.turns + (next.turns - prev.turns) * timeFraction;
        if (std::abs(curr.turns - interpolated) > kPlatterCoalesceToleranceTurns)
        {
            reduced.push_back(curr);
        }
    }

    reduced.push_back(lane.back());
    lane = std::move(reduced);
}

void ScratchActionRecorder::coalesceCrossfader(std::vector<CrossfaderKeyframe>& lane)
{
    if (lane.size() <= 2)
        return;

    std::vector<CrossfaderKeyframe> reduced;
    reduced.reserve(lane.size());
    reduced.push_back(lane.front());

    for (std::size_t i = 1; i + 1 < lane.size(); ++i)
    {
        const auto& prev = reduced.back();
        const auto& curr = lane[i];
        const auto& next = lane[i + 1];

        const auto timeFraction =
            static_cast<double>(curr.timeUs - prev.timeUs)
            / static_cast<double>(next.timeUs - prev.timeUs);
        const auto interpolated = prev.value + (next.value - prev.value) * timeFraction;
        if (std::abs(curr.value - interpolated) > kCrossfaderCoalesceTolerance)
        {
            reduced.push_back(curr);
        }
    }

    reduced.push_back(lane.back());
    lane = std::move(reduced);
}

} // namespace silverdaw::scratch
