#pragma once

#include "ToneEq.h"

#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

/**
 * Canonical per-track DSP chain shared by the realtime `AudioEngine`
 * (live monitoring) and the offline `MixdownEngine` (export). Owning
 * the same abstraction in both engines is what guarantees "what you
 * hear is what you export" — see §7.9.6 in `.ref/daw-design-plan.md`.
 *
 * **Phase 5 — Tone live.** The chain now applies the per-track Tone EQ
 * (3-band fixed-frequency tilt + Low Cut, see `ToneEq.h`). Remaining
 * nodes are inserted in the order documented in §7.9.2:
 *
 *   Tone (3-band EQ + Low Cut)  → Leveler (Compressor)
 *     → gain  → mute / solo gate
 *
 * Tone is the first populated node; Leveler / gain / gate still land in
 * later steps. The `process` call is the one signal-domain insertion
 * point both engines call per block — adding a node later means
 * populating it
 * here, not threading new code through every call site.
 *
 * **Lifetime.** One `TrackChain` per `TrackRuntime` (live) and one
 * per `OfflineTrack` (mixdown). DSP node state (biquad histories,
 * Leveler detector, smoothed parameters) lives across the lifetime
 * of the chain — that is the whole reason the chain is per-track,
 * not per-clip: a Leveler detector that resets at every clip edge
 * would thump on adjacent-clip boundaries. See §7.9.1 in the design
 * plan.
 *
 * **Realtime safety.** All future node implementations must obey the
 * same rules as `BusGraph` (§7.9.1 invariants block): no allocation,
 * no locking, no resize inside `process`. `prepare` is the only
 * place to size internal state; `reset` is the only place to clear
 * it. The audio thread only calls `process`.
 */
class TrackChain
{
public:
    TrackChain() = default;

    /** Called once before any `process` call, and re-called whenever
     *  the sample rate, block size, or channel count changes. Future
     *  DSP nodes allocate their internal state here.
     *
     *  @param sampleRate    Effective project sample rate (the rate
     *                       the per-track scratch buffer lives at).
     *  @param maxBlockSize  Upper bound on `numSamples` passed to
     *                       `process`. `BusGraph` chunks oversize
     *                       device requests through this so this
     *                       can stay tight (§7.9.1 invariants).
     *  @param numChannels   2 today (stereo); kept as a parameter so
     *                       any node that wants per-channel state
     *                       (Tone biquads, Leveler detector) sizes
     *                       correctly without re-introspecting.
     */
    void prepare(double sampleRate, int maxBlockSize, int numChannels) noexcept
    {
        juce::ignoreUnused(maxBlockSize);
        tone.prepare(sampleRate, numChannels);
    }

    /** Wipe all DSP node state. Called on transport stop and on
     *  catastrophic seek (per §7.10 transport rules). Pause does NOT
     *  call reset — see §7.10. */
    void reset() noexcept { tone.reset(); }

    /** Publish per-track Tone EQ targets. Called from the message thread
     *  under the owning `BusGraph` lock (the audio thread holds the same
     *  lock while in `process`). `snap` collapses the parameter smoother
     *  so the new response is steady-state on the next block — used by the
     *  project-load / mixdown-setup / runtime-creation paths so the
     *  offline export matches live playback exactly (§7.9.6). Live UI
     *  gestures pass `snap=false` to glide and avoid zipper noise. */
    void setTone(float bassDb, float midDb, float trebleDb, bool lowCut,
                 bool snap) noexcept
    {
        tone.setParams(bassDb, midDb, trebleDb, lowCut, snap);
    }

    /** In-place per-block DSP on a stereo (or mono) block already
     *  summed from this track's clips. `startSample` and `numSamples`
     *  bracket the active region inside `buffer` (matching JUCE's
     *  `AudioSourceChannelInfo` convention so the live engine can
     *  forward straight through).
     *
     *  Applies the per-track Tone EQ in place. When all bands sit at
     *  0 dB and Low Cut is off the EQ is sample-transparent (identity
     *  coefficients), preserving the §7.9.6 parity guarantee for
     *  untouched tracks. */
    void process(juce::AudioBuffer<float>& buffer, int startSample, int numSamples) noexcept
    {
        tone.process(buffer, startSample, numSamples);
    }

    TrackChain(const TrackChain&) = delete;
    TrackChain& operator=(const TrackChain&) = delete;
    // Move is allowed so callers can hold `TrackChain` directly inside
    // moveable owners (e.g. `OfflineTrack` in `std::vector` in
    // `MixdownEngine`). `ToneEq` holds only plain value members (no
    // atomics), so the defaulted move stays valid and move-safe.
    TrackChain(TrackChain&&) noexcept = default;
    TrackChain& operator=(TrackChain&&) noexcept = default;

private:
    ToneEq tone;
};

} // namespace silverdaw
