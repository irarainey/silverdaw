#pragma once

// MiniBPM: a second, independent fixed-tempo estimator.
//
// Why a second engine at all: BpmDetector refines its period by scoring
// candidates against BTrack's OWN detected beat times. When the tempo behind
// those beats is wrong, the period that generated them wins on its own
// evidence — the test is circular exactly where it is most needed, because it
// has no information independent of the thing under suspicion. MiniBPM
// estimates tempo over the whole file with a different algorithm and a
// different failure profile, so it can break that tie from outside.
//
// What this is NOT: it does not replace or repair BTrack's tempo seed, and it
// is not an octave-error fix. It arbitrates between two candidates the detector
// has already produced, after a residual rejection, and only when its
// preference is clear. On real music the error it corrects is precision, not
// octave selection. See ADR 0028.
//
// Note it reports tempo only, with no beat positions or phase. It cannot
// replace the ODF period/phase refinement, which is what places beat markers.

#include <vector>
#include <functional>

namespace silverdaw
{

/** MiniBPM's own default working range, kept deliberately narrow.
    Tempo is octave-ambiguous (45 BPM is equivalently 90), so a range spanning
    little more than one octave forces a commitment to a canonical octave.
    Widening this toward BpmDetector's 40-240 plausibility window would span over
    2.5 octaves and give the estimator room to settle on half or double time —
    the very error this engine is being added to help catch. Results are folded
    into this range before any cross-engine comparison instead. */
constexpr double kMiniBpmMinBpm = 55.0;
constexpr double kMiniBpmMaxBpm = 190.0;

struct MiniBpmEstimate
{
    /** Best estimate in BPM, or 0 when the clip was too short to judge. */
    double bpm = 0.0;
    /** All candidates, most likely first; `bpm` is the first of these.
        Retained because the gap between the top candidates is a usable
        confidence signal, and because the runner-up is often the correct
        octave when the winner is not. */
    std::vector<double> candidates;
    /** Set when `shouldAbort` ended the pass early. `bpm` is 0 and the estimate
        must be discarded rather than treated as "no tempo found". */
    bool abandoned = false;
};

/** Estimates tempo from mono audio already decoded at `sampleRate`.
    Blocking and CPU-bound, but does no I/O: callers pass the same buffer the
    other estimators use, so a second opinion costs no extra decode or resample.
    Returns an estimate with `bpm == 0` when no tempo could be judged.

    `shouldAbort` is polled between feed blocks; return true from it to abandon
    the pass. MiniBPM exposes no abort callback of its own, so this is the only
    place the analysis timeout can reach: without it a long file made this engine
    the one stage that ignored the deadline the rest of detection honours. */
MiniBpmEstimate estimateTempoWithMiniBpm(const std::vector<float>& mono, double sampleRate,
                                         double minBpm = kMiniBpmMinBpm,
                                         double maxBpm = kMiniBpmMaxBpm,
                                         const std::function<bool()>& shouldAbort = {});

/** Halves or doubles `bpm` until it falls within [minBpm, maxBpm], so two
    engines that picked different octaves can be compared on equal terms.
    Returns 0 for a non-finite or non-positive input. */
double foldBpmIntoRange(double bpm, double minBpm = kMiniBpmMinBpm,
                        double maxBpm = kMiniBpmMaxBpm);

} // namespace silverdaw
