#pragma once

// Offline reverb/echo reduction for the *vocals* stem. Runs on a worker thread
// after separation (and the optional de-bleed), before the RNNoise denoise — it
// is NOT real-time code, so it may allocate and make an STFT pass.
//
// Algorithm: a conservative statistical late-reverb soft-mask in the STFT domain
// (a Lebart/Habets-style estimator). Reverb has no separate reference signal, so the
// late-reverberant power per frequency bin is *estimated* as a recursively-accumulated,
// room-decayed copy of the signal's own (delayed, smoothed) power spectrum — a diffuse
// sum over past frames, present CONTINUOUSLY, not only in gaps. That estimate is then
// spectrally over-subtracted with a floor and a cap (so a steady note is never crushed
// to the floor), giving a gain in [sqrt(floor), 1]. Because it acts on reverb embedded
// IN sustained singing it is audibly effective, at the cost of drying held notes
// somewhat (single-channel dereverb cannot tell a dry sustained vowel from a
// reverberant one — the floor/cap/wet bound how far it goes). The gain is strictly
// attenuating (never amplifies or nulls a bin), smoothed across time AND frequency to
// avoid musical noise, broadband onsets are protected so vocal attacks stay crisp, and
// the result is a wet/dry blend — so the worst case is an over-dry vocal, never a
// numeric blow-up. Full WPE-style linear prediction was deliberately rejected: it is
// far harder to keep stable and its failure modes are audible in ways a numeric test
// can't catch. It targets room reverb and slap-back echo, not broadband hiss
// (VocalDenoiser's job) or pitched instrument bleed (VocalDebleeder's).

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

#include <functional>

namespace silverdaw
{

// How hard the reverb reduction leans on the signal. Scales the wet mix, the gain
// floor, and the reverb-energy weight together so a "light" pass barely touches a
// nearly-dry vocal while "strong" pulls a wet room down harder.
enum class DereverbStrength
{
    Light,
    Medium,
    Strong
};

// Parses the renderer's "light"/"medium"/"strong" token (case-insensitive);
// anything else falls back to Medium so a bad payload never silently disables the
// reduction when the user asked for it.
DereverbStrength dereverbStrengthFromString(const juce::String& text) noexcept;
const char* dereverbStrengthToString(DereverbStrength strength) noexcept;

// Per-run reverb-reduction request for the vocals stem. Off by default; chosen at
// separation time (never a persisted preference), resolved from the STEM_SEPARATE
// payload by the command layer.
struct DereverbOptions
{
    bool enabled = false;
    DereverbStrength strength = DereverbStrength::Medium;
};

// Stateless offline vocal de-reverberator. `process` mutates `buffer` in place at
// `sampleRate`. Guaranteed no-op when the buffer is empty, shorter than one STFT
// frame, or contains any non-finite sample, so it can never corrupt or drop the
// stem. The output is only ever attenuated (bounded per-bin gain in [gMin, 1]) and
// stays finite; its peak stays at or near the input's (a hair of windowing/OLA
// slack aside). Mono and stereo are both handled; a single shared per-bin gain is
// applied across channels so the stereo image is preserved.
//
// `onProgress`, when set, is called with a monotonic 0..1 fraction as the pass
// advances (throttled), so callers can keep a progress bar moving.
class Dereverberator
{
public:
    static void process(juce::AudioBuffer<float>& buffer, double sampleRate,
                        DereverbStrength strength,
                        const std::function<void(double)>& onProgress = {});
};

} // namespace silverdaw
