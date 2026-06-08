#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <memory>
#include <vector>

#include <juce_core/juce_core.h>

namespace silverdaw
{

/**
 * Immutable, audio-thread-readable per-clip volume envelope.
 *
 * Breakpoints are `(clip-local post-warp milliseconds, linear gain)`.
 * Interpolation between adjacent breakpoints is **linear in decibels**
 * (geometric in gain), which gives a musically natural ramp to and from
 * silence rather than the perceptually lumpy curve of linear-in-gain.
 *
 * Lifetime / threading: built off the audio thread, then published to it
 * as a `const EnvelopeSnapshot*` (release/acquire). Never mutated after
 * construction, so concurrent reads on the audio thread are safe. The
 * owning `Track` keeps the live instance alive and retires replaced
 * instances into a deferred free-list (drained when the transport is
 * quiescent) — mirroring the `WarpProcessor` retire discipline.
 *
 * An envelope with fewer than two points is "empty": callers treat it as
 * no envelope at all so the no-shape common path is bit-identical to
 * pre-envelope output.
 */
class EnvelopeSnapshot
{
  public:
    struct Point
    {
        double timeMs;     // clip-local post-warp milliseconds (sorted ascending)
        float gainLinear;  // exact linear gain at the breakpoint, [0, 4]
        float gainDb;      // 20*log10(max(gainLinear, floor)) for dB-linear interp
    };

    EnvelopeSnapshot() = default;

    /** Build from the persisted point array (objects carrying `"timeMs"`
     *  and `"gain"`). `ProjectState` already normalises order and range,
     *  but we defensively clamp and sort so a snapshot is always valid.
     *  Returns an instance whose `isEmpty()` is true when fewer than two
     *  usable points remain. */
    static std::unique_ptr<EnvelopeSnapshot> fromVarArray(const juce::Array<juce::var>& arr)
    {
        auto snap = std::make_unique<EnvelopeSnapshot>();
        snap->points.reserve(static_cast<std::size_t>(arr.size()));
        for (const auto& v : arr)
        {
            if (!v.isObject()) continue;
            const double t = juce::jmax(0.0, static_cast<double>(v.getProperty("timeMs", 0.0)));
            const double g = juce::jlimit(0.0, 4.0, static_cast<double>(v.getProperty("gain", 1.0)));
            snap->points.push_back(
                {t, static_cast<float>(g),
                 static_cast<float>(20.0 * std::log10(std::max(g, kGainFloor)))});
        }
        std::sort(snap->points.begin(), snap->points.end(),
                  [](const Point& a, const Point& b) { return a.timeMs < b.timeMs; });
        return snap;
    }

    bool isEmpty() const noexcept { return points.size() < 2; }

    /** Linear-in-dB gain at clip-local `ms`. `seg` is an in/out cursor the
     *  caller advances monotonically across a block so evaluation is O(1)
     *  amortised rather than a binary search per sample. RT-safe: no
     *  allocation, no locking. Clamps to the endpoint gains outside the
     *  breakpoint range. */
    float gainAtMs(double ms, std::size_t& seg) const noexcept
    {
        const std::size_t n = points.size();
        if (n == 0) return 1.0F;
        if (n == 1) return points[0].gainLinear;

        const std::size_t lastSeg = n - 2;
        if (seg > lastSeg) seg = lastSeg;
        while (seg < lastSeg && ms >= points[seg + 1].timeMs) ++seg;
        while (seg > 0 && ms < points[seg].timeMs) --seg;

        const Point& a = points[seg];
        const Point& b = points[seg + 1];
        if (ms <= a.timeMs) return a.gainLinear;
        if (ms >= b.timeMs) return b.gainLinear;

        const double frac = (ms - a.timeMs) / (b.timeMs - a.timeMs);
        const double db = static_cast<double>(a.gainDb) +
                          (static_cast<double>(b.gainDb) - static_cast<double>(a.gainDb)) * frac;
        return static_cast<float>(std::pow(10.0, db / 20.0));
    }

    const std::vector<Point>& getPoints() const noexcept { return points; }

  private:
    // ~-100 dB floor so a true-zero breakpoint interpolates as a smooth
    // exponential ramp toward silence instead of an instantaneous drop.
    static constexpr double kGainFloor = 1.0e-5;

    std::vector<Point> points;
};

} // namespace silverdaw
