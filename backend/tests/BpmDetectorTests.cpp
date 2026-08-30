// Unit tests for the analysis-internal beat-grid phase estimator. These drive
// estimateGridPhaseOffset with synthetic onset-detection functions so its
// robustness gates (consistency, match count, latency window) are verified
// deterministically without needing a labelled audio corpus.

#include "TestRegistry.h"
#include "TestSupport.h"

#include "../src/dsp/BpmDetector.h"
#include "../src/dsp/BpmAudioLoader.h"
#include "../src/dsp/MiniBpmEstimator.h"
#include "../src/dsp/PercussiveEmphasis.h"
#include "../src/dsp/BpmAnalysisHelpers.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>

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

// Write a mono click track with sharp transients at exact beat positions so the
// detected grid can be compared against ground truth.
// toneHz/burstSec select the material. The default 1 kHz 10 ms burst is a
// broadband click; a low toneHz with a longer burst models a kick, whose slower
// spectral change is what used to push the ODF peak (and so the grid) late.
juce::File writeClickWav(const juce::File& dir, const juce::String& name, double bpm, double seconds,
                         double sampleRate, double toneHz = 1000.0, double burstSec = 0.01)
{
    auto file = dir.getChildFile(name);
    juce::WavAudioFormat format;
    std::unique_ptr<juce::OutputStream> stream(file.createOutputStream());
    require(stream != nullptr, "click wav output stream should open");
    const auto writerOptions = juce::AudioFormatWriterOptions{}
                                   .withSampleRate(sampleRate)
                                   .withNumChannels(1)
                                   .withBitsPerSample(16);
    std::unique_ptr<juce::AudioFormatWriter> writer(format.createWriterFor(stream, writerOptions));
    require(writer != nullptr, "click wav writer should create");

    const int numSamples = juce::jmax(1, static_cast<int>(seconds * sampleRate));
    juce::AudioBuffer<float> buffer(1, numSamples);
    buffer.clear();
    auto* data = buffer.getWritePointer(0);

    const double samplesPerBeat = 60.0 / bpm * sampleRate;
    const int clickLen = juce::jmax(1, static_cast<int>(burstSec * sampleRate));
    for (int beat = 0;; ++beat)
    {
        const int start = static_cast<int>(std::llround(beat * samplesPerBeat));
        if (start >= numSamples) break;
        for (int n = 0; n < clickLen && start + n < numSamples; ++n)
        {
            const double env = std::exp(-5.0 * n / clickLen);
            data[start + n] += static_cast<float>(
                0.8 * env * std::sin(2.0 * juce::MathConstants<double>::pi * toneHz * n / sampleRate));
        }
    }
    require(writer->writeFromAudioSampleBuffer(buffer, 0, numSamples), "click wav write should succeed");
    writer.reset();
    return file;
}

// End-to-end: a perfect click track should yield a grid that sits on the beats
// across the WHOLE track, not just on average. Two distinct failure modes are
// guarded here:
//   * Group-delay bias  -> the grid lands a few ms late on every beat (constant
//     offset). Caught by the mean-residual check.
//   * Period (BPM) error -> a tiny tempo error tilts the grid so the first beat
//     is late and the last is early (or vice-versa). A 0.02 BPM error is invisible
//     to a mean/max check but produces visible drift over a 30 s track, so the
//     first-vs-last residual SLOPE is asserted explicitly.
void testCircularMeanAnchorIgnoresIntroBeat()
{
    const double period = 0.5; // 120 BPM
    // One off-grid intro beat (phase 0.05) then a clean body at a constant phase
    // of 0.35 — exactly the "Big Fun" failure shape where the first beat sits a
    // ~0.29-period off the bulk grid.
    std::vector<double> beats = {0.05};
    for (int n = 1; n <= 12; ++n) beats.push_back(0.35 + static_cast<double>(n) * period);

    const double anchor = silverdaw::circularMeanAnchor(beats, period);

    auto phaseOf = [period](double t) {
        double p = std::fmod(t, period);
        if (p < 0.0) p += period;
        return p;
    };
    requireNear(phaseOf(anchor), 0.35, 0.03, "anchor phase follows the bulk of the beats");
    require(std::abs(phaseOf(anchor) - 0.05) > 0.1, "anchor must not lock to the off-grid intro beat");
    require(std::abs(anchor - beats.front()) <= period * 0.5 + 1e-9,
            "anchor stays within half a period of the track start");
}

