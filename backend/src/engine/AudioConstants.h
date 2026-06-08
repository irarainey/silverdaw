
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

// Inaudible ultrasonic keep-alive tone holds sleep-prone USB DACs awake while a project is
// loaded, so the first play is instant — without the audible hiss of a broadband floor or the
// latency of a wake pre-roll. The tone sits just below Nyquist (above human hearing) yet is a
// strong, clearly non-silent signal to the DAC's auto-mute detector. Kept at a very low level
// so any ultrasonic energy that reaches a transducer cannot stress it or cause audible IMD.
inline constexpr float kKeepAliveTonePeak = 0.004F; // ~-48 dBFS peak, inaudible (ultrasonic)

// Only inject the tone on otherwise-silent blocks; real programme above this passes through.
inline constexpr float kKeepAliveSilenceThreshold = 1.0e-3F;

// Click-free fade as the tone engages/disengages across silent/non-silent block boundaries.
inline constexpr double kKeepAliveRampSeconds = 0.01; // 10 ms

inline constexpr int kDefaultSampleRate = 44100;
inline constexpr int kAltSampleRate = 48000;

inline constexpr bool isSupportedSampleRate(int rate) noexcept
{
    return rate == kDefaultSampleRate || rate == kAltSampleRate;
}

} // namespace silverdaw
