// Unit tests for the analysis-internal beat-grid phase estimator. These drive
// estimateGridPhaseOffset with synthetic onset-detection functions so its
// robustness gates (consistency, match count, latency window) are verified
// deterministically without needing a labelled audio corpus.

#include "TestRegistry.h"

#include "../src/dsp/BpmDetector.h"

#include <cmath>
#include <vector>

namespace silverdaw::tests
{
namespace
{
constexpr double kEnvRate = 200.0; // 5 ms per ODF frame keeps offsets exact.

// One unit impulse (surrounded by zeros) per supplied time, so each registers
// as a strict ODF local maximum at a known frame.
std::vector<double> makeImpulseOdf(double totalSec, const std::vector<double>& peakTimesSec)
{
    std::vector<double> odf(static_cast<size_t>(std::round(totalSec * kEnvRate)), 0.0);
    for (double t : peakTimesSec)
    {
        const int idx = static_cast<int>(std::round(t * kEnvRate));
        if (idx >= 1 && idx + 1 < static_cast<int>(odf.size())) odf[static_cast<size_t>(idx)] = 1.0;
    }
    return odf;
}

void testConsistentOffsetEstimated()
{
    const double period = 0.5; // 120 BPM
    const double trueOffset = 0.030; // beats land 30 ms late
    std::vector<double> peaks;
    for (int n = 0; n < 13; ++n) peaks.push_back(static_cast<double>(n) * period + trueOffset);
    const auto odf = makeImpulseOdf(6.5, peaks);

    double offset = 0.0, spread = 0.0;
    int matched = 0;
    const bool ok = silverdaw::estimateGridPhaseOffset(odf, kEnvRate, period, 0.0, 0.12, offset, matched, spread);
    require(ok, "consistent grid should yield an estimate");
    requireNear(offset, trueOffset, 0.006, "median offset should recover the true lag");
    require(matched >= 12, "almost every grid beat should match an onset peak");
    require(spread <= 0.006, "a constant offset should have near-zero IQR spread");
}

void testZeroOffsetLeavesAnchor()
{
    const double period = 0.5;
    std::vector<double> peaks;
    for (int n = 0; n < 13; ++n) peaks.push_back(static_cast<double>(n) * period);
    const auto odf = makeImpulseOdf(6.5, peaks);

    double offset = 0.0, spread = 0.0;
    int matched = 0;
    const bool ok = silverdaw::estimateGridPhaseOffset(odf, kEnvRate, period, 0.0, 0.12, offset, matched, spread);
    require(ok, "an aligned grid still produces an estimate");
    requireNear(offset, 0.0, 0.003, "an aligned grid should report ~zero offset");
}

void testInconsistentOffsetsFlaggedByMad()
{
    const double period = 0.5;
    // Alternating +/-40 ms jitter: median stays near zero but the spread is high,
    // so the caller's MAD gate refuses to shift the grid.
    std::vector<double> peaks;
    for (int n = 0; n < 13; ++n)
    {
        const double jitter = (n % 2 == 0) ? 0.040 : -0.040;
        peaks.push_back(static_cast<double>(n) * period + jitter);
    }
    const auto odf = makeImpulseOdf(6.5, peaks);

    double offset = 0.0, spread = 0.0;
    int matched = 0;
    const bool ok = silverdaw::estimateGridPhaseOffset(odf, kEnvRate, period, 0.0, 0.12, offset, matched, spread);
    require(ok, "jittered grid still returns an estimate");
    require(spread > 0.030, "alternating jitter should produce a large IQR the caller rejects");
}

void testSparseOnsetsReturnFalse()
{
    const double period = 0.5;
    // Only three onsets across the span — too little evidence to trust an offset.
    const auto odf = makeImpulseOdf(6.5, {0.03, 1.53, 3.03});

    double offset = 0.0, spread = 0.0;
    int matched = 0;
    const bool ok = silverdaw::estimateGridPhaseOffset(odf, kEnvRate, period, 0.0, 0.12, offset, matched, spread);
    require(!ok, "fewer than the minimum matches must not yield an estimate");
}

void testOnsetBeyondWindowNotCaptured()
{
    const double period = 0.5;
    // Onsets are a full 0.2 s late — outside the 0.12 s search window — so no
    // grid beat finds a nearby peak and the estimator declines rather than
    // locking onto an unrelated onset.
    std::vector<double> peaks;
    for (int n = 0; n < 13; ++n) peaks.push_back(static_cast<double>(n) * period + 0.20);
    const auto odf = makeImpulseOdf(6.5, peaks);

    double offset = 0.0, spread = 0.0;
    int matched = 0;
    const bool ok = silverdaw::estimateGridPhaseOffset(odf, kEnvRate, period, 0.0, 0.12, offset, matched, spread);
    require(!ok, "onsets outside the latency window should not be matched");
}

} // namespace

void addBpmDetectorTests(std::vector<TestCase>& tests)
{
    tests.push_back({"Grid phase: constant offset is recovered", testConsistentOffsetEstimated});
    tests.push_back({"Grid phase: aligned grid reports ~zero", testZeroOffsetLeavesAnchor});
    tests.push_back({"Grid phase: inconsistent jitter flagged by MAD", testInconsistentOffsetsFlaggedByMad});
    tests.push_back({"Grid phase: sparse onsets decline", testSparseOnsetsReturnFalse});
    tests.push_back({"Grid phase: onsets beyond window decline", testOnsetBeyondWindowNotCaptured});
}

} // namespace silverdaw::tests