void testMovingMedianFloorPreservesPeaksRemovesSwell()
{
    const double envRate = 200.0;
    const double period = 0.5; // 120 BPM => peaks every 100 frames

    // Build an ODF with sharp onset peaks riding on a slow raised-cosine swell
    // (a sustained bed). The floor subtraction must keep the peaks while removing
    // the swell so a naive peak-picker no longer locks onto the broad hump.
    const int n = 2600; // 13 s
    std::vector<double> odf(static_cast<size_t>(n), 0.0);
    for (int i = 0; i < n; ++i)
    {
        const double t = static_cast<double>(i) / envRate;
        // Slow swell: one full cosine lobe across the span, amplitude 0.6.
        odf[static_cast<size_t>(i)] =
            0.6 * (0.5 - 0.5 * std::cos(2.0 * juce::MathConstants<double>::pi * t / 13.0));
    }
    std::vector<int> peakFrames;
    for (int k = 1; k * static_cast<int>(period * envRate) < n - 2; ++k)
    {
        const int idx = k * static_cast<int>(period * envRate);
        odf[static_cast<size_t>(idx)] += 1.0; // sharp unit onset on top of the swell
        peakFrames.push_back(idx);
    }

    const auto cleaned = silverdaw::subtractMovingMedianFloor(odf, envRate, period);
    require(cleaned.size() == odf.size(), "cleaned ODF keeps the same length");

    // Every onset frame must remain a strict local maximum after cleaning.
    for (int idx : peakFrames)
    {
        require(cleaned[static_cast<size_t>(idx)] > cleaned[static_cast<size_t>(idx - 1)] &&
                    cleaned[static_cast<size_t>(idx)] > cleaned[static_cast<size_t>(idx + 1)],
                "onset peaks survive floor subtraction as local maxima");
    }

    // Mid-span swell crest (a non-onset frame) must be flattened to ~0, where in
    // the raw ODF it was a large positive value that could mislead peak-picking.
    int crest = n / 2;
    while (std::find(peakFrames.begin(), peakFrames.end(), crest) != peakFrames.end()) ++crest;
    require(odf[static_cast<size_t>(crest)] > 0.3, "raw swell crest is large pre-cleaning");
    require(cleaned[static_cast<size_t>(crest)] < 0.05, "swell crest is flattened post-cleaning");
}

