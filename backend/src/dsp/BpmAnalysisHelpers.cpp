#include "BpmAnalysisHelpers.h"
#include "BpmDetector.h"

#include <OnsetDetectionFunction.h>
#include <algorithm>
#include <cmath>
#include <juce_core/juce_core.h>
#include <limits>
#include <numeric>
#include <utility>
#include <vector>

namespace silverdaw
{
namespace bpm_detail
{

// Robust LSQ grid fit; returns RMS residual so candidates can be compared.
bool fitPeriodAndAnchor(const std::vector<double>& beats, double initialPeriod, double initialAnchor,
                        double& outPeriod, double& outAnchor, double& outRmsResidual, int& outKeptCount)
{
    if (beats.size() < 6 || initialPeriod <= 0.0) return false;

    double period = initialPeriod;
    double anchor = initialAnchor;
    std::vector<std::pair<int, double>> kept;
    for (int iter = 0; iter < 3; ++iter)
    {
        kept.clear();
        kept.reserve(beats.size());
        for (double t : beats)
        {
            const double n = std::round((t - anchor) / period);
            const double predicted = anchor + n * period;
            if (std::abs(t - predicted) <= period * 0.25)
            {
                kept.emplace_back(static_cast<int>(n), t);
            }
        }
        if (kept.size() < 4) return false;

        long double sumN = 0, sumT = 0, sumNN = 0, sumNT = 0;
        for (auto& [n, t] : kept)
        {
            sumN += n;
            sumT += t;
            sumNN += static_cast<long double>(n) * n;
            sumNT += static_cast<long double>(n) * t;
        }
        const long double K = static_cast<long double>(kept.size());
        const long double denom = K * sumNN - sumN * sumN;
        if (denom <= 0.0L) return false;
        const long double newPeriod = (K * sumNT - sumN * sumT) / denom;
        const long double newAnchor = (sumT - newPeriod * sumN) / K;
        if (newPeriod < 0.05L || newPeriod > 2.0L) return false;
        period = static_cast<double>(newPeriod);
        anchor = static_cast<double>(newAnchor);
    }

    long double sse = 0;
    for (auto& [n, t] : kept)
    {
        const double r = t - (anchor + n * period);
        sse += static_cast<long double>(r) * r;
    }
    outPeriod = period;
    outAnchor = anchor;
    outRmsResidual = std::sqrt(static_cast<double>(sse / static_cast<long double>(kept.size())));
    outKeptCount = static_cast<int>(kept.size());
    return true;
}

// Recompute BTrack-style ODF because BTrack's private buffer is resampled and unavailable.
std::vector<double> computeOdf(const std::vector<float>& signal, int envHop)
{
    if (signal.empty() || envHop <= 0) return {};
    constexpr int kOdfFrame = 1024;
    OnsetDetectionFunction odf(envHop, kOdfFrame, ComplexSpectralDifferenceHWR, HanningWindow);
    std::vector<double> hop(static_cast<size_t>(envHop), 0.0);
    const size_t frames = signal.size() / static_cast<size_t>(envHop);
    std::vector<double> values;
    values.reserve(frames);
    for (size_t i = 0; i < frames; ++i)
    {
        const size_t base = i * static_cast<size_t>(envHop);
        for (int k = 0; k < envHop; ++k)
        {
            hop[static_cast<size_t>(k)] = static_cast<double>(signal[base + static_cast<size_t>(k)]);
        }
        const double v = odf.calculateOnsetDetectionFunctionSample(hop.data());
        values.push_back(std::isfinite(v) && v > 0.0 ? v : 0.0);
    }
    return values;
}

// Rayleigh weighting keeps autocorrelation near BTrack's octave instead of latching onto half-time.
double autocorrPreferredLag(const std::vector<double>& odf, int minLag, int maxLag, double preferredLag)
{
    if (odf.size() < static_cast<size_t>(maxLag + 4) || minLag < 1 || maxLag <= minLag) return 0.0;

    // Demean ODF so a DC bias doesn't dominate long-lag correlations.
    const double mean = std::accumulate(odf.begin(), odf.end(), 0.0) / static_cast<double>(odf.size());
    std::vector<double> centered(odf.size());
    for (size_t i = 0; i < odf.size(); ++i) centered[i] = odf[i] - mean;

    const int range = maxLag - minLag + 1;
    std::vector<double> ac(static_cast<size_t>(range), 0.0);
    const int frames = static_cast<int>(centered.size());
    for (int lag = minLag; lag <= maxLag; ++lag)
    {
        double sum = 0.0;
        for (int n = lag; n < frames; ++n) sum += centered[static_cast<size_t>(n)] * centered[static_cast<size_t>(n - lag)];
        // Normalise by pair count so longer lags are comparable.
        ac[static_cast<size_t>(lag - minLag)] = sum / static_cast<double>(frames - lag);
    }

    // Centre the Rayleigh prior on BTrack's lag while still allowing nearby correction.
    if (preferredLag > 1.0)
    {
        const double beta = preferredLag;
        for (int lag = minLag; lag <= maxLag; ++lag)
        {
            const double x = static_cast<double>(lag);
            const double w = (x / (beta * beta)) * std::exp(-(x * x) / (2.0 * beta * beta));
            ac[static_cast<size_t>(lag - minLag)] *= w;
        }
    }

    int bestIdx = -1;
    double bestVal = -std::numeric_limits<double>::infinity();
    for (int i = 0; i < range; ++i)
    {
        if (ac[static_cast<size_t>(i)] > bestVal)
        {
            bestVal = ac[static_cast<size_t>(i)];
            bestIdx = i;
        }
    }
    if (bestIdx <= 0 || bestIdx >= range - 1) return 0.0;

    const double y0 = ac[static_cast<size_t>(bestIdx - 1)];
    const double y1 = ac[static_cast<size_t>(bestIdx)];
    const double y2 = ac[static_cast<size_t>(bestIdx + 1)];
    double frac = 0.0;
    const double denom = y0 - 2.0 * y1 + y2;
    if (std::abs(denom) > 1e-12)
    {
        const double d = 0.5 * (y0 - y2) / denom;
        if (std::abs(d) <= 1.0) frac = d;
    }
    return static_cast<double>(minLag + bestIdx) + frac;
}

// Align the refined beat grid to the ODF energy peak; fall back if the ODF is ambiguous.
double findBestAnchor(const std::vector<double>& odf, double envRate, double periodSec, double fallbackAnchor)
{
    if (odf.empty() || envRate <= 0.0 || periodSec <= 0.0) return fallbackAnchor;
    const int periodFrames = std::max(2, static_cast<int>(std::round(envRate * periodSec)));
    const int totalFrames = static_cast<int>(odf.size());
    if (totalFrames < periodFrames * 2) return fallbackAnchor;

    int bestPhase = 0;
    double bestSum = -std::numeric_limits<double>::infinity();
    for (int phase = 0; phase < periodFrames; ++phase)
    {
        double sum = 0.0;
        for (int n = phase; n < totalFrames; n += periodFrames) sum += odf[static_cast<size_t>(n)];
        if (sum > bestSum)
        {
            bestSum = sum;
            bestPhase = phase;
        }
    }
    // Wrap interpolation so anchors near the period boundary can move either way.
    auto phaseSum = [&](int p) {
        if (p < 0) p += periodFrames;
        if (p >= periodFrames) p -= periodFrames;
        double s = 0.0;
        for (int n = p; n < totalFrames; n += periodFrames) s += odf[static_cast<size_t>(n)];
        return s;
    };
    const double y0 = phaseSum(bestPhase - 1);
    const double y1 = phaseSum(bestPhase);
    const double y2 = phaseSum(bestPhase + 1);
    double frac = 0.0;
    const double denom = y0 - 2.0 * y1 + y2;
    if (std::abs(denom) > 1e-12)
    {
        const double d = 0.5 * (y0 - y2) / denom;
        if (std::abs(d) <= 1.0) frac = d;
    }
    return (bestPhase + frac) / envRate;
}

// Score candidate grids by RMS residual against BTrack beats.
void scoreGridAgainstBeats(const std::vector<double>& beats, double period, double anchor,
                           double& outRms, int& outKept)
{
    outRms = std::numeric_limits<double>::infinity();
    outKept = 0;
    if (beats.empty() || period <= 0.0) return;
    long double sse = 0.0L;
    int kept = 0;
    for (double t : beats)
    {
        const double n = std::round((t - anchor) / period);
        const double pred = anchor + n * period;
        const double r = t - pred;
        if (std::abs(r) <= period * 0.25)
        {
            sse += static_cast<long double>(r) * r;
            ++kept;
        }
    }
    if (kept == 0) return;
    outRms = std::sqrt(static_cast<double>(sse / static_cast<long double>(kept)));
    outKept = kept;
}

} // namespace bpm_detail

namespace
{
constexpr int kMinPhaseMatches = 8;
}

double circularMeanAnchor(const std::vector<double>& beats, double periodSec)
{
    if (beats.empty()) return 0.0;
    if (periodSec <= 0.0) return beats.front();

    const double twoPi = 2.0 * juce::MathConstants<double>::pi;
    double sinSum = 0.0;
    double cosSum = 0.0;
    for (double t : beats)
    {
        const double frac = t / periodSec - std::floor(t / periodSec); // phase in [0, 1)
        const double ang = frac * twoPi;
        sinSum += std::sin(ang);
        cosSum += std::cos(ang);
    }
    if (std::abs(sinSum) < 1e-12 && std::abs(cosSum) < 1e-12) return beats.front();

    double ang = std::atan2(sinSum, cosSum);
    if (ang < 0.0) ang += twoPi;
    const double phaseSec = ang / twoPi * periodSec; // [0, periodSec)

    // Place the anchor in the same period bin as the first beat so it stays near
    // the track start (keeps grid backfill/render stable), choosing the nearest
    // equivalent phase to the first beat.
    const double first = beats.front();
    double anchor = std::floor(first / periodSec) * periodSec + phaseSec;
    while (anchor > first + periodSec * 0.5) anchor -= periodSec;
    while (anchor < first - periodSec * 0.5) anchor += periodSec;
    return anchor;
}

std::vector<double> subtractMovingMedianFloor(const std::vector<double>& odf, double envRate,
                                              double approxPeriodSec)
{
    const int n = static_cast<int>(odf.size());
    if (n < 16 || envRate <= 0.0) return odf;

    // Window half-width ~1 beat (total ~2 beats): long enough that the median
    // sits on the inter-onset floor and is never pulled up by the onset peaks we
    // want to keep, short enough to track genuine dynamic changes across the
    // track. Clamped so implausible tempos can't degenerate the window.
    const double winSec = juce::jlimit(0.30, 1.20, (approxPeriodSec > 0.0 ? approxPeriodSec : 0.5));
    int half = std::max(3, static_cast<int>(std::lround(winSec * envRate)));
    if (2 * half + 1 > n) half = (n - 1) / 2;

    std::vector<double> out(static_cast<size_t>(n), 0.0);
    std::vector<double> window;
    window.reserve(static_cast<size_t>(2 * half + 1));
    for (int i = 0; i < n; ++i)
    {
        const int lo = std::max(0, i - half);
        const int hi = std::min(n - 1, i + half);
        window.assign(odf.begin() + lo, odf.begin() + hi + 1);
        const size_t mid = window.size() / 2;
        std::nth_element(window.begin(), window.begin() + static_cast<std::ptrdiff_t>(mid), window.end());
        const double v = odf[static_cast<size_t>(i)] - window[mid];
        out[static_cast<size_t>(i)] = v > 0.0 ? v : 0.0;
    }
    return out;
}

bool estimateGridPhaseOffset(const std::vector<double>& odf, double envRate, double periodSec,
                             double anchorSec, double maxOffsetSec, double& outOffsetSec,
                             int& outMatched, double& outSpread)
{
    outOffsetSec = 0.0;
    outMatched = 0;
    outSpread = 0.0;
    if (odf.size() < 16 || envRate <= 0.0 || periodSec <= 0.0 || maxOffsetSec <= 0.0) return false;

    const double totalSec = static_cast<double>(odf.size()) / envRate;
    // Search radius below a quarter-beat so we never latch onto a neighbouring
    // eighth-note onset instead of the beat we are aligning to.
    const double win = std::min(maxOffsetSec, periodSec * 0.25);
    const int maxIdx = static_cast<int>(odf.size()) - 2;

    std::vector<double> offsets;
    const int firstN = static_cast<int>(std::ceil((0.0 - anchorSec) / periodSec));
    for (int n = firstN;; ++n)
    {
        const double beatT = anchorSec + static_cast<double>(n) * periodSec;
        if (beatT < 0.0) continue;
        if (beatT > totalSec) break;

        const int lo = std::max(1, static_cast<int>(std::floor((beatT - win) * envRate)));
        const int hi = std::min(maxIdx, static_cast<int>(std::ceil((beatT + win) * envRate)));
        if (hi <= lo) continue;

        int bestI = -1;
        double bestV = 0.0;
        for (int i = lo; i <= hi; ++i)
        {
            const double v = odf[static_cast<size_t>(i)];
            // Strict local maximum so flat/noise plateaus do not register.
            if (v > odf[static_cast<size_t>(i - 1)] && v >= odf[static_cast<size_t>(i + 1)] && v > bestV)
            {
                bestV = v;
                bestI = i;
            }
        }
        if (bestI < 0) continue;

        const double y0 = odf[static_cast<size_t>(bestI - 1)];
        const double y1 = odf[static_cast<size_t>(bestI)];
        const double y2 = odf[static_cast<size_t>(bestI + 1)];
        double frac = 0.0;
        const double denom = y0 - 2.0 * y1 + y2;
        if (std::abs(denom) > 1e-12)
        {
            const double d = 0.5 * (y0 - y2) / denom;
            if (std::abs(d) <= 1.0) frac = d;
        }
        const double peakT = (static_cast<double>(bestI) + frac) / envRate;
        offsets.push_back(peakT - beatT);
    }

    if (static_cast<int>(offsets.size()) < kMinPhaseMatches) return false;
    std::sort(offsets.begin(), offsets.end());
    const size_t count = offsets.size();
    const double median = offsets[count / 2];
    // IQR spread, not median-absolute-deviation: a bimodal early/late jitter
    // (half the beats consistently early, half late) leaves MAD at zero while
    // the IQR stays wide, so the caller correctly refuses to shift the grid.
    const double q1 = offsets[count / 4];
    const double q3 = offsets[(count * 3) / 4];

    outOffsetSec = median;
    outMatched = static_cast<int>(count);
    outSpread = q3 - q1;
    return true;
}

// Refine period+anchor by least-squares over sub-frame ODF onset peaks across
// the whole analysed span. BTrack beats are hop-quantised (256 samples) with a
// structured, phase-correlated latency that biases the LSQ slope; the
// parabolically-interpolated ODF peaks give sub-sample, slope-unbiased positions
// with a long lever arm, which sharpens the period. groupDelaySec removes the
// ODF's constant onset latency so the fitted anchor lands on the transient.
// Returns false when too few grid lines find a confident onset peak.
bool refineGridFromOdfPeaks(const std::vector<double>& odf, double envRate, double groupDelaySec,
                            double periodSec, double anchorSec, double& outPeriod, double& outAnchor,
                            int& outMatched)
{
    outMatched = 0;
    if (odf.size() < 16 || envRate <= 0.0 || periodSec <= 0.0) return false;

    const int maxIdx = static_cast<int>(odf.size()) - 2;
    const double totalSec = static_cast<double>(odf.size()) / envRate;
    const double win = std::min(periodSec * 0.25, 0.12);

    std::vector<std::pair<int, double>> pts; // (beat index n, de-biased onset time)
    const int firstN = static_cast<int>(std::ceil((0.0 - anchorSec) / periodSec));
    for (int n = firstN;; ++n)
    {
        const double gridT = anchorSec + static_cast<double>(n) * periodSec;
        if (gridT < 0.0) continue;
        if (gridT > totalSec) break;

        const int lo = std::max(1, static_cast<int>(std::floor((gridT - win) * envRate)));
        const int hi = std::min(maxIdx, static_cast<int>(std::ceil((gridT + win) * envRate)));
        if (hi <= lo) continue;

        int bestI = -1;
        double bestV = 0.0;
        for (int i = lo; i <= hi; ++i)
        {
            const double v = odf[static_cast<size_t>(i)];
            if (v > odf[static_cast<size_t>(i - 1)] && v >= odf[static_cast<size_t>(i + 1)] && v > bestV)
            {
                bestV = v;
                bestI = i;
            }
        }
        if (bestI < 0) continue;

        const double y0 = odf[static_cast<size_t>(bestI - 1)];
        const double y1 = odf[static_cast<size_t>(bestI)];
        const double y2 = odf[static_cast<size_t>(bestI + 1)];
        double frac = 0.0;
        const double denom = y0 - 2.0 * y1 + y2;
        if (std::abs(denom) > 1e-12)
        {
            const double d = 0.5 * (y0 - y2) / denom;
            if (std::abs(d) <= 1.0) frac = d;
        }
        const double peakT = (static_cast<double>(bestI) + frac) / envRate - groupDelaySec;
        pts.emplace_back(n, peakT);
    }

    if (pts.size() < 8) return false;

    // Two robust LSQ passes; drop points >0.25*period from the fitted line.
    double period = periodSec;
    double anchor = anchorSec;
    for (int iter = 0; iter < 2; ++iter)
    {
        long double sumN = 0, sumT = 0, sumNN = 0, sumNT = 0;
        int k = 0;
        for (auto& [n, t] : pts)
        {
            const double predicted = anchor + n * period;
            if (iter > 0 && std::abs(t - predicted) > period * 0.25) continue;
            sumN += n;
            sumT += t;
            sumNN += static_cast<long double>(n) * n;
            sumNT += static_cast<long double>(n) * t;
            ++k;
        }
        if (k < 6) return false;
        const long double K = static_cast<long double>(k);
        const long double det = K * sumNN - sumN * sumN;
        if (det <= 0.0L) return false;
        period = static_cast<double>((K * sumNT - sumN * sumT) / det);
        anchor = static_cast<double>((sumT - static_cast<long double>(period) * sumN) / K);
        outMatched = k;
        if (period < 0.05 || period > 2.0) return false;
    }

    outPeriod = period;
    outAnchor = anchor;
    return true;
}

} // namespace silverdaw
