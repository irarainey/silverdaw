#pragma once

// Cross-stem vocal de-bleed (offline, post-separation). htdemucs leaves pitched
// instrument bleed — snare/cymbal tails, guitar, synth — in the vocal stem that
// a single-stem denoiser cannot touch (it is not broadband hiss; it is musical
// content). But we ALSO have a clean estimate of exactly that interferer: the
// instrumental = mixture - vocals. This stage runs a conservative Wiener-style
// soft mask in the STFT domain — attenuating each time/frequency cell of the
// vocal in proportion to how strongly the instrumental dominates it — so bleed
// is pushed down without the musical-noise of blind spectral subtraction (the
// interferer is measured, not guessed). A soft floor caps the maximum cut so the
// stage can never fully null a bin (no "underwater" artefacts).
//
// Offline / worker-thread only: it allocates and runs an FFT, so it is NOT
// real-time code. Reuses VocalEnhanceStrength so the de-bleed intensity tracks
// the rest of the vocal cleanup.

#include "VocalEnhancer.h"

#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

// Stateless offline cross-stem de-bleeder. `process` mutates `vocal` in place,
// using `instrumental` (the everything-but-vocals estimate, typically
// `mixture - vocal`) as the interference reference. Both buffers must share the
// sample rate, channel count, and length; mismatches and silent/empty inputs are
// a guaranteed no-op. Non-finite samples are sanitised so the stem can never be
// corrupted.
class VocalDebleeder
{
public:
    static void process(juce::AudioBuffer<float>& vocal,
                        const juce::AudioBuffer<float>& instrumental, double sampleRate,
                        VocalEnhanceStrength strength);
};

} // namespace silverdaw
