#pragma once

// Offline post-separation cleanup for the *vocals* stem. This runs on a worker
// thread after htdemucs-ft has produced (and denormalised) a vocal buffer and
// before it is written to disk — it is NOT real-time code, so it may allocate
// and make multiple passes. It deliberately avoids spectral (STFT) processing:
// the artefacts a neural separator leaves on a vocal stem are non-stationary
// bleed and low-frequency rumble rather than stationary hiss, so a sub-bass
// high-pass followed by a gentle wide-band downward expander cleans the inter-
// phrase bleed without the musical-noise risk of spectral subtraction. Loudness
// normalisation and de-essing are intentionally out of scope here (per-stem
// loudness changes would wreck the relative balance the stems recombine to).

#include <juce_audio_basics/juce_audio_basics.h>

#include <juce_core/juce_core.h>

namespace silverdaw
{

// How hard the cleanup leans on the signal. Scales the high-pass corner, the
// expander threshold, ratio, and the maximum attenuation together.
enum class VocalEnhanceStrength
{
    Light,
    Medium,
    Strong
};

// Parses the renderer's "light"/"medium"/"strong" token (case-insensitive);
// anything else falls back to Medium so a bad payload never disables cleanup
// when the user asked for it.
VocalEnhanceStrength vocalEnhanceStrengthFromString(const juce::String& text) noexcept;
const char* vocalEnhanceStrengthToString(VocalEnhanceStrength strength) noexcept;

// Maps a strength onto the RNNoise denoiser's wet/dry mix (see VocalDenoiser):
// Light leans on the original signal, Strong is fully denoised. Kept next to the
// strength enum so the denoise intensity and the expander tuning stay in step.
// `cleanModel` selects a much gentler wet for a high-SDR vocal (the RoFormer
// pack), whose stem barely needs denoising; the default (htdemucs) is unchanged.
float vocalDenoiseWetFor(VocalEnhanceStrength strength, bool cleanModel = false) noexcept;

struct VocalEnhanceOptions
{
    bool enabled = false;
    VocalEnhanceStrength strength = VocalEnhanceStrength::Medium;
    // True when the vocal came from the high-SDR RoFormer pack rather than the
    // htdemucs backup. The cleanup then runs a far gentler expander (and the
    // caller skips the cross-stem de-bleed + softens the denoise), because the
    // stem is already clean and the htdemucs-grade settings would eat the vocal.
    bool cleanModel = false;
};

// Stateless offline vocal-stem enhancer. `process` mutates `buffer` in place at
// `sampleRate`; it is a guaranteed no-op when disabled, empty, non-finite, or
// silent. Mono and stereo buffers are both handled (the detector and the gain
// are shared across channels so the stereo image is preserved).
class VocalEnhancer
{
public:
    static void process(juce::AudioBuffer<float>& buffer, double sampleRate,
                        const VocalEnhanceOptions& options);
};

} // namespace silverdaw
