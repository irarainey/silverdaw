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
    /** Marks likely non-rhythmic detections; the renderer can override via `sampleMode`. */
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
    /** Cap analysis because long files rarely improve tempo confidence enough to justify the wait. */
    static constexpr double kMaxAnalysisSeconds = 60.0;

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

} // namespace silverdaw
