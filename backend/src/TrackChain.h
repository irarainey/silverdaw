#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

/**
 * Canonical per-track DSP chain shared by the realtime `AudioEngine`
 * (live monitoring) and the offline `MixdownEngine` (export). Owning
 * the same abstraction in both engines is what guarantees "what you
 * hear is what you export" — see §7.9.6 in `.ref/daw-design-plan.md`.
 *
 * **Phase 5 step 1b — empty chain.** This is a sample-equivalent
 * passthrough today. Subsequent Phase 5 steps insert real nodes in
 * the order documented in §7.9.2:
 *
 *   Tone (3-band EQ + Low Cut)  → Leveler (Compressor)
 *     → gain  → mute / solo gate
 *
 * The `process` call is the one signal-domain insertion point both
 * engines call per block — adding a node later means populating it
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
        juce::ignoreUnused(sampleRate, maxBlockSize, numChannels);
    }

    /** Wipe all DSP node state. Called on transport stop and on
     *  catastrophic seek (per §7.10 transport rules). Pause does NOT
     *  call reset — see §7.10. */
    void reset() noexcept {}

    /** In-place per-block DSP on a stereo (or mono) block already
     *  summed from this track's clips. `startSample` and `numSamples`
     *  bracket the active region inside `buffer` (matching JUCE's
     *  `AudioSourceChannelInfo` convention so the live engine can
     *  forward straight through).
     *
     *  Phase 5 step 1b: sample-equivalent no-op — every byte of the
     *  active region is preserved. This is what makes the parity
     *  harness (§7.9.6 conditions a–d) pass after the refactor lands. */
    void process(juce::AudioBuffer<float>& buffer, int startSample, int numSamples) noexcept
    {
        juce::ignoreUnused(buffer, startSample, numSamples);
    }

    TrackChain(const TrackChain&) = delete;
    TrackChain& operator=(const TrackChain&) = delete;
    // Move is allowed so callers can hold `TrackChain` directly inside
    // moveable owners (e.g. `OfflineTrack` in `std::vector` in
    // `MixdownEngine`). Future DSP nodes added here must keep their
    // own members move-safe — biquad histories, smoothed-value state,
    // and `juce::AudioBuffer` all are by default.
    TrackChain(TrackChain&&) noexcept = default;
    TrackChain& operator=(TrackChain&&) noexcept = default;
};

} // namespace silverdaw
