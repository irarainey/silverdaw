#pragma once

// Offline post-separation cleanup for the *bass* stem. Like Vocal/DrumEnhancer
// this runs on a worker thread after htdemucs-ft has produced (and denormalised)
// a bass buffer and before it is written to disk — it is NOT real-time code, so
// it may allocate and make multiple passes. It is deliberately the gentlest of
// the three enhancers: a subsonic high-pass (DC/rumble only — never a musical
// high-pass, a low-B/808 fundamental sits near 30 Hz) followed by a soft,
// range-limited downward EXPANDER that pulls down low-level bleed (vocals,
// cymbals, guitar leaking into the bass stem) in the gaps between notes.
//
// Two choices suit sustained low-frequency material: (1) the detector runs off a
// low-passed (~600 Hz) copy of the signal so high-frequency bleed cannot hold
// the expander open, and uses RMS-style smoothing with slow ballistics so it
// does not ripple at the note's own waveform period; (2) the threshold is
// anchored to a robust high percentile of the level and the expander self-
// bypasses when the stem has little gap contrast (continuous/sustained bass),
// where gating would only expose separation artefacts.
//
// Low-end mono-folding, glue compression, makeup gain, loudness normalisation
// and any additive "enhancement" are intentionally out of scope here: they turn
// cleanup into mix processing and would break the relative balance the stems
// recombine to.

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
