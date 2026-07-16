#include "ScratchActionRecorder.h"

#include <algorithm>
#include <cmath>
#include <chrono>
#include <utility>

namespace silverdaw::scratch
{
namespace
{
// Reserve one slot for the mandatory final keyframe appended at stop().
constexpr std::int64_t kMaxLivePlatterPoints = kMaxPatternPoints - 1;
constexpr std::int64_t kMaxLiveCrossfaderPoints = kMaxPatternPoints - 1;
constexpr std::int64_t kPlatterCaptureIntervalUs = 8000;
constexpr std::int64_t kCrossfaderCaptureIntervalUs = 16000;
// Simplification tolerances (the RDP epsilon): the largest value error, in the
// lane's own units, that a dropped keyframe may introduce against the retained
// piecewise-linear curve. Platter is in turns (0.002 turns ≈ 0.72° of platter
// rotation); crossfader is the normalised 0..1 fader position.
constexpr double kPlatterCoalesceToleranceTurns = 0.002;
constexpr double kCrossfaderCoalesceTolerance = 0.01;

// Ramer–Douglas–Peucker simplification over the inclusive index range [lo, hi],
// whose endpoints are already retained. Deviation is measured *vertically* — the
// value error at each point's own timestamp against the chord — so the guarantee
// is a direct bound on the retained curve's positional error and is independent
// of the time-axis scale. Local extrema (a scratch's direction reversals) survive
// because a reversal sits far from any chord spanning it. Iterative (explicit
// stack) to avoid unbounded recursion on long takes.
template <typename Keyframe, typename ValueFn>
void rdpMarkKeep(const std::vector<Keyframe>& pts,
                 std::size_t lo,
                 std::size_t hi,
                 double epsilon,
                 ValueFn valueOf,
                 std::vector<char>& keep)
{
    std::vector<std::pair<std::size_t, std::size_t>> stack;
    stack.emplace_back(lo, hi);
    while (!stack.empty())
    {
        const auto [a, b] = stack.back();
        stack.pop_back();
        if (b <= a + 1)
            continue; // no interior points to test

        const double va = valueOf(pts[a]);
        const double vb = valueOf(pts[b]);
        const double ta = static_cast<double>(pts[a].timeUs);
        const double tb = static_cast<double>(pts[b].timeUs);
        const double dt = tb - ta;

        double maxDeviation = -1.0;
        std::size_t maxIndex = a;
        for (std::size_t i = a + 1; i < b; ++i)
        {
            const double t = static_cast<double>(pts[i].timeUs);
            const double interpolated =
                dt > 0.0 ? va + (vb - va) * ((t - ta) / dt) : va;
            const double deviation = std::abs(valueOf(pts[i]) - interpolated);
            if (deviation > maxDeviation)
            {
                maxDeviation = deviation;
                maxIndex = i;
            }
        }

        // Keep the worst offender and recurse into both halves; otherwise every
        // interior point is within tolerance of the chord and can be dropped.
        if (maxDeviation > epsilon)
        {
            keep[maxIndex] = 1;
            stack.emplace_back(a, maxIndex);
            stack.emplace_back(maxIndex, b);
        }
    }
}
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
    recordPlatterAt(elapsedUs(), absoluteTurns, touched);
}

void ScratchActionRecorder::recordPlatterAt(
    std::int64_t timeUs, double absoluteTurns, bool touched)
{
    std::lock_guard<std::mutex> lock(mutex);
    if (currentState.load(std::memory_order_relaxed) != State::recording)
        return;

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

    const std::size_t last = lane.size() - 1;
    std::vector<char> keep(lane.size(), 0);
    keep[0] = 1;
    keep[last] = 1;

    // Touch state is semantically load-bearing (it gates replay and rendering),
    // so a touch transition is force-kept on both sides and RDP runs *within*
    // each constant-touch run. This keeps every touch change while still
    // simplifying the movement inside a run.
    std::size_t runStart = 0;
    for (std::size_t i = 1; i < lane.size(); ++i)
    {
        if (lane[i].touched != lane[i - 1].touched)
        {
            keep[i - 1] = 1;
            keep[i] = 1;
            rdpMarkKeep(lane, runStart, i - 1, kPlatterCoalesceToleranceTurns,
                        [](const PlatterKeyframe& k) { return k.turns; }, keep);
            runStart = i;
        }
    }
    rdpMarkKeep(lane, runStart, last, kPlatterCoalesceToleranceTurns,
                [](const PlatterKeyframe& k) { return k.turns; }, keep);

    std::vector<PlatterKeyframe> reduced;
    reduced.reserve(lane.size());
    for (std::size_t i = 0; i < lane.size(); ++i)
        if (keep[i] != 0)
            reduced.push_back(lane[i]);
    lane = std::move(reduced);
}

void ScratchActionRecorder::coalesceCrossfader(std::vector<CrossfaderKeyframe>& lane)
{
    if (lane.size() <= 2)
        return;

    const std::size_t last = lane.size() - 1;
    std::vector<char> keep(lane.size(), 0);
    keep[0] = 1;
    keep[last] = 1;
    rdpMarkKeep(lane, 0, last, kCrossfaderCoalesceTolerance,
                [](const CrossfaderKeyframe& k) { return k.value; }, keep);

    std::vector<CrossfaderKeyframe> reduced;
    reduced.reserve(lane.size());
    for (std::size_t i = 0; i < lane.size(); ++i)
        if (keep[i] != 0)
            reduced.push_back(lane[i]);
    lane = std::move(reduced);
}

} // namespace silverdaw::scratch
