#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>

#include <vector>

namespace silverdaw::recording
{

/**
 * Post-record cleanup for microphone takes (ADR 0030, Amendment 3).
 *
 * A close mic in a bedroom picks up a constant low-level bed — fan noise,
 * traffic, the room itself — that is inaudible while the performance is
 * happening and obvious in the gaps once the take sits under a mix. This is the
 * optional pass that removes it.
 *
 * Three stages, in order, and the same chain the vocal stem cleanup uses:
 *
 * 1. A high-pass at `kHighPassHz`, which is below any sung or spoken
 *    fundamental and above mains hum, desk thumps and mic-stand rumble. The
 *    denoiser was not trained on rumble, so this goes first.
 * 2. `VocalDenoiser` — the RNNoise suppressor already used on the vocals stem.
 *    This is the stage that does the work: a network trained on speech in noise
 *    takes the bed out from *under* the performance, which is the part no
 *    expander can reach. An expander can only turn the whole take down once all
 *    of it has fallen below one threshold, so on its own it barely acts at all
 *    on speech, whose gaps are shorter than its release.
 * 3. A downward expander on what the denoiser left, keyed on the *residual*
 *    floor, to push down the bed that survives between phrases. Its threshold
 *    has to be measured after the denoiser: the floor measured before sits far
 *    above what is left, and would take the performance with it.
 *
 * It stays conservative at the last stage, because a cleanup that eats breaths
 * and word tails does more damage than the noise it removed: the reduction is
 * bounded (`kMaxReductionDb`) rather than absolute, and the denoiser is not run
 * fully wet, so a gap still sounds like a room rather than like a mute.
 *
 * The floor measurement and the gain law are pure functions so they can be
 * tested without files or devices, and the expander works on a buffer so it can
 * be tested without them either.
 */

/** Corner frequency of the rumble filter, in Hz. */
constexpr double kHighPassHz = 80.0;
/** How much of the denoised signal is kept. Short of fully wet on purpose: the
 *  last of the room is what stops a cleaned take sounding switched off. */
constexpr float kDenoiseWet = 0.8F;
/** How far above the measured floor the expander opens fully, in dB. */
constexpr double kThresholdAboveFloorDb = 9.0;
/** Deepest attenuation applied to material below the threshold, in dB. */
constexpr double kMaxReductionDb = 18.0;
/** Ceiling on the threshold: material this loud is the performance, whatever
 *  the measured floor claimed. */
constexpr double kMaxThresholdDb = -34.0;
/** Floor estimation window. Long enough to average out a syllable, short enough
 *  to find a real gap between phrases. */
constexpr double kFloorWindowMs = 20.0;

/**
 * The noise floor of a take, in dBFS, as the quietest tenth of its windows.
 *
 * A percentile rather than a minimum: one absolutely silent block at the head
 * (a device that started late, a hard edit) would otherwise claim a floor no
 * real recording has, and the expander would never open. Returns -100 dB for a
 * take with no usable audio, which reads as "nothing to remove".
 */
double noiseFloorDbFromWindowRms(std::vector<float>& windowRms);

/**
 * Expander gain, in linear terms.
 *
 * Above the threshold the signal is performance and passes untouched; below it
 * the gain falls off smoothly to `kMaxReductionDb` over one threshold's worth of
 * range, so a fading word tail is attenuated gradually rather than dropped off a
 * cliff, and stays there rather than deepening without limit.
 */
float expanderGain(double levelDb, double thresholdDb);

/**
 * The broadband noise floor of a buffer, in dBFS.
 *
 * Windows the take, takes each window's RMS, and hands them to
 * `noiseFloorDbFromWindowRms`. Returns -100 dB for a buffer with no usable
 * audio.
 */
double measureNoiseFloorDb(const juce::AudioBuffer<float>& audio, double sampleRate);

/**
 * Runs the residual expander over a whole take, in place.
 *
 * Kept separate from `cleanRecording` so the gain law and its timing can be
 * tested on a synthetic buffer, without files, devices or the denoiser. The
 * envelope and the gain both move on the same attack and release, each in its
 * own direction, so the expander opens on a consonant as fast as it detected it
 * and closes over a gap rather than inside one.
 *
 * Worker thread only — it walks the whole take sample by sample.
 */
void expandBelowFloorInPlace(juce::AudioBuffer<float>& audio, double sampleRate,
                             double thresholdDb);

struct CleanupRequest
{
    juce::File file;
    /** Measured input latency is already trimmed by finalise; this runs after. */
    double sampleRate = 0.0;
};

struct CleanupResult
{
    bool ok = false;
    juce::String error;
    /** What the take's own noise bed measured at, for logging and tests. */
    double noiseFloorDb = 0.0;
    /** Where the expander would have opened on the take as captured. */
    double thresholdDb = 0.0;
    /** What the bed measured at after the denoiser, and so where the residual
     *  expander actually opened. */
    double residualFloorDb = 0.0;
    /** True when the take was already clean enough to leave alone. */
    bool skipped = false;
};

/**
 * Cleans a finished recording in place. Worker thread only: it reads the whole
 * file, measures it, suppresses it and rewrites it.
 *
 * A take whose floor is already below what the pass could usefully act on is
 * left completely untouched rather than rewritten for no gain.
 */
CleanupResult cleanRecording(const CleanupRequest& request,
                             juce::AudioFormatManager& formatManager);

} // namespace silverdaw::recording
