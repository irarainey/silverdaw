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
 * optional pass that removes it, and it is deliberately conservative: a
 * cleanup that eats breaths and word tails does more damage to a take than the
 * noise it removed.
 *
 * Two stages, in order:
 *
 * 1. A high-pass at `kHighPassHz`, which is below any sung or spoken
 *    fundamental and above mains hum, desk thumps and mic-stand rumble.
 * 2. A downward expander keyed on the take's *own* measured noise floor, so a
 *    quiet recording is not gated to silence and a loud one is not left noisy.
 *    The reduction is bounded (`kMaxReductionDb`) rather than absolute: pushing
 *    the gaps to digital silence is what makes a gate audible.
 *
 * The floor measurement and the gain law are pure functions so they can be
 * tested without files or devices.
 */

/** Corner frequency of the rumble filter, in Hz. */
constexpr double kHighPassHz = 80.0;
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
 * Expander gain for one window, in linear terms.
 *
 * Above the threshold the signal is the performance and passes untouched; below
 * it the gain falls off smoothly to `kMaxReductionDb` over one threshold's worth
 * of range, so a fading word tail is attenuated gradually rather than dropped
 * off a cliff.
 */
float expanderGain(double levelDb, double thresholdDb);

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
    /** Where the expander opened. */
    double thresholdDb = 0.0;
    /** True when the take was already clean enough to leave alone. */
    bool skipped = false;
};

/**
 * Cleans a finished recording in place. Worker thread only: it reads the whole
 * file twice (once to measure, once to process) and rewrites it.
 *
 * A take whose floor is already below what the expander could usefully act on is
 * left completely untouched rather than rewritten for no gain.
 */
CleanupResult cleanRecording(const CleanupRequest& request,
                             juce::AudioFormatManager& formatManager);

} // namespace silverdaw::recording
