#include "BpmDetector.h"

#include "Log.h"

#include <BTrack.h>
#include <OnsetDetectionFunction.h>
#include <algorithm>
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

/**
 * One-shot LSQ fit of `t_n = anchor + n * period` over `beats`,
 * with three iterations of outlier filtering (residual > 25 % of
 * current period). Returns `false` if there aren't enough usable
 * beats or the fit collapses to an implausible period.
 *
 * Also returns the RMS residual (in seconds) of the kept beats so
 * the caller can compare two candidate beat lists and pick the
 * better fit.
 */
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

/**
 * Compute the same complex spectral-difference HWR onset detection
 * function family that BTrack uses internally, but at a fine hop on
 * the already-resampled mono 44.1 kHz buffer. Returns one ODF value
 * per `envHop` samples.
 *
 * This is intentionally separate from BTrack's private ODF buffer:
 * BTrack resamples that buffer for its own tempo comb filter and
 * does not expose it. Recomputing here lets the autocorrelation
 * refinement use a high-resolution, musically stronger ODF than a
 * simple RMS envelope.
 */
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

/**
 * Autocorrelate `odf` over integer lags in `[minLag, maxLag]` and
 * return the lag (in ODF frames, sub-frame via parabolic interp)
 * that maximises a Rayleigh-weighted autocorrelation score. The
 * Rayleigh weight peaks at `preferredLag` so we prefer the octave
 * closest to a known prior (BTrack's estimate) — without this, raw
 * autocorrelation peaks at integer multiples of the true period
 * and we'd happily pick half-time on dense material.
 *
 * Returns 0.0 lag if no usable peak was found.
 */
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
        // Normalise by the number of pairs so a longer lag isn't
        // unfairly penalised (vs. raw sum) — keeps the comparison
        // across the search range fair.
        ac[static_cast<size_t>(lag - minLag)] = sum / static_cast<double>(frames - lag);
    }

    // Rayleigh weighting centred on `preferredLag`. β controls
    // how narrow the prior is; β = preferredLag puts the mode at
    // preferredLag and gives ~50 % weight at 2× and ~50 % at 0.5×.
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

/**
 * Given a known period (in seconds) and the ODF, find the phase
 * (anchor in seconds within [0, period)) that maximises
 *   Σ ODF(anchor + n * period)
 * — i.e. the offset that aligns the predicted beat grid with the
 * most onset energy. Returns the anchor; if the ODF is too quiet
 * to discriminate, returns `fallbackAnchor`.
 */
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
    // Parabolic interp around the chosen phase using neighbouring
    // phases. Wrap modulo periodFrames so the interp can pull
    // anchors near 0 or near period - 1 either way.
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

/**
 * Evaluate how well a period+anchor grid explains `beats`: returns
 * RMS residual (seconds) of beats within ±25 % of one period from
 * a predicted grid point, plus the count of beats that fit. Used
 * to compare candidate (period, anchor) pairs.
 */
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

