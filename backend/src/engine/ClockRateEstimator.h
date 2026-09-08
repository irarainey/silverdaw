#pragma once

#include <array>
#include <atomic>
#include <cmath>
#include <juce_core/juce_core.h>

namespace silverdaw
{

/**
 * Estimates an audio device's true frame rate by least squares over many
 * (frames delivered, wall clock) pairs sampled on the audio thread.
 *
 * The naive alternative — divide the frames captured by the wall time between the first
 * and last callback — rests the whole answer on two timestamps, so the callback scheduling
 * noise at each end lands undiluted on the result. Its fractional error is roughly the
 * endpoint noise divided by the span: with a millisecond of noise, a five-second take
 * yields ~280 ppm, which is several times LARGER than the 20-100 ppm of crystal mismatch
 * between two consumer devices that it is meant to be correcting. A regression over every
 * block averages that noise down instead, and — more importantly — it also reports how
 * uncertain it is, so the caller can decline to "correct" anything it cannot actually see.
 *
 * Points are decimated so a long take costs a bounded amount of memory while still
 * spanning its whole length. Accumulation is allocation- and lock-free; the fit runs on
 * the message thread once the callback is known to have quiesced.
 */
class ClockRateEstimator
{
  public:
    struct Estimate
    {
        double rate = 0.0;         ///< Frames per wall second.
        double ppmStdError = 0.0;  ///< One-sigma uncertainty of `rate`, in ppm.
        double spanSeconds = 0.0;
        int points = 0;
        bool usable = false;
    };

    /** Message thread, with the device stopped (or before it starts): the audio thread
     *  owns this state while streaming. */
    void reset() noexcept
    {
        count = 0;
        stride = 1;
        sinceLast = 0;
        publishedCount.store(0, std::memory_order_release);
    }

    /**
     * Audio thread. `frames` is the cumulative frame count BEFORE this block — i.e. the
     * index of the block's first frame — and `ticks` a high-resolution stamp taken at
     * callback entry. The fixed gap between the two (the device filled the buffer before
     * handing it over) is a constant, which the fitted intercept absorbs without biasing
     * the slope.
     */
    void addBlock(juce::int64 frames, juce::int64 ticks) noexcept
    {
        if (++sinceLast < stride) return;
        sinceLast = 0;

        if (count >= kCapacity)
        {
            // Keep every second point and halve the sampling rate, so the span keeps growing
            // within a fixed buffer. O(kCapacity), but reached only once per kCapacity/2
            // recorded points — many minutes of audio — and a strided copy of a few thousand
            // PODs is microseconds inside a block period.
            for (int i = 0; i < kCapacity / 2; ++i)
                points[static_cast<size_t>(i)] = points[static_cast<size_t>(i * 2)];
            count = kCapacity / 2;
            stride *= 2;
        }

        points[static_cast<size_t>(count++)] = {frames, ticks};
        publishedCount.store(count, std::memory_order_release);
    }

