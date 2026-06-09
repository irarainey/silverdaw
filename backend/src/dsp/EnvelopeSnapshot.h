#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <memory>
#include <vector>

#include <juce_core/juce_core.h>

namespace silverdaw
{

// Immutable envelope published to the audio thread by pointer; never mutate after construction.
// Linear-in-dB interpolation gives perceptual fades, while fewer than two points means identity.
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

    /** Defensively clamps/sorts persisted points so the audio thread sees a valid snapshot. */
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

    /** RT-safe; caller's monotonic `seg` cursor makes block evaluation O(1) amortised. */
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

    /** Compact, message-thread-only summary for diagnostic logging (not RT-safe). */
    juce::String describe() const
    {
        juce::String s;
        s << "n=" << static_cast<int>(points.size());
        const std::size_t shown = std::min<std::size_t>(points.size(), 8);
        s << " [";
        for (std::size_t i = 0; i < shown; ++i)
        {
            if (i > 0) s << ", ";
            s << juce::String(points[i].timeMs, 0) << "ms:"
              << juce::String(points[i].gainLinear, 3);
        }
        if (points.size() > shown) s << ", ...";
        s << "]";
        return s;
    }

  private:
    // Lets true-zero breakpoints fade smoothly instead of dropping instantly.
    static constexpr double kGainFloor = 1.0e-5;

    std::vector<Point> points;
};

} // namespace silverdaw
