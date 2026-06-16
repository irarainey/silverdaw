#pragma once

// Offline post-separation cleanup for the *other* stem — the catch-all residual
// (`other = mixture − vocals − drums − bass`). Unlike the vocal/drum/bass
// enhancers it does NOT use a wideband expander: the residual is usually dense
// and continuous (sustained pads, comping guitars, keys, strings) with no note
// gaps, so a gate would either self-bypass or chew musical content. Instead this
// runs a deliberately SHALLOW STFT spectral attenuation that shaves the
// persistent low-level "swirl"/musical-noise floor the residual subtraction
// leaves behind, while protecting sustained tonal content.
//
// It is the gentlest-by-intent of the four enhancers: "do little harm". A robust
// per-bin noise floor is estimated from a low percentile of each bin's magnitude
// over the active frames, then capped against its frequency neighbours so a
// sustained pad note can never become its own threshold. A soft-knee per-bin
// gain reaches unity well above that floor and is clamped to a small maximum
// attenuation (≤6 dB). One shared gain mask (from the louder channel) is applied
// to every channel so the stereo image is preserved, and the whole STFT pass
// self-bypasses when the predicted change is inaudible.
//
// Like the other enhancers this is offline worker-thread code (it may allocate
// and make multiple passes) and is a guaranteed no-op when disabled, empty,
// silent, invalid, or non-finite.

#include <juce_audio_basics/juce_audio_basics.h>

#include <juce_core/juce_core.h>

namespace silverdaw
{

// How hard the cleanup leans on the signal. Scales the subsonic corner, the
// noise-floor percentile, the threshold over-subtraction and the maximum
// attenuation together.
enum class OtherEnhanceStrength
{
    Light,
    Medium,
    Strong
};

// Parses the renderer's "light"/"medium"/"strong" token (case-insensitive);
// anything else falls back to Medium so a bad payload never disables cleanup
// when the user asked for it.
OtherEnhanceStrength otherEnhanceStrengthFromString(const juce::String& text) noexcept;
const char* otherEnhanceStrengthToString(OtherEnhanceStrength strength) noexcept;

struct OtherEnhanceOptions
{
    bool enabled = false;
    OtherEnhanceStrength strength = OtherEnhanceStrength::Medium;
};

// Stateless offline residual-stem enhancer. `process` mutates `buffer` in place
// at `sampleRate`; it is a guaranteed no-op when disabled, empty, non-finite, or
// silent, and self-bypasses the STFT stage when the predicted spectral change is
// inaudible. Mono and stereo buffers are both handled (the gain mask is shared
// across channels so the stereo image is preserved).
class OtherEnhancer
{
public:
    static void process(juce::AudioBuffer<float>& buffer, double sampleRate,
                        const OtherEnhanceOptions& options);
};

} // namespace silverdaw