    /**
     * Message thread, once the audio callback has quiesced. Fits frames against seconds,
     * discards points more than three residual sigma out (a scheduling stall shows up as a
     * single displaced stamp, not a change of rate) and refits.
     */
    Estimate estimate() const noexcept
    {
        Estimate result;
        const int n = publishedCount.load(std::memory_order_acquire);
        if (n < kMinPoints) return result;

        const auto perSecond = juce::Time::getHighResolutionTicksPerSecond();
        if (perSecond <= 0) return result;

        const auto& first = points[0];
        std::array<double, kCapacity> seconds{};
        std::array<double, kCapacity> frames{};
        for (int i = 0; i < n; ++i)
        {
            const auto index = static_cast<size_t>(i);
            seconds[index] = static_cast<double>(points[index].ticks - first.ticks)
                             / static_cast<double>(perSecond);
            frames[index] = static_cast<double>(points[index].frames - first.frames);
        }

        result.spanSeconds = seconds[static_cast<size_t>(n - 1)];
        if (result.spanSeconds <= 0.0) return result;

        std::array<bool, kCapacity> keep{};
        for (int i = 0; i < n; ++i) keep[static_cast<size_t>(i)] = true;

        Fit fit = fitLine(seconds, frames, keep, n);
        if (! fit.valid) return result;

        // One trimming pass. Refitting after it is what stops a single stalled callback from
        // tilting the line; iterating further would start discarding real data.
        if (fit.sigma > 0.0)
        {
            int dropped = 0;
            for (int i = 0; i < n; ++i)
            {
                const auto index = static_cast<size_t>(i);
                const double residual =
                    frames[index] - (fit.intercept + fit.slope * seconds[index]);
                if (std::abs(residual) > kOutlierSigmas * fit.sigma)
                {
                    keep[index] = false;
                    ++dropped;
                }
            }
            if (dropped > 0 && n - dropped >= kMinPoints)
            {
                const Fit refit = fitLine(seconds, frames, keep, n);
                if (refit.valid) fit = refit;
            }
        }

        if (fit.slope <= 0.0) return result;

        result.rate = fit.slope;
        result.points = fit.points;
        // Standard error of the slope: residual spread divided by the spread of the times
        // it is measured over, which is why a longer take earns a tighter answer.
        result.ppmStdError = fit.sumSquaredDeviation > 0.0
                                 ? 1.0e6 * (fit.sigma / std::sqrt(fit.sumSquaredDeviation))
                                       / fit.slope
                                 : 0.0;
        result.usable = true;
        return result;
    }

  private:
    // ~4 k points at 64 KB. With one point per callback that is minutes of audio before the
    // first halving, and every halving doubles the reach.
    static constexpr int kCapacity = 4096;
    // Enough points for the residual spread to mean anything. At a 10 ms block this is a
    // third of a second, so it only ever rejects a take that barely happened.
    static constexpr int kMinPoints = 32;
    static constexpr double kOutlierSigmas = 3.0;

    struct Point
    {
        juce::int64 frames = 0;
        juce::int64 ticks = 0;
    };

    struct Fit
    {
        double slope = 0.0;
        double intercept = 0.0;
        double sigma = 0.0;                 ///< Residual standard deviation, in frames.
        double sumSquaredDeviation = 0.0;   ///< Sum of (t - mean t)^2, in seconds squared.
        int points = 0;
        bool valid = false;
    };

    static Fit fitLine(const std::array<double, kCapacity>& x,
                       const std::array<double, kCapacity>& y,
                       const std::array<bool, kCapacity>& keep, int n) noexcept
    {
        Fit fit;
        double sumX = 0.0;
        double sumY = 0.0;
        int kept = 0;
        for (int i = 0; i < n; ++i)
        {
            const auto index = static_cast<size_t>(i);
            if (! keep[index]) continue;
            sumX += x[index];
            sumY += y[index];
            ++kept;
        }
        if (kept < kMinPoints) return fit;

        const double meanX = sumX / kept;
        const double meanY = sumY / kept;
        double sxx = 0.0;
        double sxy = 0.0;
        for (int i = 0; i < n; ++i)
        {
            const auto index = static_cast<size_t>(i);
            if (! keep[index]) continue;
            const double dx = x[index] - meanX;
            sxx += dx * dx;
            sxy += dx * (y[index] - meanY);
        }
        if (sxx <= 0.0) return fit;

        fit.slope = sxy / sxx;
        fit.intercept = meanY - fit.slope * meanX;
        fit.sumSquaredDeviation = sxx;
        fit.points = kept;

        double sumSquaredResiduals = 0.0;
        for (int i = 0; i < n; ++i)
        {
            const auto index = static_cast<size_t>(i);
            if (! keep[index]) continue;
            const double residual = y[index] - (fit.intercept + fit.slope * x[index]);
            sumSquaredResiduals += residual * residual;
        }
        // Two degrees of freedom go to the slope and the intercept.
        fit.sigma = kept > 2 ? std::sqrt(sumSquaredResiduals / (kept - 2)) : 0.0;
        fit.valid = true;
        return fit;
    }

    std::array<Point, kCapacity> points{};
    // Audio-thread-owned; published to the message thread through `publishedCount`.
    int count = 0;
    int stride = 1;
    int sinceLast = 0;
    std::atomic<int> publishedCount{0};
};

} // namespace silverdaw
