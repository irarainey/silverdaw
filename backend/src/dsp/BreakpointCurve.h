#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <vector>

namespace silverdaw
{

// Interpolation domain for a breakpoint curve. `linear` covers signed positions,
// 0..1 ranges, and already-logarithmic units (dB values). `decibel` interpolates
// a *linear gain* in log space (the per-clip volume envelope's law).
enum class InterpDomain
{
    linear,
    decibel
};

// Immutable, real-time-safe breakpoint curve. Built on the message thread, then
// published by pointer to the audio thread (never mutate after `finalise()`).
// The caller holds a bidirectional segment cursor so block evaluation is O(1)
// amortised during forward playback and O(distance) on a seek — no per-sample
// search, no allocation, no locking. Generic counterpart of the clip
// `EnvelopeSnapshot`; reused by per-track automation.
class BreakpointCurve
{
  public:
    struct Point
    {
        double timeMs;  // timeline-absolute milliseconds (sorted ascending)
        float value;    // value in the parameter's native unit
        float aux;      // precomputed dB for the decibel domain; unused otherwise
    };

    BreakpointCurve() = default;
    explicit BreakpointCurve(InterpDomain d) : domain(d) {}

    void setDomain(InterpDomain d) noexcept { domain = d; }
    InterpDomain getDomain() const noexcept { return domain; }

    void reserve(std::size_t n) { points.reserve(n); }

    /** Append a breakpoint (message thread only). Call `finalise()` once done. */
    void addPoint(double timeMs, float value)
    {
        const float aux =
            domain == InterpDomain::decibel
                ? static_cast<float>(20.0 * std::log10(std::max<double>(value, kFloor)))
                : 0.0F;
        points.push_back({std::max(0.0, timeMs), value, aux});
    }

    /** Sort by time so the RT cursor walk is monotone-correct. */
    void finalise()
    {
        std::sort(points.begin(), points.end(),
                  [](const Point& a, const Point& b) { return a.timeMs < b.timeMs; });
    }

    bool isEmpty() const noexcept { return points.size() < 2; }
    std::size_t size() const noexcept { return points.size(); }
    const std::vector<Point>& getPoints() const noexcept { return points; }

    /** RT-safe sample at timeline `ms`. `seg` is the caller's persistent cursor;
     *  it walks forward on playback and backward on a seek/loop. */
    float valueAtMs(double ms, std::size_t& seg) const noexcept
    {
        const std::size_t n = points.size();
        if (n == 0) return 0.0F;
        if (n == 1) return points[0].value;

        const std::size_t lastSeg = n - 2;
        if (seg > lastSeg) seg = lastSeg;
        while (seg < lastSeg && ms >= points[seg + 1].timeMs) ++seg;
        while (seg > 0 && ms < points[seg].timeMs) --seg;

        const Point& a = points[seg];
        const Point& b = points[seg + 1];
        if (ms <= a.timeMs) return a.value;
        if (ms >= b.timeMs) return b.value;

        const double frac = (ms - a.timeMs) / (b.timeMs - a.timeMs);
        if (domain == InterpDomain::decibel)
        {
            const double db = static_cast<double>(a.aux) +
                              (static_cast<double>(b.aux) - static_cast<double>(a.aux)) * frac;
            return static_cast<float>(std::pow(10.0, db / 20.0));
        }
        return static_cast<float>(static_cast<double>(a.value) +
                                  (static_cast<double>(b.value) - static_cast<double>(a.value)) * frac);
    }

  private:
    static constexpr double kFloor = 1.0e-5;  // ≈ -100 dB

    InterpDomain domain = InterpDomain::linear;
    std::vector<Point> points;
};

} // namespace silverdaw
