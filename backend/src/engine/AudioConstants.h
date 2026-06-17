
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

// Sub-LSB "fluctuate" keep-alive holds sleep-prone USB DACs awake while Silverdaw is open, so
// every stop->play is instant — without the audible hiss of a broadband floor or the latency of
// a wake pre-roll. Rather than a near-Nyquist tone (which a DAC's reconstruction filter attenuates
// before its auto-mute detector ever sees it), it emits isolated, sign-alternating, minimal-
// amplitude impulses. An impulse is broadband: it puts a sliver of energy across the whole
// spectrum — including the band the DAC's "audio present" detector actually monitors — so the
// endpoint reliably registers it as non-silence and stays awake. Each impulse sits near the
// format noise floor, so the stream is inaudible. Injected POST master-gain, so the project's
// own volume never attenuates it (only the OS endpoint volume can).
inline constexpr float kKeepAliveImpulse = 1.0F / 8192.0F; // ~-78 dBFS, broadband, inaudible

// Only inject on otherwise-silent blocks; real programme above this passes through untouched.
inline constexpr float kKeepAliveSilenceThreshold = 1.0e-3F;

// Maintenance impulse rate: a few impulses per audio block is enough to hold a *warm* endpoint
// out of auto-mute (50 fluctuations/second is a well-proven rate for this).
inline constexpr double kKeepAliveFluctuateHz = 50.0;

// Waking a *cold* DAC (just plugged in, freshly selected, or woken from deep sleep) needs a
// stronger "signal present" kick plus a little lock time. On the FIRST play after an output
// device (re)start — and only on a sleep-prone (USB) endpoint — the engine arms a *denser* impulse
// stream (the same inaudible amplitude, many more non-zero frames per second) for kWakePrerollMs,
// then starts content. One-time per device session; every later play is instant. This is the
// small, acceptable first-play lead-in.
inline constexpr double kWakeFluctuateHz = 1000.0; // denser cold-wake kick (same amplitude)
inline constexpr int kWakePrerollMs = 500;         // one-time first-play wake lead-in

// Short master fade-in applied the instant playback starts (the output gate opening from digital
// silence onto programme that begins mid-waveform — e.g. a clip, or a separated stem, whose first
// sample is not at a zero crossing — would otherwise step discontinuously and click). A few
// milliseconds is musically imperceptible yet removes the transient.
inline constexpr double kPlayStartDeclickSeconds = 0.005; // 5 ms

inline constexpr int kDefaultSampleRate = 44100;
inline constexpr int kAltSampleRate = 48000;

inline constexpr bool isSupportedSampleRate(int rate) noexcept
{
    return rate == kDefaultSampleRate || rate == kAltSampleRate;
}

} // namespace silverdaw
