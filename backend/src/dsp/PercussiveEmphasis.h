#pragma once

// Percussive emphasis: a front-end conditioner for beat tracking.
//
// Beat trackers infer tempo from onset strength. On dense material — distorted
// guitars, sustained pads, thick vocal harmony — much of the signal energy sits
// in the mid band and carries the beat far less clearly than the kick (low) and
// the snare/hats (high). Weighting the mid down therefore raises onset contrast.
//
// The mid is ATTENUATED, NOT REMOVED. Plenty of material in scope — hand
// percussion, piano, muted guitar, filtered or lo-fi drums, acoustic recordings,
// and any passage with neither kick nor hats — carries its clearest pulse
// between these two bands. Discarding it outright would leave those tracks with
// no beat evidence at all, so a reduced mid contribution is kept as insurance
// against the material this was not tuned on.
//
// CRITICAL: this filter must be ZERO PHASE. BpmDetector de-biases its beat
// anchor by a calibrated ODF group delay (kOdfGroupDelayFrames), and the
// resulting anchor is what places visible beat markers. A filter with
// frequency-dependent delay would add a material-dependent shift on top of that
// calibration, silently moving every marker with no error reported anywhere.
// Only symmetric FIR kernels applied centred over a reflected extension are
// used, so the added group delay is exactly zero at every frequency and at
// every sample position, including the first and last.
//
// What that does NOT promise: zero phase guarantees this filter adds no delay,
// not that the detector's chosen onset times are unchanged. Re-weighting bands
// can still change which transient wins a contested ODF peak — a kick and a
// snare a few milliseconds apart can swap. That is a genuine change in
// detection, and it is established by measurement rather than by this property.

#include <vector>

namespace silverdaw
{

/** Upper edge of the low band, sitting around kick fundamentals while staying
    below most bass-guitar harmonics and all vocal energy. */
constexpr double kPercussiveLowBandHz = 180.0;
/** Lower edge of the high band, sitting above vocal sibilance and guitar
    presence, capturing hat and snare transients. */
constexpr double kPercussiveHighBandHz = 4000.0;
/** Weight for the high band. Below 1.0 because hats are dense: at parity they
    can imply a subdivision rather than the beat. */
constexpr float kPercussiveHighBandGain = 0.7f;
/** Weight for the mid band. Deliberately small: measurement showed the accuracy
    gain comes precisely from suppressing the mid on dense mixes, and a mid at
    0.25 removed the benefit entirely. This is insurance, not balance — enough
    that material carried by piano, hand percussion or filtered drums still
    presents onsets rather than nothing, while dense mixes stay de-cluttered. */
constexpr float kPercussiveMidBandGain = 0.10f;
/** Peak below which a buffer is treated as silence and left unnormalised. */
constexpr float kPercussiveSilenceFloor = 1.0e-6f;
/** Ceiling on the peak-restoration gain, so a buffer whose energy was almost
    entirely in the attenuated mid cannot have its residual noise amplified to
    full scale and mistaken for onsets. */
constexpr float kPercussiveMaxRestoreGain = 4.0f;

/** Returns a percussive-emphasised copy of `mono`. Length and sample rate are
    unchanged, and no delay is introduced. Returns the input unaltered when it
    is too short to filter meaningfully. */
std::vector<float> emphasisePercussiveContent(const std::vector<float>& mono, double sampleRate);

/** Applies a centred (zero-phase) moving-average low-pass with the given
    nominal cutoff, cascaded `passes` times for a steeper skirt. Exposed for
    testing; `passes` must be >= 1. */
std::vector<float> zeroPhaseLowPass(const std::vector<float>& in, double sampleRate, double cutoffHz,
                                    int passes = 2);

} // namespace silverdaw