BpmAnalysis BpmDetector::analyse(const juce::File& audioFile, juce::AudioFormatManager& formatManager)
{
    BpmAnalysis result;
    if (!audioFile.existsAsFile())
    {
        return result;
    }

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

    const juce::int64 maxSourceSamples =
        static_cast<juce::int64>(kMaxAnalysisSeconds * sourceSampleRate);
    const juce::int64 totalSourceSamples = juce::jmin(reader->lengthInSamples, maxSourceSamples);

    // ──────────────────────────────────────────────────────────────────
    // Step 1: decode the whole capped range into a single mono float
    // buffer. ~21 MB worst case (2 min of mono float32) — well within
    // headroom on any modern desktop, and one-shot decoding lets us
    // hand a single contiguous buffer to libsamplerate.
    // ──────────────────────────────────────────────────────────────────
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

    // ──────────────────────────────────────────────────────────────────
    // Step 2: resample to BTrack's expected 44.1 kHz mono using
    // libsamplerate (`src_simple`, one-shot conversion of the whole
    // buffer).
    // ──────────────────────────────────────────────────────────────────
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

    // ──────────────────────────────────────────────────────────────────
    // Step 3: feed BTrack frame-by-frame and record beat events.
    // We map the analysis sample rate's frame index back to source
    // time so the beat positions remain meaningful regardless of the
    // source's original sample rate.
    // ──────────────────────────────────────────────────────────────────
    BTrack bt(kHopSize, kFrameSize);
    std::vector<double> hopBuffer(static_cast<size_t>(kHopSize), 0.0);
    std::vector<double> beatTimes;
    std::vector<double> tempoSamples;
    const size_t totalFrames = resampled.size();
    size_t hopIndex = 0;
    for (size_t pos = 0; pos + static_cast<size_t>(kHopSize) <= totalFrames;
         pos += static_cast<size_t>(kHopSize), ++hopIndex)
    {
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

    // Prefer a BPM *fit by linear regression to all detected beats*
    // over BTrack's running tempo estimate. The estimate is updated
    // incrementally and can be a fraction of a BPM off the true
    // value implied by the beat positions; a least-squares fit
    // recovers both the period AND the phase to sub-millisecond
    // precision, which is what we need for a synthesised marker
    // grid to stay flush with the actual transients across long
    // clips and across split / duplicate cycles.
    //
    // The fit is robust to occasional outliers (BTrack sometimes
    // doubles or misses a beat near tempo changes): we start with
    // the median interval as the period estimate, assign each
    // detected beat the nearest integer beat-index in that grid,
    // drop beats whose residual is > 25 % of a period, and re-fit.
    // Three iterations are enough to converge on a clean fit for
    // anything but the most erratic material.
    double derivedBpm = bpm;
    double anchorSec = beatTimes.empty() ? 0.0 : beatTimes.front();
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
            double fitPeriod = 0.0;
            double fitAnchor = 0.0;
            double rms = 0.0;
            int kept = 0;
            if (fitPeriodAndAnchor(beatTimes, medianInterval, beatTimes.front(), fitPeriod, fitAnchor, rms, kept))
            {
                derivedBpm = 60.0 / fitPeriod;
                anchorSec = fitAnchor;
                baselineResidual = rms;
                baselineKept = kept;
            }
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // Step 3b: refine the period via direct autocorrelation of an
    // onset detection function.
    //
    // BTrack's beat times are quantised to its hop boundaries (now
    // ~5.8 ms at 44.1 kHz / hop=256; originally ~11.6 ms at the
    // default hop=512) AND BTrack picks tempo from a discrete
    // 2-BPM grid in [80, 160] before rounding to an integer number of
    // hops. Even with LSQ regression over a couple hundred beats, the
    // jitter on funky / syncopated material can leave us 2-3 BPM off
    // the true tempo (we saw 103.7 vs a true 106).
    //
    // To escape that quantisation we step back from BTrack's beats and
    // compute a high-resolution spectral ODF directly on the resampled audio,
    // then autocorrelate it over a generous lag range covering [50 %,
    // 200 %] of BTrack's reported tempo (so half / double-time
    // alternatives are also considered). A Rayleigh prior centred on
    // the BTrack-implied lag biases the search towards the nearest
    // octave so a strong sub-beat doesn't pull us into double-time.
    // Parabolic interpolation around the integer-lag peak gives
    // sub-frame (= sub-millisecond) precision.
    //
    // Once we have a period, the anchor is set by sweeping phase over
    // [0, period) and picking the offset that aligns the predicted
    // beat grid with the most ODF energy. The two are decoupled —
    // BTrack's beats are no longer used for the period, only as a
    // cross-check (we require the AC-derived BPM to be within ±10 %
    // of the BTrack LSQ result; otherwise the candidate is rejected
    // as a likely octave error).
    //
    // The AC result replaces the baseline only when it gives a lower
    // RMS residual on BTrack's beats (a sanity check that the new
    // period is at least as consistent with the detected beats as
    // the old one).
    // ──────────────────────────────────────────────────────────────────
    if (!resampled.empty() && beatTimes.size() >= 6 && baselineKept > 0)
    {
        constexpr int kOdfHop = 256; // ~5.8 ms @ 44.1 kHz
        const double envRate = kAnalysisSampleRate / static_cast<double>(kOdfHop);
        const auto odf = computeOdf(resampled, kOdfHop);
        if (odf.size() >= 64)
        {
            const double btrackPeriodSec = (derivedBpm > 0.0) ? (60.0 / derivedBpm) : 0.5;
            const double preferredLag = btrackPeriodSec * envRate;
            // Tight ±10 % search window around BTrack's estimate.
            // We only want sub-grid refinement of an already-correct
            // tempo, not full re-detection — a wider window admits
            // half-time / triple-time peaks that would happily out-
            // score the true period in raw autocorrelation.
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
                    // Accept the autocorrelation result if it
                    // explains BTrack's beats at least as well as
                    // the baseline. We don't demand a *tighter*
                    // fit (the period quantisation is precisely
                    // what's broken in the baseline) — equal-or-
                    // better is enough.
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
                        anchorSec = acAnchor;
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

    // ──────────────────────────────────────────────────────────────────
    // Step 4: tempo-stability check. BTrack's running estimate settles
    // over the first few beats; we skip those and look at the spread
    // of the remaining samples. A spread > 5 % of the mean flags the
    // clip as variable-tempo so the UI can warn the user (and the
    // first-clip-on-empty-project seeder can opt out).
    //
    // The thresholds are deliberately loose: real recordings of even
    // metronomically-perfect music carry a small amount of BTrack
    // estimator jitter (~1-3 %). 5 % keeps that out while still
    // catching clips whose tempo genuinely drifts. We also require
    // at least a dozen non-settling samples — very short clips
    // don't have enough data to draw a stable spread.
    // ──────────────────────────────────────────────────────────────────
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
    silverdaw::log::info("bpm", "estimated " + audioFile.getFileName() + " -> " +
                                    juce::String(derivedBpm, 4) + " BPM" + (variable ? " (variable)" : "") +
                                    " anchor=" + juce::String(anchorSec, 4) +
                                    "s beats=" + juce::String(static_cast<int>(result.beatTimesSec.size())));
    return result;
}

} // namespace silverdaw

