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
 *  - kPrimeProbeSamples: the minimum (in source-rate samples) we ever require
 *    to be buffered — comfortably larger than any realistic device block after
 *    resampling, so even a near-EOF clip covers the first callback.
 *  - kPrimeReadyTargetSamples: the deep cushion we actually fill before opening
 *    the master gate. It must absorb the whole cold-start transient, not just
 *    the first callback. JUCE's BufferingAudioSource *drops* (does not delay)
 *    samples on a partial cache miss — getNextAudioBlock clears the unbuffered
 *    tail yet still advances its read cursor — so any underrun while the shared
 *    read-ahead thread is still warming up (resampler priming, RubberBand warp,
 *    cold file cache) permanently swallows the start of the audio. A small
 *    low-latency output buffer plus many resampled/warped tracks is exactly
 *    when that bites, so we prime most of the read-ahead buffer up front.
 *  - kPrimePerTrackTimeoutMs: ceiling on a single per-track wait slice. A
 *    track that is not ready after a slice is retried on the next pass (see
 *    AudioEngine::primeTracksForPlayback) so a single cold track gets the whole
 *    remaining budget across passes, not just one slice.
 *  - kPlayPrimeBudgetMs: overall wall-clock ceiling when priming from play().
 *    play() is fail-closed — it opens the master gate only once every track is
 *    ready, so this budget must be generous enough to absorb a cold-start fill
 *    (first play after launch + project open, when the OS file cache is cold and
 *    several tracks share one read-ahead thread). It is an early-exit ceiling,
 *    not a fixed cost: the common warm case returns in well under a millisecond,
 *    and the message thread only ever waits this long on a genuinely cold first
 *    play. Biased hard towards correctness (start from the very first sample,
 *    never a silent first play that "works on retry") over start latency.
 *  - kLoadPrimeBudgetMs: total ceiling when pre-warming at project-load time,
 *    off the interactive hot path, so the first play after a load is already
 *    fully warm. */
inline constexpr int kPrimeProbeSamples = 4096;
inline constexpr int kPrimeReadyTargetSamples = (kTransportReadAheadSamples * 7) / 8;
inline constexpr int kPrimePerTrackTimeoutMs = 250;
inline constexpr int kPlayPrimeBudgetMs = 3000;
inline constexpr int kLoadPrimeBudgetMs = 1500;

/** Output "keep-alive" dither peak amplitude (linear, full scale = 1.0),
 *  injected into master output blocks that are otherwise (near-)silent —
 *  see MasterClockSource::applyKeepAlive. The output device must never see
 *  a sustained run of digital silence: some endpoints — notably USB-C
 *  headphone dongles and USB-Audio-Class endpoints — silence-detect and
 *  soft-mute during silence, then apply a wake-up fade on the next audible
 *  block, swallowing the attack of the first audio after the gap. A first
 *  attempt at ~-84 dBFS did not keep this endpoint awake, so the floor sits at
 *  ~-48 dBFS — comfortably above a typical silence-detector threshold yet far
 *  below content level. It is applied at the final output stage (post master
 *  gain) so a low master volume can never attenuate it below the level the
 *  endpoint needs, and it is gated to silent blocks only
 *  (kKeepAliveSilenceThreshold) so it is never mixed into real audio.
 *
 *  The floor only runs when output is genuinely needed: while *playing* (to
 *  fill leading silence or any gap with no active clip), and during a short
 *  *wake pre-roll* fired before a cold-start play so the endpoint's wake fade
 *  is spent on the floor rather than the first musical attack. While the app
 *  sits idle/paused it emits TRUE digital silence — no continuous floor — so a
 *  loaded-but-stopped project makes no sound: clean playback, awake device on
 *  the first note, silent idle. */
inline constexpr float kKeepAliveDitherAmplitude = 0.004F; // ~-48 dBFS peak

/** Block-peak below which the produced mix is treated as silence and the
 *  keep-alive floor is injected (≈ -60 dBFS). Above this the block carries
 *  real audio and is left untouched, so the keep-alive never colours
 *  content — it only fills true gaps to keep the device awake. */
inline constexpr float kKeepAliveSilenceThreshold = 1.0e-3F;

/** Duration of the wake pre-roll held before a cold-start play (or preview):
 *  the output keep-alive floor runs for this long with the transport gate
 *  still closed, so a sleep-prone endpoint completes its wake-up fade on the
 *  floor instead of swallowing the first musical attack. Kept short — this is
 *  a studio tool, not a live instrument, so a brief deterministic latency on a
 *  cold play is acceptable; the warm path (see below) skips it entirely. */
inline constexpr int kWakePrerollMs = 250;

/** Idle gap after which the output endpoint is assumed to have gone to sleep.
 *  A play that follows less than this much silence since output was last active
 *  starts instantly (warm endpoint); a longer gap triggers the wake pre-roll.
 *  Chosen conservatively below typical USB/endpoint sleep timers so rapid
 *  play/stop editing stays instant while a genuinely idle endpoint is woken. */
inline constexpr int kEndpointWarmWindowMs = 1500;

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
