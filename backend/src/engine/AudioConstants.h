
#pragma once

namespace silverdaw
{

inline constexpr float kMinTrackGain = 0.0F;
inline constexpr float kMaxTrackGain = 4.0F;

// Shared read-ahead size keeps live track and preview buffering aligned.
inline constexpr int kTransportReadAheadSamples = 8192;

inline constexpr int kPrimeProbeSamples = 4096;
inline constexpr int kPrimeReadyTargetSamples = (kTransportReadAheadSamples * 7) / 8;
inline constexpr int kPrimePerTrackTimeoutMs = 250;
inline constexpr int kPlayPrimeBudgetMs = 3000;
inline constexpr int kLoadPrimeBudgetMs = 1500;

// Continuous, inaudible keep-alive dither holds sleep-prone USB DACs awake while the device is the
// selected output. Unlike a near-Nyquist tone (which a DAC's reconstruction filter strips before
// its auto-mute detector, so the endpoint sleeps anyway), continuous broadband dither keeps *every*
// sample non-zero with steady in-band energy the detector registers as "audio present", while
// sitting at the format noise floor so it is inaudible. Injected POST master-gain, so the project's
// own volume never attenuates it (only the OS endpoint volume can).
//
// Amplitude is the single tuning knob: ~2 LSB of a 16-bit endpoint (1/16384 ~= -84 dBFS peak) — at
// the noise floor, inaudible. Raise it if a particularly aggressive endpoint still sleeps; lower it
// if a sensitive IEM reveals a faint hiss in true silence.
inline constexpr float kKeepAliveDitherPeak = 1.0F / 16384.0F; // ~2 LSB @16-bit, inaudible

// Only inject on otherwise-silent blocks; real programme above this passes through untouched.
inline constexpr float kKeepAliveSilenceThreshold = 1.0e-3F;

// One-time wake burst to rouse a *cold* sleep-prone endpoint — e.g. a USB DAC that auto-muted its
// amp while Silverdaw was closed, was just (re)connected, or relaxed back to mute between plays. The
// continuous dither above HOLDS a warm device awake but is far too quiet to *wake a cold one*, so
// without a kick the first play after the amp mutes is swallowed (heard as a click + missing first
// beat). A brief, decaying *broadband* burst is emitted (a) once at every device (re)start, and
// (b) as a short audio-thread pre-roll at the start of each play on a sleep-prone endpoint (see
// MasterClockSource) — both running while the amp is muted, so the burst itself is inaudible yet
// carries enough in-band energy to cross the hardware's auto-mute wake threshold. The pre-roll runs
// entirely on the audio thread (the message thread never blocks) and does not advance the transport,
// so the downbeat is preserved and plays at full level the instant the amp is awake.
//
// Amplitude/length are empirical: raise kWakeBurstPeak if a stubborn amp still swallows the opening;
// lower it (or shorten the pre-roll) if a rapid replay onto an already-warm amp produces an audible
// tick. The burst sits in the audible band (a near-Nyquist tone is filtered out by a DAC's
// reconstruction filter before its detector ever sees it), but is masked by the muted amp.
inline constexpr float kWakeBurstPeak = 0.05F; // ~-26 dBFS broadband; rouses a cold/muted amp
inline constexpr int kWakeBurstMs = 300;       // burst decays to the holding dither over this time
inline constexpr int kWakePrerollMs = 250;     // per-play audio-thread wake lead-in (USB endpoints)

// A play onto an endpoint that is already awake needs no wake burst — bursting into a warm amp is
// just audible noise (heard as a hiss at the start of playback), most obvious when auditioning
// clips with leading silence back-to-back in the Clip Editor / preview. Real programme audio proves
// the amp is awake, so we treat the endpoint as "warm" for this long after the last above-threshold
// output and suppress the otherwise-redundant per-play wake burst during that window.
//
// Deliberately SHORT: sleep-prone amps can relax back to mute within ~1s (and some mute
// progressively quicker over repeated wake cycles), so a long window would keep reporting "warm"
// after the amp has actually gone cold — skipping the burst and swallowing the opening. Keeping it
// well under a typical relax time re-arms the burst soon after audio stops, trading the odd faint
// start-of-play hiss on a very rapid replay for reliable waking. Tunable: raise it if a warm amp
// still hisses on quick replays; lower it if a genuinely cold play is ever swallowed again.
inline constexpr int kWarmHoldMs = 800;

inline constexpr int kDefaultSampleRate = 44100;
inline constexpr int kAltSampleRate = 48000;

inline constexpr bool isSupportedSampleRate(int rate) noexcept
{
    return rate == kDefaultSampleRate || rate == kAltSampleRate;
}

} // namespace silverdaw
