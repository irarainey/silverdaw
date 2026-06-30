#pragma once

// Offline post-separation cleanup *and* enhancement for the *drums* stem. Like
// VocalEnhancer this runs on a worker thread after htdemucs-ft has produced (and
// denormalised) a drum buffer and before it is written to disk — it is NOT
// real-time code, so it may allocate and make multiple passes.
//
// Two stages run in order. (1) CLEANUP — conservative and subtractive: a subsonic
// high-pass (DC/rumble only — never a musical drum high-pass, the kick lives at
// 40-80 Hz) followed by a soft, range-limited downward EXPANDER that pulls down
// low-level bleed (cymbal wash, vocal/bass leakage) in the gaps between hits
// without ever hard-gating the tails. (2) ENHANCEMENT — a gentle transient
// designer that emphasises the leading edge of each hit for punch, scaled by
// strength, followed by a soft-knee limiter so the boosted onsets can never
// hard-clip. The enhancement runs even when the cleanup self-bypasses, but is a
// no-op on steady/continuous material (where the fast and slow envelopes
// converge) and on silence.
//
// Two design choices set the cleanup apart from the vocal expander, both to suit
// percussive material: (1) the expander threshold is anchored to a robust high
// percentile of a short-window level envelope rather than the absolute peak, so
// one loud snare/kick transient cannot skew it; and it self-bypasses when the
// stem has little gap contrast (dense rolls, brush work, continuous cymbals),
// where gating would only expose separation artefacts. (2) The detector uses an
// instant attack with a hold so transient onsets are never dulled, then a slow
// release so the gain closes smoothly into the gaps instead of chattering.
//
// Loudness normalisation and multiband/spectral processing remain out of scope.

#include <juce_audio_basics/juce_audio_basics.h>

#include <juce_core/juce_core.h>

namespace silverdaw
{

// How hard the cleanup leans on the signal. Scales the subsonic corner, the
// expander threshold, ratio, attenuation range and release together.
enum class DrumEnhanceStrength
{
    Light,
    Medium,
    Strong
};

// Parses the renderer's "light"/"medium"/"strong" token (case-insensitive);
// anything else falls back to Medium so a bad payload never disables cleanup
// when the user asked for it.
DrumEnhanceStrength drumEnhanceStrengthFromString(const juce::String& text) noexcept;
const char* drumEnhanceStrengthToString(DrumEnhanceStrength strength) noexcept;

struct DrumEnhanceOptions
{
    bool enabled = false;
    DrumEnhanceStrength strength = DrumEnhanceStrength::Medium;
    // True when the drums came from the high-SDR RoFormer rhythm pack rather than
    // the htdemucs backup. The transient designer and cleanup expander are then
    // scaled back, because the stem is already clean and the htdemucs-grade punch
    // over-processes it.
    bool cleanModel = false;
};

// Stateless offline drum-stem enhancer. `process` mutates `buffer` in place at
// `sampleRate`; it is a guaranteed no-op when disabled, empty, non-finite, or
// silent, and self-bypasses the expander when the material has too little
// loud/quiet contrast for safe gating. Mono and stereo buffers are both handled
// (the detector and the gain are shared across channels so the stereo image and
// kit balance are preserved).
class DrumEnhancer
{
public:
    static void process(juce::AudioBuffer<float>& buffer, double sampleRate,
                        const DrumEnhanceOptions& options);
};

} // namespace silverdaw
