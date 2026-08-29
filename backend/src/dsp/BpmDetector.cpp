#include "BpmDetector.h"
#include "BpmAnalysisHelpers.h"
#include "BpmAudioLoader.h"
#include "MiniBpmEstimator.h"
#include "PercussiveEmphasis.h"

#include "Log.h"

#include <BTrack.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <juce_audio_basics/juce_audio_basics.h>
#include <limits>
#include <numeric>
#include <memory>
#include <utility>
#include <vector>

namespace silverdaw
{

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

    // Decode, channel-fold and resample are shared with every other estimator
    // so they all judge byte-identical audio (see BpmAudioLoader.h).
    const auto decoded = decodeMonoForAnalysis(audioFile, formatManager, kMaxAnalysisSeconds,
                                               kAnalysisSampleRate, timedOut);
    if (decoded.status == BpmDecodeStatus::TimedOut) return abortTimedOut("decode");
    if (!decoded.ok()) return result;

    const double sourceSampleRate = decoded.sourceSampleRate;
    // Onset-strength conditioning: keep the kick and snare/hat bands and discard
    // the mid, where sustained guitar, pad and vocal energy contributes to the
    // onset function without carrying any beat. Zero phase by construction, so
    // onset timing - and therefore marker placement - is unchanged; see
    // PercussiveEmphasis.h. BTrack and the ODF refinement below both run on this.
    const std::vector<float> resampled = emphasisePercussiveContent(decoded.mono, kAnalysisSampleRate);

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
            if (bpm_detail::fitPeriodAndAnchor(beatTimes, medianInterval, seedAnchor, fitPeriod, fitAnchor, rms, kept))
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
        odf = bpm_detail::computeOdf(resampled, kOdfHop);
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
            const double bestLag = bpm_detail::autocorrPreferredLag(odf, minLag, maxLag, preferredLag);
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
                    const double acAnchor = bpm_detail::findBestAnchor(odf, envRate, acPeriod, anchorSec);
                    double acRms = 0.0;
                    int acKept = 0;
                    bpm_detail::scoreGridAgainstBeats(beatTimes, acPeriod, acAnchor, acRms, acKept);
                    // Equal-or-better residual is enough because the baseline period is quantised.
                    bool acceptAc = (acKept >= baselineKept * 0.8 && acRms <= baselineResidual * 1.05);
                    juce::String acceptReason = "residual";

                    if (!acceptAc)
                    {
                        // The residual test scores BOTH candidates against BTrack's own
                        // detected beats, so when the tempo behind those beats is wrong
                        // the period that generated them wins on its own evidence —
                        // circular, and exactly the case where the baseline is most
                        // likely wrong. Break the tie with an estimator that never saw
                        // those beats.
                        //
                        // Restricting this to cases where the beat fit looks weak was
                        // tried and measured worse: the corpus contains a file whose
                        // beats are internally consistent (100/100 retained, 20ms
                        // residual) while its tempo is still 1.7 BPM out. A tidy beat
                        // sequence is evidence of self-consistency, not of correctness,
                        // so the quality of the fit is not used to gate arbitration.
                        //
                        // Consulted only on a rejection, so an uncontested refinement
                        // pays nothing. Deliberately fed the RAW decode, not the
                        // conditioned buffer: an arbiter sharing the other engine's
                        // front-end would inherit its blind spots and manufacture
                        // agreement, defeating the independence this depends on.
                        const auto mini = estimateTempoWithMiniBpm(decoded.mono, kAnalysisSampleRate);

                        // A winner that barely beat its own runner-up is an ambiguous
                        // readout rather than a second opinion, and may overturn nothing.
                        const bool miniIsDecisive =
                            mini.candidates.size() < 2 ||
                            std::abs(mini.candidates[0] - mini.candidates[1]) >
                                mini.candidates[0] * kArbiterMinCandidateSeparation;

                        if (mini.bpm > 0.0 && derivedBpm > 0.0 && miniIsDecisive)
                        {
                            // MiniBPM searches a narrower range than we accept, so bring
                            // its answer to the baseline's octave before comparing.
                            double miniAligned = mini.bpm;
                            for (int i = 0; i < 8 && miniAligned < derivedBpm * 0.71; ++i) miniAligned *= 2.0;
                            for (int i = 0; i < 8 && miniAligned > derivedBpm * 1.42; ++i) miniAligned /= 2.0;

                            const double toAc = std::abs(miniAligned - acBpm);
                            const double toBaseline = std::abs(miniAligned - derivedBpm);
                            // Require the preference to be both close in absolute terms
                            // and clear by a real margin. The margin is what stops a
                            // near-tie — where the arbiter is only nominally closer to one
                            // side — from overturning a baseline that was already right.
                            if (toAc <= kArbiterMaxAgreementBpm &&
                                (toBaseline - toAc) >= kArbiterMinPreferenceMarginBpm)
                            {
                                acceptAc = true;
                                acceptReason = "minibpm arbiter";
                            }
                            silverdaw::log::info(
                                "bpm", "minibpm arbiter for " + audioFile.getFileName() + ": mbpm=" +
                                           juce::String(mini.bpm, 3) + " (aligned " +
                                           juce::String(miniAligned, 3) + ") baseline=" +
                                           juce::String(derivedBpm, 3) + " ac=" + juce::String(acBpm, 3) +
                                           " margin=" + juce::String(toBaseline - toAc, 3) + " -> " +
                                           (acceptAc ? "prefers autocorr" : "no clear preference"));
                        }
                        else
                        {
                            silverdaw::log::info("bpm", "minibpm arbiter declined for " +
                                                            audioFile.getFileName() +
                                                            " (no decisive second opinion)");
                        }
                    }

                    if (acceptAc)
                    {
                        silverdaw::log::info("bpm",
                                             "autocorr period accepted (" + acceptReason + ") for " +
                                                 audioFile.getFileName() + ": " +
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
        // IQR ceiling. Do NOT loosen this to "rescue" tracks it rejects. Measured on
        // real dance and funk material the ODF-peak phase offset has an IQR of
        // 92-101ms here, and on every track checked the correction it proposed was
        // the OPPOSITE sign to the one the grid actually needed by ear. The estimate
        // is not merely noisy on that material, it is anti-correlated, so widening
        // this ceiling makes markers worse rather than better.
        constexpr double kMaxConsistentSpreadSec = 0.030;
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
