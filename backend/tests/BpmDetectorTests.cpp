// Unit tests for the analysis-internal beat-grid phase estimator. These drive
// estimateGridPhaseOffset with synthetic onset-detection functions so its
// robustness gates (consistency, match count, latency window) are verified
// deterministically without needing a labelled audio corpus.

#include "TestRegistry.h"
#include "TestSupport.h"

#include "../src/dsp/BpmDetector.h"

#include <algorithm>
#include <cmath>
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
juce::File writeClickWav(const juce::File& dir, const juce::String& name, double bpm, double seconds,
                         double sampleRate)
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
    const int clickLen = static_cast<int>(0.01 * sampleRate); // 10 ms decaying sine burst
    for (int beat = 0;; ++beat)
    {
        const int start = static_cast<int>(std::llround(beat * samplesPerBeat));
        if (start >= numSamples) break;
        for (int n = 0; n < clickLen && start + n < numSamples; ++n)
        {
            const double env = std::exp(-5.0 * n / clickLen);
            data[start + n] += static_cast<float>(
                0.8 * env * std::sin(2.0 * juce::MathConstants<double>::pi * 1000.0 * n / sampleRate));
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

void checkClickTrackGrid(double bpm, double seconds = 60.0)
{
    const double sampleRate = 44100.0;

    auto dir = makeTempDir("bpm-click");
    const auto file = writeClickWav(dir, "click.wav", bpm, seconds, sampleRate);

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
    requireNear(meanSigned, 0.0, 0.003, "grid should not be systematically late/early");
    require(maxAbs < 0.004, "every grid line should sit within ~4 ms of its beat");

    // Drift guard: the grid must not tilt across the track. With an accurate
    // period the first and last residuals are nearly equal; a period error shows
    // up here long before it trips the mean/max checks above.
    const double slope = std::abs(residualSec(lastBeat) - residualSec(4));
    require(slope < 0.002, "grid must not drift (first vs last residual) across the track");
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

} // namespace

void addBpmDetectorTests(std::vector<TestCase>& tests)
{
    tests.push_back({"Grid phase: constant offset is recovered", testConsistentOffsetEstimated});
    tests.push_back({"Grid phase: aligned grid reports ~zero", testZeroOffsetLeavesAnchor});
    tests.push_back({"Grid phase: inconsistent jitter flagged by MAD", testInconsistentOffsetsFlaggedByMad});
    tests.push_back({"Grid phase: sparse onsets decline", testSparseOnsetsReturnFalse});
    tests.push_back({"Grid phase: onsets beyond window decline", testOnsetBeyondWindowNotCaptured});
    tests.push_back({"ODF floor: median subtraction preserves peaks, removes swell",
                     testMovingMedianFloorPreservesPeaksRemovesSwell});
    tests.push_back({"Grid anchor: circular mean ignores off-grid intro beat",
                     testCircularMeanAnchorIgnoresIntroBeat});
    tests.push_back({"Click track: grid lands on beats", testClickTrackGridLandsOnBeats});
    tests.push_back({"Click track: whole-track grid does not drift past beat window",
                     testWholeTrackGridDoesNotDriftBeyondBeatWindow});
}

} // namespace silverdaw::tests
