#pragma once

// Offline presence/level restoration for a de-reverbed *vocals* stem. Runs on a
// worker thread as the FINAL step of the vocal cleanup chain — after the STFT
// de-reverb, the RNNoise denoise, and the downward expander — and ONLY when the
// per-run de-reverb was requested. It is NOT real-time code.
//
// Why it exists: spectral-subtraction de-reverb removes broadband energy, which
// disproportionately dulls the high-frequency harmonics ("presence"/"air") and
// lowers perceived loudness, so the vocal comes out flat and lifeless. This stage
// counters exactly that with two gentle high-shelves (presence + air) and a level
// make-up gain that restores the loudness the subtraction removed, scaled by the
// chosen de-reverb strength. It runs LAST, after the denoise/expander have already
// removed musical noise, so the shelves brighten the clean vocal rather than
// amplifying subtraction artefacts; and the make-up is applied AFTER the downward
// expander so it can never lift the noise/reverb floor back above the expander
// threshold (which would defeat it).
//
// Deliberately NOT a full loudness normaliser: the level restoration is a single
// STATIC gain that matches the stem's ACTIVE (loud-frame) loudness back to a
// reference captured BEFORE the de-reverb ran, so it undoes the level drop that
// spectral subtraction causes without (a) re-inflating the residual reverb — the
// active-frame metric ignores the quiet gaps/tails the de-reverb rightly pulled
// down — or (b) pumping, since one scalar is applied to the whole stem. A soft-knee
// limiter prevents the shelves/make-up from ever clipping the stem.

#include "Dereverberator.h" // DereverbStrength

#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

// Stateless offline vocal presence/level restorer. `process` mutates `buffer` in
// place at `sampleRate`, scaled by `strength` (the same strength the de-reverb ran
// at). `referenceLevel` is the vocal's active loudness (see `activeLoudness`) sampled
// BEFORE the de-reverb, which the restorer's make-up gain matches back to; pass 0 to
// skip level matching (leaving only the tonal shelves). Guaranteed no-op when the
// buffer is empty or contains any non-finite sample, and all-or-nothing: if the
// filtered result is ever non-finite the buffer is left exactly as it was, so the
// stem can never be corrupted. Mono and stereo are both handled; the same shelf,
// make-up and soft-knee limiter are applied per channel so the stereo image is
// preserved.
class VocalRestorer
{
public:
    // Diagnostics returned by `process` so the caller can log what the level match did
    // (all in linear amplitude except `makeupDb`): the reference it targeted, the
    // stem's measured active loudness after the tonal shelves, the gain applied, and
    // whether that gain hit its clamp (a sign the de-reverb removed more level than the
    // match is allowed to restore). All zero when the pass was a no-op.
    struct Result
    {
        float referenceLevel = 0.0f;
        float processedLevel = 0.0f;
        float makeup = 1.0f;
        float makeupDb = 0.0f;
        bool clamped = false;
    };

    static Result process(juce::AudioBuffer<float>& buffer, double sampleRate,
                          DereverbStrength strength, float referenceLevel);

    // Active (loud-frame) loudness of `buffer`: the RMS taken over only the short
    // blocks whose energy is within a gate of the loudest block, so silence, gaps and
    // decaying reverb tails don't drag the figure down. Used to capture the reference
    // level before de-reverb and to measure the restored stem, so the two match on the
    // parts that carry the voice. Returns 0 for an empty/silent/non-finite buffer.
    static float activeLoudness(const juce::AudioBuffer<float>& buffer, double sampleRate) noexcept;
};

} // namespace silverdaw