void checkClickTrackGrid(double bpm, double seconds = 60.0, double toneHz = 1000.0,
                         double burstSec = 0.01, double meanTolSec = 0.003,
                         double maxTolSec = 0.004)
{
    const double sampleRate = 44100.0;

    auto dir = makeTempDir("bpm-click");
    const auto file = writeClickWav(dir, "click.wav", bpm, seconds, sampleRate, toneHz, burstSec);

    juce::AudioFormatManager fm;
    fm.registerBasicFormats();
    silverdaw::BpmDetector detector;
    const auto analysis = detector.analyse(file, fm);

    dir.deleteRecursively();

    require(analysis.bpm > 0.0, "click track should yield a tempo");
    // The ODF-peak refit pins the period to within a fraction of a BPM, far
    // tighter than the old +/-1 BPM tolerance that allowed drift.
    requireNear(analysis.bpm, bpm, 0.1, "detected BPM should match the click track");

    const double periodSec = 60.0 / analysis.bpm;
    auto residualSec = [&](int k) {
        const double trueBeat = k * 60.0 / bpm;
        const double n = std::round((trueBeat - analysis.beatAnchorSec) / periodSec);
        return analysis.beatAnchorSec + n * periodSec - trueBeat;
    };

    const int lastBeat = static_cast<int>((seconds - 1.0) * bpm / 60.0);
    require(lastBeat > 8, "click track should expose many beats");

    double sumSigned = 0.0;
    double maxAbs = 0.0;
    int counted = 0;
    for (int k = 4; k <= lastBeat; ++k)
    {
        const double err = residualSec(k);
        sumSigned += err;
        maxAbs = std::max(maxAbs, std::abs(err));
        ++counted;
    }
    const double meanSigned = sumSigned / counted;

    // No systematic early/late bias, and never far off on any single beat.
    requireNear(meanSigned, 0.0, meanTolSec, "grid should not be systematically late/early");
    require(maxAbs < maxTolSec, "every grid line should sit within tolerance of its beat");

    // Drift guard: the grid must not tilt across the track. With an accurate
    // period the first and last residuals are nearly equal; a period error shows
    // up here long before it trips the mean/max checks above.
    const double slope = std::abs(residualSec(lastBeat) - residualSec(4));
    require(slope < 0.002, "grid must not drift (first vs last residual) across the track");
}

// Regression guard for material-dependent marker lateness. A kick-like onset
// (60 Hz, 120 ms) changes spectrum far more slowly than a 1 kHz click, so its
// ODF peak used to arrive ~3 ms after the transient while a click's arrived
// almost on it — a gap no single group-delay constant can close, and the reason
// markers read as "slightly late" on real music. The grid is now anchored to
// where the onset *began*, so both materials must satisfy the same bound.
//
// The tolerance is deliberately TIGHTER than the shared click default. Measured,
// the pre-fix peak-anchored grid sat +3.47 ms out on this material, so a 3 ms
// bound would have caught it by only half a millisecond. 1.5 ms fails the old
// behaviour decisively while leaving ample room above the ~0.2 ms this now
// achieves.
void testLowFrequencyOnsetGridIsNotLate()
{
    for (double bpm : {100.0, 128.0})
        checkClickTrackGrid(bpm, 60.0, 60.0, 0.12, 0.0015, 0.004);
}

// A linear ramp peaking at index 10, shared by the estimator tests.
std::vector<double> slowRampForClamp()
{
    return {0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.2, 0.4, 0.6, 0.8, 1.0, 0.5, 0.1};
}

// The onset-start estimator is the final authority on where a beat marker
// lands, so it is tested directly on hand-built ODFs rather than only through
// a whole-file analysis where a regression could hide behind a tolerance.
void testOnsetStartEstimatorBacktracksSlowRamps()
{
    const double envRate = 172.265625; // 44100 / 256

    // A slow ramp: the peak is at index 10 but the rise starts around index 5.
    // The 75 % crossing must land between the foot and the peak, and clearly
    // before the peak, or the material-dependent lateness is back.
    std::vector<double> slow{0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.2, 0.4, 0.6, 0.8, 1.0, 0.5, 0.1};
    const double slowStart = silverdaw::estimateOnsetStartFrames(slow, 10, 10.0, envRate);
    require(slowStart < 10.0, "a slow ramp must resolve earlier than its peak");
    require(slowStart > 5.0, "backtrack must not run past the foot of the ramp");
    requireNear(slowStart, 8.75, 0.01, "75% of a linear ramp is three quarters up it");

    // A sharp onset: peak at index 5 with the immediately preceding frame at
    // zero. There is no ramp to walk back along, so the estimate must stay
    // within one frame of the peak.
    std::vector<double> sharp{0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.3, 0.0};
    const double sharpStart = silverdaw::estimateOnsetStartFrames(sharp, 5, 5.0, envRate);
    require(sharpStart > 4.0 && sharpStart <= 5.0, "a sharp onset must barely move");

    // Fraction 0 or 1 is a disabled/degenerate request and must be a no-op
    // rather than silently resolving to the valley.
    requireNear(silverdaw::estimateOnsetStartFrames(slow, 10, 10.0, envRate, 0.0), 10.0, 1e-9,
                "a zero fraction leaves the peak alone");
    requireNear(silverdaw::estimateOnsetStartFrames(slow, 10, 10.0, envRate, 1.0), 10.0, 1e-9,
                "a unit fraction leaves the peak alone");
}

