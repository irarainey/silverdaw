#include "BpmDetector.h"

#include "Log.h"

#include <BTrack.h>
#include <OnsetDetectionFunction.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <juce_audio_basics/juce_audio_basics.h>
#include <limits>
#include <numeric>
#include <samplerate.h>
#include <memory>
#include <utility>
#include <vector>

namespace
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

} // anonymous namespace

namespace silverdaw
{

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

BpmAnalysis BpmDetector::analyse(const juce::File& audioFile, juce::AudioFormatManager& formatManager)
{
    BpmAnalysis result;
    if (!audioFile.existsAsFile())
    {
        return result;
    }

    // Wall-clock safety net: detection normally finishes well under this, but a
    // pathological/very long input must not stall the analysis worker forever.
    // Checked cooperatively at each heavy stage and inside the per-hop loops; on
    // expiry we abandon the pass and report `timedOut` so the caller can notify.
    const auto analysisStart = std::chrono::steady_clock::now();
    const auto timedOut = [&analysisStart]() -> bool {
        const auto elapsed = std::chrono::steady_clock::now() - analysisStart;
        return std::chrono::duration<double>(elapsed).count() > kAnalysisTimeoutSeconds;
    };
    const auto abortTimedOut = [&](const char* stage) -> BpmAnalysis {
        silverdaw::log::warn("bpm", "analysis timed out (" + juce::String(stage) + ") after "
                                        + juce::String(kAnalysisTimeoutSeconds, 0) + "s for "
                                        + audioFile.getFileName() + " — abandoning");
        BpmAnalysis out;
        out.timedOut = true;
        return out;
    };

    std::unique_ptr<juce::AudioFormatReader> reader(formatManager.createReaderFor(audioFile));
    if (reader == nullptr)
    {
        silverdaw::log::warn("bpm", "createReaderFor failed for " + audioFile.getFileName());
        return result;
    }
    const double sourceSampleRate = reader->sampleRate;
    if (sourceSampleRate <= 0.0 || reader->numChannels == 0 || reader->lengthInSamples <= 0)
    {
        return result;
    }

    // Decode the whole track (bounded only by the generous kMaxAnalysisSeconds
    // ceiling) so the ODF-based period fit below spans the entire piece.
    const juce::int64 maxSourceSamples =
        static_cast<juce::int64>(kMaxAnalysisSeconds * sourceSampleRate);
    const juce::int64 totalSourceSamples = juce::jmin(reader->lengthInSamples, maxSourceSamples);

    // One contiguous mono buffer keeps the libsamplerate handoff simple.
    std::vector<float> mono(static_cast<size_t>(totalSourceSamples), 0.0F);
    const int numCh = static_cast<int>(reader->numChannels);
    const int decodeBlockSize = 4096;
    juce::AudioBuffer<float> decodeBuffer(numCh, decodeBlockSize);

    juce::int64 sourcePos = 0;
    while (sourcePos < totalSourceSamples)
    {
        const int toRead =
            static_cast<int>(juce::jmin(static_cast<juce::int64>(decodeBlockSize), totalSourceSamples - sourcePos));
        if (toRead <= 0) break;
        // ~every 4 MB decoded (large tracks only); cheap clock read, no hot-path cost.
        if ((sourcePos % (decodeBlockSize * 256)) == 0 && timedOut()) return abortTimedOut("decode");

        if (!reader->read(&decodeBuffer, 0, toRead, sourcePos, true, true))
        {
            silverdaw::log::warn("bpm", "reader read failed at " + juce::String(sourcePos));
            return result;
        }
        const float invCh = 1.0F / static_cast<float>(numCh);
        const size_t writeBase = static_cast<size_t>(sourcePos);
        for (int ch = 0; ch < numCh; ++ch)
        {
            const float* src = decodeBuffer.getReadPointer(ch);
            for (int i = 0; i < toRead; ++i)
            {
                mono[writeBase + static_cast<size_t>(i)] += src[i] * invCh;
            }
        }
        sourcePos += toRead;
    }

    // BTrack expects 44.1 kHz mono; use one-shot libsamplerate conversion.
    std::vector<float> resampled;
    if (std::abs(sourceSampleRate - kAnalysisSampleRate) < 0.001)
    {
        resampled = std::move(mono);
    }
    else
    {
        const double ratio = kAnalysisSampleRate / sourceSampleRate;
        const size_t outFrames =
            static_cast<size_t>(std::ceil(static_cast<double>(mono.size()) * ratio)) + 4;
        resampled.assign(outFrames, 0.0F);
        SRC_DATA srcData{};
        srcData.data_in = mono.data();
        srcData.input_frames = static_cast<long>(mono.size());
        srcData.data_out = resampled.data();
        srcData.output_frames = static_cast<long>(outFrames);
        srcData.src_ratio = ratio;
        srcData.end_of_input = 1;
        const int err = src_simple(&srcData, SRC_SINC_BEST_QUALITY, 1);
        if (err != 0)
        {
            silverdaw::log::warn("bpm", juce::String("src_simple failed: ") + src_strerror(err));
            return result;
        }
        resampled.resize(static_cast<size_t>(srcData.output_frames_gen));
    }

    // Beat positions stay in source time even after analysis-rate resampling.
    if (timedOut()) return abortTimedOut("resample");
    BTrack bt(kHopSize, kFrameSize);
    std::vector<double> hopBuffer(static_cast<size_t>(kHopSize), 0.0);
    std::vector<double> beatTimes;
    std::vector<double> tempoSamples;
    const size_t totalFrames = resampled.size();
    // BTrack runs on a bounded prefix (robust, cost-controlled octave/tempo
    // seed); the ODF-based period/phase refinement below spans the whole decoded
    // track, so the fitted period reflects the entire piece, not just the opening.
    const size_t beatTrackFrames =
        std::min(totalFrames, static_cast<size_t>(kBeatTrackingSeconds * kAnalysisSampleRate));
    size_t hopIndex = 0;
    for (size_t pos = 0; pos + static_cast<size_t>(kHopSize) <= beatTrackFrames;
         pos += static_cast<size_t>(kHopSize), ++hopIndex)
    {
        // BTrack is the causal tracker; check ~every 4096 hops (~24 s @ 256 hop).
        if ((hopIndex & 0xFFF) == 0 && timedOut()) return abortTimedOut("btrack");
        for (int i = 0; i < kHopSize; ++i)
        {
            hopBuffer[static_cast<size_t>(i)] = static_cast<double>(resampled[pos + static_cast<size_t>(i)]);
        }
        bt.processAudioFrame(hopBuffer.data());
        if (bt.beatDueInCurrentFrame())
        {
            const double beatTime = static_cast<double>(pos) / kAnalysisSampleRate;
            beatTimes.push_back(beatTime);
            tempoSamples.push_back(bt.getCurrentTempoEstimate());
        }
    }

    const double bpm = bt.getCurrentTempoEstimate();
    silverdaw::log::info("bpm",
                        "BTrack running estimate " + audioFile.getFileName() + ": " +
                            juce::String(bpm, 3) +
                            " (beats=" + juce::String(static_cast<int>(beatTimes.size())) + ", srcSR=" +
                            juce::String(sourceSampleRate) + ")");

    // LSQ over detected beats gives stable period+phase; outlier rejection handles missed/doubled beats.
    double derivedBpm = bpm;
    // Never anchor on the first detected beat (intro/pickup beats are routinely
    // off-grid); seed the phase from the bulk via the circular mean even on this
    // pre-fit fallback path.
    double anchorSec = beatTimes.empty()
                           ? 0.0
                           : ((bpm >= kMinPlausibleBpm && bpm <= kMaxPlausibleBpm)
                                  ? circularMeanAnchor(beatTimes, 60.0 / bpm)
                                  : beatTimes.front());
    double baselineResidual = std::numeric_limits<double>::infinity();
    int baselineKept = 0;
    if (beatTimes.size() >= 6)
    {
        std::vector<double> intervals;
        intervals.reserve(beatTimes.size() - 1);
        for (size_t i = 1; i < beatTimes.size(); ++i)
        {
            const double dt = beatTimes[i] - beatTimes[i - 1];
            if (dt > 0.05 && dt < 2.0) intervals.push_back(dt);
        }
        if (intervals.size() >= 4)
        {
            std::sort(intervals.begin(), intervals.end());
            const double medianInterval = intervals[intervals.size() / 2];
            // Seed the grid phase from the bulk of the beats, not the first
            // detected beat: an off-grid intro/pickup beat as the anchor would
            // push the whole body past the fit's quarter-period inlier gate.
            const double seedAnchor = circularMeanAnchor(beatTimes, medianInterval);
            double fitPeriod = 0.0;
            double fitAnchor = 0.0;
            double rms = 0.0;
            int kept = 0;
            if (fitPeriodAndAnchor(beatTimes, medianInterval, seedAnchor, fitPeriod, fitAnchor, rms, kept))
            {
                derivedBpm = 60.0 / fitPeriod;
                anchorSec = fitAnchor;
                baselineResidual = rms;
                baselineKept = kept;
            }
        }
    }

    // Refine via ODF autocorrelation to escape BTrack hop/BPM-grid quantisation.
    // Accept only near-octave candidates that do not worsen the BTrack-beat residual.
    // The ODF is computed once here and reused for the phase-alignment step below.
    constexpr int kOdfHop = 256; // ~5.8 ms @ 44.1 kHz
    // The complex-spectral-difference ODF is computed over a Hanning-windowed
    // kOdfFrame-sample frame whose newest hop trails the analysis instant, so a
    // sharp onset's ODF peak lands a fixed group delay after the true transient.
    // Measured across every sub-hop phase (1024-frame / 256-hop CSD-HWR) the peak
    // is ~0.53 ODF frames (~3 ms @ 44.1 kHz) late. Subtract it wherever the ODF
    // defines grid phase so the rendered beat grid sits on the onset instead of
    // consistently late. Re-measure if kOdfFrame or kOdfHop change.
    constexpr double kOdfGroupDelayFrames = 0.53;
    std::vector<double> odf;
    double envRate = 0.0;
    if (!resampled.empty() && beatTimes.size() >= 6 && baselineKept > 0)
    {
        if (timedOut()) return abortTimedOut("odf");
        envRate = kAnalysisSampleRate / static_cast<double>(kOdfHop);
        odf = computeOdf(resampled, kOdfHop);
        // Strip the slow sub-onset energy floor (sustained vocals/horns/pads in a
        // full mix) so the autocorrelation, median-phase and ODF-peak-LSQ stages
        // key off true transients. Window sized from the seed tempo (~2 beats).
        odf = subtractMovingMedianFloor(odf, envRate, (derivedBpm > 0.0) ? (60.0 / derivedBpm) : 0.5);
        if (odf.size() >= 64)
        {
            const double btrackPeriodSec = (derivedBpm > 0.0) ? (60.0 / derivedBpm) : 0.5;
            const double preferredLag = btrackPeriodSec * envRate;
            // Keep refinement near BTrack's octave to avoid half/triple-time peaks.
            const int minLag = std::max(2, static_cast<int>(std::floor(preferredLag * 0.90)));
            const int maxLag = std::max(minLag + 4, static_cast<int>(std::ceil(preferredLag * 1.10)));
            const double bestLag = autocorrPreferredLag(odf, minLag, maxLag, preferredLag);
            if (bestLag > 0.0)
            {
                const double acPeriod = bestLag / envRate;
                const double acBpm = 60.0 / acPeriod;
                const double drift = std::abs(acBpm - derivedBpm) / juce::jmax(1.0, derivedBpm);
                if (drift > 0.10)
                {
                    silverdaw::log::info("bpm",
                                         "autocorr period rejected for " + audioFile.getFileName() +
                                             " (drift=" + juce::String(drift * 100.0, 2) +
                                             "% baselineBPM=" + juce::String(derivedBpm, 3) +
                                             " acBPM=" + juce::String(acBpm, 3) + ")");
                }
                else
                {
                    const double acAnchor = findBestAnchor(odf, envRate, acPeriod, anchorSec);
                    double acRms = 0.0;
                    int acKept = 0;
                    scoreGridAgainstBeats(beatTimes, acPeriod, acAnchor, acRms, acKept);
                    // Equal-or-better residual is enough because the baseline period is quantised.
                    if (acKept >= baselineKept * 0.8 && acRms <= baselineResidual * 1.05)
                    {
                        silverdaw::log::info("bpm",
                                             "autocorr period accepted for " + audioFile.getFileName() + ": " +
                                                 juce::String(derivedBpm, 4) + " -> " + juce::String(acBpm, 4) +
                                                 " BPM (lag=" + juce::String(bestLag, 2) + " envFrames, residual " +
                                                 juce::String(baselineResidual * 1000.0, 2) + "ms -> " +
                                                 juce::String(acRms * 1000.0, 2) + "ms, kept " + juce::String(acKept) +
                                                 "/" + juce::String(baselineKept) + ")");
                        derivedBpm = acBpm;
                        // findBestAnchor reports the ODF onset phase, which is
                        // late by the ODF group delay; de-bias so the grid sits
                        // on the transient.
                        anchorSec = acAnchor - kOdfGroupDelayFrames / envRate;
                    }
                    else
                    {
                        silverdaw::log::info("bpm",
                                             "autocorr period rejected (worse residual) for " +
                                                 audioFile.getFileName() + " (baselineBPM=" +
                                                 juce::String(derivedBpm, 3) + " acBPM=" + juce::String(acBpm, 3) +
                                                 " residual " + juce::String(baselineResidual * 1000.0, 2) +
                                                 "ms vs " + juce::String(acRms * 1000.0, 2) + "ms, kept " +
                                                 juce::String(acKept) + "/" + juce::String(baselineKept) + ")");
                    }
                }
            }
        }
    }

    if (!std::isfinite(derivedBpm) || derivedBpm < kMinPlausibleBpm || derivedBpm > kMaxPlausibleBpm)
    {
        silverdaw::log::info("bpm",
                             "derived BPM out of range for " + audioFile.getFileName() + ": " +
                                 juce::String(derivedBpm));
        return result;
    }

    // Phase-align the final grid to onset energy regardless of which period won.
    // BTrack's reported beats can systematically lag the true transient, leaving
    // the grid (which still uses the beat-derived anchor whenever the autocorr
    // period is rejected) consistently off the beats. We correct only a stable,
    // latency-sized offset measured robustly against ODF onset peaks, so
    // ambiguous/syncopated material is left untouched (median ~0 => no-op).
    if (!odf.empty() && envRate > 0.0 && derivedBpm > 0.0)
    {
        const double periodSec = 60.0 / derivedBpm;
        constexpr double kMaxPhaseCorrectionSec = 0.12; // latency-sized, not half-beat
        constexpr double kMaxConsistentSpreadSec = 0.030; // IQR ceiling
        constexpr double kMinSignificantSec = 0.004;
        double offset = 0.0;
        int matched = 0;
        double spread = 0.0;
        if (estimateGridPhaseOffset(odf, envRate, periodSec, anchorSec, kMaxPhaseCorrectionSec, offset,
                                    matched, spread))
        {
            const int expectedBeats = std::max(1, static_cast<int>(std::floor(
                                                       (static_cast<double>(odf.size()) / envRate) / periodSec)));
            const double matchFrac = static_cast<double>(matched) / static_cast<double>(expectedBeats);
            // estimateGridPhaseOffset returns the raw ODF-peak-minus-grid offset;
            // the ODF peaks are themselves group-delay late, so the true grid
            // correction is the measured offset minus that delay.
            const double correction = offset - kOdfGroupDelayFrames / envRate;
            const bool consistent = spread <= kMaxConsistentSpreadSec;
            const bool plausible = std::abs(correction) <= kMaxPhaseCorrectionSec;
            const bool significant = std::abs(correction) > kMinSignificantSec;
            const bool enough = matchFrac >= 0.5;
            if (consistent && plausible && significant && enough)
            {
                silverdaw::log::info("bpm",
                                     "phase-aligned grid for " + audioFile.getFileName() + " by " +
                                         juce::String(correction * 1000.0, 2) + "ms (anchor " +
                                         juce::String(anchorSec, 4) + "s -> " +
                                         juce::String(anchorSec + correction, 4) + "s, raw offset " +
                                         juce::String(offset * 1000.0, 2) + "ms, matched " +
                                         juce::String(matched) + "/" + juce::String(expectedBeats) + ", iqr " +
                                         juce::String(spread * 1000.0, 2) + "ms)");
                anchorSec += correction;
            }
            else
            {
                silverdaw::log::info("bpm",
                                     "phase alignment skipped for " + audioFile.getFileName() + " (correction " +
                                         juce::String(correction * 1000.0, 2) + "ms, raw offset " +
                                         juce::String(offset * 1000.0, 2) + "ms, matched " + juce::String(matched) +
                                         "/" + juce::String(expectedBeats) + ", iqr " +
                                         juce::String(spread * 1000.0, 2) + "ms; consistent=" +
                                         juce::String(consistent ? 1 : 0) + " plausible=" +
                                         juce::String(plausible ? 1 : 0) + " significant=" +
                                         juce::String(significant ? 1 : 0) + " enough=" +
                                         juce::String(enough ? 1 : 0) + ")");
            }
        }
    }

    // Sharpen the period with a full-span LSQ over sub-frame ODF onset peaks.
    // BTrack beats are hop-quantised with a phase-correlated latency that biases
    // the baseline slope (leaving a slight period error that tilts the grid:
    // late at the start, early at the end); the interpolated ODF peaks remove
    // that bias. Only adopt a near-octave refinement so a spurious fit cannot
    // hijack the tempo.
    if (!odf.empty() && envRate > 0.0 && derivedBpm > 0.0)
    {
        double refinedPeriod = 0.0;
        double refinedAnchor = 0.0;
        int refinedMatched = 0;
        if (refineGridFromOdfPeaks(odf, envRate, kOdfGroupDelayFrames / envRate, 60.0 / derivedBpm, anchorSec,
                                   refinedPeriod, refinedAnchor, refinedMatched))
        {
            const double refinedBpm = 60.0 / refinedPeriod;
            const double drift = std::abs(refinedBpm - derivedBpm) / juce::jmax(1.0, derivedBpm);
            if (drift < 0.05)
            {
                silverdaw::log::info("bpm",
                                     "odf-peak grid refit for " + audioFile.getFileName() + ": " +
                                         juce::String(derivedBpm, 4) + " -> " + juce::String(refinedBpm, 4) +
                                         " BPM (anchor " + juce::String(anchorSec, 4) + "s -> " +
                                         juce::String(refinedAnchor, 4) + "s, matched " +
                                         juce::String(refinedMatched) + ")");
                derivedBpm = refinedBpm;
                anchorSec = refinedAnchor;
            }
        }
    }

    // Skip BTrack settling; a loose spread threshold avoids flagging estimator jitter as drift.
    constexpr size_t kSettlingBeats = 4;
    constexpr size_t kMinSamplesForStabilityCheck = 12;
    constexpr double kStabilityThreshold = 0.05; // 5 %
    bool variable = false;
    if (tempoSamples.size() >= kSettlingBeats + kMinSamplesForStabilityCheck)
    {
        const auto first = tempoSamples.begin() + static_cast<std::ptrdiff_t>(kSettlingBeats);
        const double sum = std::accumulate(first, tempoSamples.end(), 0.0);
        const double count = static_cast<double>(std::distance(first, tempoSamples.end()));
        const double mean = count > 0 ? sum / count : 0.0;
        const double minV = *std::min_element(first, tempoSamples.end());
        const double maxV = *std::max_element(first, tempoSamples.end());
        if (mean > 0.0 && (maxV - minV) / mean > kStabilityThreshold)
        {
            variable = true;
            silverdaw::log::info("bpm", audioFile.getFileName() +
                                            " marked variable-tempo (min=" + juce::String(minV, 2) +
                                            " max=" + juce::String(maxV, 2) +
                                            " mean=" + juce::String(mean, 2) + ")");
        }
    }

    result.bpm = derivedBpm;
    result.beatAnchorSec = anchorSec;
    result.beatTimesSec = std::move(beatTimes);
    result.variableTempo = variable;
    // High residual plus instability catches obvious non-rhythmic false positives without hiding data.
    const double periodSec = (derivedBpm > 0.0) ? (60.0 / derivedBpm) : 0.5;
    const double relResidual =
        (baselineResidual > 0.0 && std::isfinite(baselineResidual)) ? (baselineResidual / periodSec) : 0.0;
    const double keptFraction =
        (baselineKept > 0 && !result.beatTimesSec.empty())
            ? static_cast<double>(baselineKept) / static_cast<double>(result.beatTimesSec.size())
            : 0.0;
    const bool poorFit = relResidual > 0.08 || (baselineKept > 0 && keptFraction < 0.6);
    // Tempo drift alone is valid musical material, so require a poor-fit signal too.
    result.lowConfidence = poorFit && (variable || keptFraction < 0.5);
    silverdaw::log::info("bpm", "estimated " + audioFile.getFileName() + " -> " +
                                    juce::String(derivedBpm, 4) + " BPM" + (variable ? " (variable)" : "") +
                                    (result.lowConfidence ? " (low-confidence)" : "") +
                                    " anchor=" + juce::String(anchorSec, 4) +
                                    "s beats=" + juce::String(static_cast<int>(result.beatTimesSec.size())) +
                                    " relResidual=" + juce::String(relResidual, 3) +
                                    " keptFrac=" + juce::String(keptFraction, 3));
    return result;
}

} // namespace silverdaw

