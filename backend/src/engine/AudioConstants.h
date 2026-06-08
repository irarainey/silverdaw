
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

// Keep-alive floor wakes sleep-prone endpoints without colouring non-silent blocks.
inline constexpr float kKeepAliveDitherAmplitude = 0.004F; // ~-48 dBFS peak

// Keep-alive only wakes sleep-prone endpoints; idle output remains true digital silence.
inline constexpr float kKeepAliveSilenceThreshold = 1.0e-3F;

inline constexpr int kWakePrerollMs = 250;

// Wake pre-roll spends endpoint fade-in on the keep-alive floor, not the first content attack.
inline constexpr int kEndpointWarmWindowMs = 1500;

inline constexpr int kDefaultSampleRate = 44100;
inline constexpr int kAltSampleRate = 48000;

inline constexpr bool isSupportedSampleRate(int rate) noexcept
{
    return rate == kDefaultSampleRate || rate == kAltSampleRate;
}

} // namespace silverdaw