// Robustness cases that the synthetic corpus cannot produce but real music can.
void testOnsetStartEstimatorHandlesAwkwardOdfs()
{
    const double envRate = 172.265625;

    // An intervening SMALLER onset just before the beat (a flam or a roll).
    // The walk must stop at the foot of the beat's own onset and must not
    // cross the smaller peak to measure from an unrelated earlier trough.
    std::vector<double> flam{0.0, 0.6, 0.1, 0.5, 0.5, 0.5, 1.0, 0.2};
    const double flamStart = silverdaw::estimateOnsetStartFrames(flam, 6, 6.0, envRate);
    require(flamStart > 5.0 && flamStart <= 6.0,
            "the walk must stop at this onset's foot, not cross the earlier hit");

    // A flat ODF has no prominence to measure; the peak must be kept.
    std::vector<double> flat(20, 0.4);
    requireNear(silverdaw::estimateOnsetStartFrames(flat, 10, 10.0, envRate), 10.0, 1e-9,
                "a flat ODF leaves the peak alone");

    // A zero-clipped plateau, which the moving-median floor subtraction
    // routinely produces, must not resolve to some arbitrary earlier frame.
    std::vector<double> clipped{0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.4};
    const double clippedStart = silverdaw::estimateOnsetStartFrames(clipped, 8, 8.0, envRate);
    require(clippedStart > 7.0 && clippedStart <= 8.0, "a step out of silence must not drift early");

    // The parabolic peak can interpolate to the LEFT of the integer maximum.
    // The returned onset start must never be later than the peak it came from.
    const double clamped = silverdaw::estimateOnsetStartFrames(slowRampForClamp(), 10, 9.6, envRate);
    require(clamped <= 9.6 + 1e-9, "onset start must never follow the interpolated peak");

    // Degenerate inputs must be handled rather than indexed out of bounds.
    std::vector<double> tiny{1.0};
    requireNear(silverdaw::estimateOnsetStartFrames(tiny, 0, 0.0, envRate), 0.0, 1e-9,
                "a single-frame ODF is left alone");
    requireNear(silverdaw::estimateOnsetStartFrames(slowRampForClamp(), 10, 10.0, 0.0), 10.0, 1e-9,
                "a zero envelope rate is left alone");
}

void testClickTrackGridLandsOnBeats()
{
    for (double bpm : {90.0, 120.0, 128.0, 140.0})
        checkClickTrackGrid(bpm);
}

// Whole-track analysis: BTrack only tracks the first kBeatTrackingSeconds (60 s),
// but the ODF period/phase refinement now spans the entire decoded track. A
// 180 s click track therefore exercises beats far beyond the BTrack window; the
// grid must still sit on the beats at the very end, proving the period was fit
// over the whole piece rather than extrapolated from the opening minute.
void testWholeTrackGridDoesNotDriftBeyondBeatWindow()
{
    for (double bpm : {120.0, 128.0})
        checkClickTrackGrid(bpm, 180.0);
}

