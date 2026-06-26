#pragma once

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>
#include <vector>

namespace silverdaw
{

/** Output of one offline analysis pass. */
struct BpmAnalysis
{
    /** Estimated tempo in BPM. 0 when no plausible tempo was found. */
    double bpm = 0.0;
    /** LSQ beat-grid phase; can be negative so rendered grids stay stable despite beat jitter. */
    double beatAnchorSec = 0.0;
    /** Raw detections may contain outliers; render/snap use `bpm` + `beatAnchorSec`. */
    std::vector<double> beatTimesSec;
    /** Suppresses project-BPM seeding when BTrack's post-settling tempo spread is high. */
    bool variableTempo = false;
    /** Marks likely non-rhythmic detections; the renderer can override via `audioType`. */
    bool lowConfidence = false;
};

// Offline BTrack analysis; run only on workers, never the audio or message thread.
class BpmDetector
{
  public:
    static constexpr double kAnalysisSampleRate = 44100.0;
    /** Smaller than BTrack's default to reduce offline beat-position quantisation. */
    static constexpr int kHopSize = 256;
    static constexpr int kFrameSize = 1024;
    /** Anything outside the musical plausibility window is reported as no tempo. */
    static constexpr double kMinPlausibleBpm = 40.0;
    static constexpr double kMaxPlausibleBpm = 240.0;
    /** BTrack (the expensive causal tracker) runs on this bounded prefix for a
        robust octave/tempo seed; extending it risks octave-wander on long,
        variable material and adds cost without improving the seed. */
    static constexpr double kBeatTrackingSeconds = 60.0;
    /** The ODF-based period/phase refinement spans the WHOLE track (capped here
        only to bound memory/CPU on pathological inputs) so the fitted period
        reflects the entire piece, eliminating grid drift that accumulates when
        the period is fit to just the opening minute. */
    static constexpr double kMaxAnalysisSeconds = 600.0;

    /** Blocking; call from a worker, and keep `formatManager` alive for the call. */
    BpmAnalysis analyse(const juce::File& audioFile, juce::AudioFormatManager& formatManager);
};

// Analysis-internal, exposed for unit testing. Robustly estimates a single
// constant phase offset between a rigid beat grid (period+anchor) and the onset
// peaks in `odf` (an onset-detection function sampled at `envRate` Hz). For each
// grid line within the ODF span it finds the strongest nearby ODF local maximum
// (within +/- min(maxOffsetSec, 0.25*period)) and collects (peakTime - beatTime);
// returns the median offset plus the match count and the inter-quartile range
// (IQR) spread so callers can gate on consistency (the IQR catches bimodal
// early/late jitter that a median-absolute-deviation would miss). Returns false
// when there is too little evidence (fewer than the minimum matched grid lines)
// to trust an offset.
bool estimateGridPhaseOffset(const std::vector<double>& odf, double envRate, double periodSec,
                             double anchorSec, double maxOffsetSec, double& outOffsetSec,
                             int& outMatched, double& outSpread);

// Analysis-internal, exposed for unit testing. Suppresses slow sub-onset energy
// swells (sustained vocals, pads, horns and other broadband bed in a full mix)
// that raise the ODF's local floor and blur transient peaks. Adapted from
// aubio's median-adaptive peak picking: subtracts a sliding-window MEDIAN floor
// (robust to the very onset peaks we keep, unlike a mean) and half-wave
// rectifies, so the downstream autocorrelation, median-phase and ODF-peak-LSQ
// stages key off true onsets instead of broad humps. The window spans ~2 beats
// (sized from `approxPeriodSec`, clamped) so it sits on the inter-onset floor
// without following individual beats. Returns the cleaned ODF (same length).
std::vector<double> subtractMovingMedianFloor(const std::vector<double>& odf, double envRate,
                                              double approxPeriodSec);

// Analysis-internal, exposed for unit testing. Returns a robust beat-grid phase
// anchor (seconds) for a rigid grid of the given `periodSec`, computed from the
// CIRCULAR MEAN of every detected beat's phase (mod period). Seeding the LSQ fit
// from this — rather than the first detected beat — prevents an off-grid intro or
// pickup beat from anchoring the grid off-phase, which would otherwise push the
// whole body of the track past the fit's quarter-period inlier gate. The result
// is mapped into the same period bin as the first beat so backfill/render stays
// stable. Falls back to the first beat when there is no usable input.
double circularMeanAnchor(const std::vector<double>& beats, double periodSec);

} // namespace silverdaw
