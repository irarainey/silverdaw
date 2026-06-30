#pragma once

// Offline post-separation cleanup *and* enhancement for the *bass* stem. Like
// Vocal/DrumEnhancer this runs on a worker thread after htdemucs-ft has produced
// (and denormalised) a bass buffer and before it is written to disk — it is NOT
// real-time code, so it may allocate and make multiple passes.
//
// Two stages run in order. (1) CLEANUP — the gentlest of the three: a subsonic
// high-pass (DC/rumble only — never a musical high-pass, a low-B/808 fundamental
// sits near 30 Hz) followed by a soft, range-limited downward EXPANDER that pulls
// down low-level bleed (vocals, cymbals, guitar leaking into the bass stem) in the
// gaps between notes. (2) ENHANCEMENT — a harmonic exciter that isolates the low
// band, generates harmonics through a tanh nonlinearity and adds only the UPPER
// harmonics (high-passed > ~120 Hz) back in parallel at a conservative,
// strength-scaled amount, so the bass keeps its definition and translates on small
// speakers without touching the fundamental or sub. A soft-knee limiter follows so
// the added energy can never hard-clip. The enhancement runs even when the cleanup
// self-bypasses, and is a no-op on silence.
//
// Two choices suit sustained low-frequency material: (1) the detector runs off a
// low-passed (~600 Hz) copy of the signal so high-frequency bleed cannot hold
// the expander open, and uses RMS-style smoothing with slow ballistics so it
// does not ripple at the note's own waveform period; (2) the threshold is
// anchored to a robust high percentile of the level and the expander self-
// bypasses when the stem has little gap contrast (continuous/sustained bass),
// where gating would only expose separation artefacts.
//
// Low-end mono-folding, glue compression, makeup gain and loudness normalisation
// remain out of scope here: they turn cleanup into mix processing and would break
// the relative balance the stems recombine to. The exciter only adds upper
// harmonics in parallel — it does not raise the fundamental's level.

#include <juce_audio_basics/juce_audio_basics.h>

#include <juce_core/juce_core.h>

namespace silverdaw
{

// How hard the cleanup leans on the signal. Scales the subsonic corner, the
// expander threshold, ratio, attenuation range and ballistics together.
enum class BassEnhanceStrength
{
    Light,
    Medium,
    Strong
};

// Parses the renderer's "light"/"medium"/"strong" token (case-insensitive);
// anything else falls back to Medium so a bad payload never disables cleanup
// when the user asked for it.
BassEnhanceStrength bassEnhanceStrengthFromString(const juce::String& text) noexcept;
const char* bassEnhanceStrengthToString(BassEnhanceStrength strength) noexcept;

struct BassEnhanceOptions
{
    bool enabled = false;
    BassEnhanceStrength strength = BassEnhanceStrength::Medium;
    // True when the bass came from the high-SDR RoFormer rhythm pack rather than
    // the htdemucs backup. The harmonic exciter and cleanup expander are then
    // scaled back, because the already-clean stem doesn't need the htdemucs-grade
    // definition boost.
    bool cleanModel = false;
};

// Stateless offline bass-stem enhancer. `process` mutates `buffer` in place at
// `sampleRate`; it is a guaranteed no-op when disabled, empty, non-finite, or
// silent, and self-bypasses the expander when the material has too little
// note/gap contrast for safe gating. Mono and stereo buffers are both handled
// (the detector and the gain are shared across channels so the stereo image is
// preserved).
class BassEnhancer
{
public:
    static void process(juce::AudioBuffer<float>& buffer, double sampleRate,
                        const BassEnhanceOptions& options);
};

} // namespace silverdaw