// Octave folding is what lets two estimators with different search ranges be
// compared on equal terms: MiniBPM commits to 55-190, while BpmDetector accepts
// 40-240, so a half/double-time disagreement must not read as a wild one.
void testFoldBpmIntoRangeNormalisesOctaves()
{
    requireNear(silverdaw::foldBpmIntoRange(45.0), 90.0, 1e-9, "sub-range tempo doubles into range");
    requireNear(silverdaw::foldBpmIntoRange(200.0), 100.0, 1e-9, "super-range tempo halves into range");
    requireNear(silverdaw::foldBpmIntoRange(128.0), 128.0, 1e-9, "in-range tempo is left alone");
    // Boundaries are inclusive, so neither endpoint should be pushed an octave away.
    requireNear(silverdaw::foldBpmIntoRange(55.0), 55.0, 1e-9, "lower bound is left alone");
    requireNear(silverdaw::foldBpmIntoRange(190.0), 190.0, 1e-9, "upper bound is left alone");
    require(silverdaw::foldBpmIntoRange(0.0) == 0.0, "non-positive input yields no tempo");
    require(silverdaw::foldBpmIntoRange(std::numeric_limits<double>::quiet_NaN()) == 0.0,
            "non-finite input yields no tempo");
}

// The second engine has to agree with the first on unambiguous material before
// any disagreement between them can be treated as a meaningful signal. A click
// track is the cleanest possible case: if MiniBPM cannot hit this, a consensus
// built on it would be noise. Also covers the shared decode front-end.
void testMiniBpmAgreesWithBpmDetectorOnAClickTrack()
{
    constexpr double kBpm = 128.0;
    const double sampleRate = 44100.0;

    auto dir = makeTempDir("bpm-minibpm");
    const auto file = writeClickWav(dir, "click.wav", kBpm, 60.0, sampleRate);

    juce::AudioFormatManager fm;
    fm.registerBasicFormats();

    const auto decoded = silverdaw::decodeMonoForAnalysis(
        file, fm, silverdaw::BpmDetector::kMaxAnalysisSeconds,
        silverdaw::BpmDetector::kAnalysisSampleRate, {});

    dir.deleteRecursively();

    require(decoded.ok(), "shared loader should decode the click track");
    require(!decoded.mono.empty(), "decoded buffer should carry samples");
    requireNear(decoded.sourceSampleRate, sampleRate, 1e-9, "loader reports the source rate");

    const auto estimate = silverdaw::estimateTempoWithMiniBpm(
        decoded.mono, silverdaw::BpmDetector::kAnalysisSampleRate);

    require(estimate.bpm > 0.0, "MiniBPM should yield a tempo for a click track");
    requireNear(silverdaw::foldBpmIntoRange(estimate.bpm), kBpm, 1.0,
                "MiniBPM should agree with the click tempo once octave-folded");
}

