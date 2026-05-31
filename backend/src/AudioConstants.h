// Shared audio-domain constants.
//
// These values are invariants the live engine (AudioEngine) and the
// offline renderer (MixdownEngine) must agree on for playback and export
// to stay bit-aligned. They used to be repeated as bare literals across
// translation units with "keep this in sync" comments — a drift hazard.
// Define each one here so there is a single source of truth.

#pragma once

namespace silverdaw
{

/** Linear track-gain clamp range. +12 dB ceiling (4.0). Live
 *  (AudioEngine::addClip / setClipGain) and offline
 *  (snapshotProjectForMixdown) clamp user gain to this exact range so
 *  the export matches what the user heard. */
inline constexpr float kMinTrackGain = 0.0F;
inline constexpr float kMaxTrackGain = 4.0F;

/** Transport read-ahead buffer size in samples, shared by per-track and
 *  preview sources so warp priming and seek behaviour are identical
 *  across both paths (~186 ms at 44.1 kHz). */
inline constexpr int kTransportReadAheadSamples = 8192;

/** Read-ahead "first block ready" priming (see
 *  AudioEngine::primeTracksForPlayback). We block-fill each track's
 *  BufferingAudioSource at the current playhead before opening the master
 *  gate so the first audio callback after "press play" is a buffer hit
 *  rather than a cache miss — making playback start instant from any
 *  position, even straight after a project load or a seek.
 *
 *  - kPrimeProbeSamples: how much (in source-rate samples) we require to be
 *    buffered ahead of the playhead. Comfortably larger than any realistic
 *    device block (after resampling) so the whole first callback is covered.
 *  - kPrimePerTrackTimeoutMs: ceiling on the wait for any single track.
 *  - kPlayPrimeBudgetMs: total wall-clock ceiling when priming from play(),
 *    kept tight so a cold disk or stalled track can never turn pressing play
 *    into a long stall — we would rather start a touch early than block.
 *  - kLoadPrimeBudgetMs: total ceiling when priming at project-load time,
 *    off the interactive hot path, so the first play after a load is already
 *    fully warm. */
inline constexpr int kPrimeProbeSamples = 4096;
inline constexpr int kPrimePerTrackTimeoutMs = 120;
inline constexpr int kPlayPrimeBudgetMs = 300;
inline constexpr int kLoadPrimeBudgetMs = 1500;

/** Sample rates the engine renders at natively. Any other requested
 *  rate is treated as "follow the default" and resampled on the final
 *  pass rather than rendered directly. */
inline constexpr int kDefaultSampleRate = 44100;
inline constexpr int kAltSampleRate = 48000;

/** True when `rate` is one the engine can render at without a final
 *  resample. */
inline constexpr bool isSupportedSampleRate(int rate) noexcept
{
    return rate == kDefaultSampleRate || rate == kAltSampleRate;
}

} // namespace silverdaw