// The whole justification for conditioning the audio ahead of beat tracking is
// that it changes onset STRENGTH without changing onset TIME. BpmDetector's beat
// anchor is calibrated against a fixed ODF group delay, so a filter with any
// frequency-dependent delay would shift every visible beat marker by a
// material-dependent amount. Asserting zero phase directly keeps that property
// from being lost to a future "better sounding" filter.
void testPercussiveEmphasisPreservesOnsetTiming()
{
    const double sampleRate = 44100.0;
    const int length = 44100;
    // Low band 180 Hz -> lround(0.44 * 44100 / 180) = 108, forced odd = 109,
    // half = 54, cascaded twice = 108 samples of reach either side.
    const int kReach = 108;

    auto conditionImpulseAt = [&](int at) {
        std::vector<float> impulse(static_cast<size_t>(length), 0.0f);
        impulse[static_cast<size_t>(at)] = 1.0f;
        return silverdaw::emphasisePercussiveContent(impulse, sampleRate);
    };

    auto peakIndexOf = [](const std::vector<float>& v) {
        int peakIndex = 0;
        float peak = 0.0f;
        for (size_t i = 0; i < v.size(); ++i)
        {
            if (std::abs(v[i]) > peak)
            {
                peak = std::abs(v[i]);
                peakIndex = static_cast<int>(i);
            }
        }
        return std::pair<int, float>{peakIndex, peak};
    };

    // --- Interior: the response must be symmetric about the impulse ----------
    // Away from both edges no reflected sample participates, so sample-wise
    // symmetry is the direct positive evidence of linear phase. A peak that
    // merely stayed put could still sit on a skewed response.
    for (int impulseAt : {200, 22050, 43900})
    {
        const auto filtered = conditionImpulseAt(impulseAt);
        require(filtered.size() == static_cast<size_t>(length), "conditioning preserves length");
        const auto [peakIndex, peak] = peakIndexOf(filtered);
        require(peak > 0.0f, "conditioned impulse should not be silent");
        require(peakIndex == impulseAt, "impulse peak must not move");

        for (int offset = 1; offset <= 150; ++offset)
        {
            requireNear(filtered[static_cast<size_t>(impulseAt - offset)],
                        filtered[static_cast<size_t>(impulseAt + offset)], 1e-6,
                        "interior impulse response must be symmetric (linear phase)");
        }
    }

    // --- Boundary: the response must be the REFLECTED fold of that same kernel
    // Within `kReach` of an edge the mirror folds a second copy of the onset
    // back into the buffer, so sample-wise symmetry about the impulse is
    // mathematically impossible there and asserting it would be wrong. What the
    // reflected extension does promise is an exact shape: h(i-a) + h(i-mirror),
    // with the SAME symmetric kernel h everywhere. Predicting the edge response
    // from the measured interior kernel therefore distinguishes true reflection
    // from a window that merely shrinks at the edges — the failure mode that
    // would make the operator time-varying and bias a clip's opening beat.
    const auto reference = conditionImpulseAt(22050);
    const double referencePeak = peakIndexOf(reference).second;
    require(referencePeak > 0.0, "reference impulse should not be silent");
    auto kernelAt = [&](int offsetFromCentre) {
        if (std::abs(offsetFromCentre) > kReach) return 0.0;
        return static_cast<double>(reference[static_cast<size_t>(22050 + offsetFromCentre)]) / referencePeak;
    };

    for (int impulseAt : {0, 20, 54, 100, length - 1 - 99, length - 1 - 53, length - 1 - 19, length - 1})
    {
        const auto filtered = conditionImpulseAt(impulseAt);
        const auto [peakIndex, peak] = peakIndexOf(filtered);
        require(peak > 0.0f, "conditioned edge impulse should not be silent");
        require(peakIndex == impulseAt, "edge impulse peak must not move");

        // The mirror index: reflection is about sample 0 at the start and about
        // the last sample at the end. Only the nearer edge can reach.
        const int mirror = impulseAt < length / 2 ? -impulseAt : 2 * (length - 1) - impulseAt;

        for (int i = std::max(0, impulseAt - kReach); i <= std::min(length - 1, impulseAt + kReach); ++i)
        {
            const double predicted = kernelAt(i - impulseAt) + kernelAt(i - mirror);
            const double actual = static_cast<double>(filtered[static_cast<size_t>(i)]) / peak;
            const double predictedPeak = 1.0 + kernelAt(impulseAt - mirror);
            requireNear(actual, predicted / predictedPeak, 2e-3,
                        "edge response must equal the reflected fold of the interior kernel");
        }
    }
}

// Conditioning re-weights bands, so material must survive it at a usable level -
// including material whose pulse lives in the ATTENUATED mid, which is the case
// the five-track tuning corpus did not cover.
void testPercussiveEmphasisKeepsSignalLevel()
{
    const double sampleRate = 44100.0;
    auto tone = [sampleRate](double hz, double amplitude) {
        std::vector<float> out(44100u, 0.0f);
        for (size_t i = 0; i < out.size(); ++i)
        {
            const double t = static_cast<double>(i) / sampleRate;
            out[i] = static_cast<float>(amplitude *
                                        std::sin(2.0 * juce::MathConstants<double>::pi * hz * t));
        }
        return out;
    };

    auto peakOf = [](const std::vector<float>& v) {
        float peak = 0.0f;
        for (float sample : v) peak = std::max(peak, std::abs(sample));
        return peak;
    };

    const auto percussive = silverdaw::emphasisePercussiveContent(tone(60.0, 0.5), sampleRate);
    require(peakOf(percussive) > 0.1f, "percussive bands should survive conditioning");

    // A mid-only source must not be reduced to nothing: a track carried by
    // piano, hand percussion or filtered drums still has to yield onsets.
    const auto midOnly = silverdaw::emphasisePercussiveContent(tone(1000.0, 0.5), sampleRate);
    require(peakOf(midOnly) > 0.01f, "mid-led material keeps a usable pulse");

    // ...but near-silence must not be amplified into apparent onsets by the
    // peak restoration, so the gain is capped.
    std::vector<float> quiet(44100u, 0.0f);
    for (size_t i = 0; i < quiet.size(); ++i)
        quiet[i] = (i % 7 == 0) ? 1.0e-4f : -1.0e-4f;
    const auto quietOut = silverdaw::emphasisePercussiveContent(quiet, sampleRate);
    require(peakOf(quietOut) <= 1.0e-4f * silverdaw::kPercussiveMaxRestoreGain + 1e-9f,
            "restoration gain is capped so noise is not lifted to full scale");

    // Too short to filter meaningfully: returned unaltered rather than blanked.
    const std::vector<float> tiny(16u, 0.5f);
    const auto tinyOut = silverdaw::emphasisePercussiveContent(tiny, sampleRate);
    require(tinyOut == tiny, "very short buffers pass through untouched");
}

} // namespace

void addBpmDetectorTests(std::vector<TestCase>& tests)
{    tests.push_back({"Grid phase: constant offset is recovered", testConsistentOffsetEstimated});
    tests.push_back({"Grid phase: aligned grid reports ~zero", testZeroOffsetLeavesAnchor});
    tests.push_back({"Grid phase: inconsistent jitter flagged by MAD", testInconsistentOffsetsFlaggedByMad});
    tests.push_back({"Grid phase: sparse onsets decline", testSparseOnsetsReturnFalse});
    tests.push_back({"Grid phase: onsets beyond window decline", testOnsetBeyondWindowNotCaptured});
    tests.push_back({"ODF floor: median subtraction preserves peaks, removes swell",
                     testMovingMedianFloorPreservesPeaksRemovesSwell});
    tests.push_back({"Grid anchor: circular mean ignores off-grid intro beat",
                     testCircularMeanAnchorIgnoresIntroBeat});
    tests.push_back({"Onset start: slow ramps backtrack, sharp onsets do not",
                     testOnsetStartEstimatorBacktracksSlowRamps});
    tests.push_back({"Onset start: flams, flat and clipped ODFs are handled",
                     testOnsetStartEstimatorHandlesAwkwardOdfs});
    tests.push_back({"Click track: grid lands on beats", testClickTrackGridLandsOnBeats});
    tests.push_back({"Low-frequency onsets: grid is not systematically late",
                     testLowFrequencyOnsetGridIsNotLate});
    tests.push_back({"Click track: whole-track grid does not drift past beat window",
                     testWholeTrackGridDoesNotDriftBeyondBeatWindow});
    tests.push_back({"Octave fold: half/double time normalised into the comparison range",
                     testFoldBpmIntoRangeNormalisesOctaves});
    tests.push_back({"MiniBPM: agrees with the click tempo via the shared loader",
                     testMiniBpmAgreesWithBpmDetectorOnAClickTrack});
    tests.push_back({"Percussive emphasis: zero phase, onsets do not move",
                     testPercussiveEmphasisPreservesOnsetTiming});
    tests.push_back({"Percussive emphasis: percussive bands survive at level",
                     testPercussiveEmphasisKeepsSignalLevel});
}

} // namespace silverdaw::tests
