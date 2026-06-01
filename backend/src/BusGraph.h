#pragma once

#include "TrackChain.h"

#include <atomic>
#include <memory>
#include <unordered_map>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

namespace silverdaw
{

/**
 * `BusGraph` — project root pull-source for the realtime audio graph,
 * introduced in Phase 5 step 1c (see `.ref/daw-design-plan.md` §7.9.1).
 * Replaces the per-engine `juce::MixerAudioSource mixer` with a
 * purpose-built mixer that owns block lifecycle deterministically,
 * runs the canonical signal flow in a strict order each block, and
 * gives subsequent Phase 5 steps a single seam to insert shared
 * project FX (Room, Echo — step 7) and the master accumulator.
 *
 * **Topology after step 1c:**
 *
 *   clip transports → TrackRuntime.innerMixer → TrackChain
 *                                                  ↓
 *                                                BusGraph.dryBus  ← shared FX (step 7)
 *                                                  ↓
 *                                              master (MasterClockSource)
 *                                                  ↓
 *                                              topMixer  ← preview audio
 *                                                  ↓
 *                                              masterMeter → device
 *
 * **Invariants (must hold every block, audio-thread):**
 *
 * - All scratch buffers are owned by `BusGraph` and preallocated in
 *   `prepareToPlay` sized for `preparedMax × 2`. No allocation, no
 *   resize, no map insertion inside `getNextAudioBlock`.
 * - If the device requests a larger block than `preparedMax`,
 *   `getNextAudioBlock` **chunks** the callback through the
 *   preallocated scratch (`ceil(requestedBlock / preparedMax)`
 *   sub-blocks) so audio output is never interrupted by an oversize
 *   request — JUCE's host will trigger a fresh `prepareToPlay` for
 *   the larger size shortly after, but in the meantime we don't drop
 *   audio.
 * - Each `TrackRuntime` is pulled **exactly once per sub-block** so a
 *   compressor / EQ in the chain sees a contiguous sample stream
 *   with no double-pull artefacts.
 * - Track add / remove on the message thread takes the internal
 *   `juce::CriticalSection`; the audio thread takes the same lock at
 *   the top of `getNextAudioBlock`. This mirrors the
 *   `juce::MixerAudioSource` pattern shipped today; §7.11 promotes
 *   this to lock-free pointer publication in a later Phase 5 step.
 *
 * **What BusGraph is NOT.** Not a general routing engine — that's
 * the Phase 8 `juce::AudioProcessorGraph` migration. `BusGraph` is a
 * small, fixed-shape mixer purpose-built for Silverdaw's single
 * project bus + two shared sends model.
 */
class BusGraph final : public juce::AudioSource
{
public:
    /**
     * Per-UI-track runtime. As of step 1c, lives inside `BusGraph` so
     * the project mixer owns the entire track→runtime registry in
     * one place. `BusGraph` lazily creates a `TrackRuntime` the first
     * time a clip on a given `trackId` is attached, and destroys it
     * when the last clip is detached.
     *
     * `TrackRuntime` is itself an `AudioSource`: `getNextAudioBlock`
     * (a) pulls the inner `MixerAudioSource` to sum every clip
     * transport on this UI track, (b) runs the canonical
     * `TrackChain` over the summed block, then (c) taps per-channel
     * peak amplitude post-chain for the per-track UI meter. The
     * chain is sample-equivalent no-op today — subsequent Phase 5
     * steps populate it.
     */
    struct TrackRuntime final : public juce::AudioSource
    {
        juce::String trackId;
        juce::MixerAudioSource innerMixer;
        TrackChain chain;
        int clipCount = 0;
        // Post-chain "max sample magnitude since last drain" per
        // channel. Lock-free atomic store from the audio thread,
        // drained by the message-thread broadcaster — same pattern
        // as `MeteringSource` uses for the master bus.
        std::atomic<float> peakL{0.0F};
        std::atomic<float> peakR{0.0F};

        void prepareToPlay(int samplesPerBlockExpected, double sampleRate) override
        {
            innerMixer.prepareToPlay(samplesPerBlockExpected, sampleRate);
            chain.prepare(sampleRate, samplesPerBlockExpected, /*numChannels*/ 2);
        }

        void releaseResources() override
        {
            innerMixer.releaseResources();
            chain.reset();
        }

        void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override
        {
            innerMixer.getNextAudioBlock(info);
            if (info.buffer == nullptr || info.numSamples <= 0)
                return;
            chain.process(*info.buffer, info.startSample, info.numSamples);

            const int numCh = info.buffer->getNumChannels();
            if (numCh > 0)
                atomicMaxFloat(peakL,
                               info.buffer->getMagnitude(0, info.startSample, info.numSamples));
            if (numCh > 1)
                atomicMaxFloat(peakR,
                               info.buffer->getMagnitude(1, info.startSample, info.numSamples));
            else if (numCh > 0)
                atomicMaxFloat(peakR,
                               info.buffer->getMagnitude(0, info.startSample, info.numSamples));
        }

        /** Drain accumulated peaks and reset to 0 atomically. */
        void consumePeaks(float& outL, float& outR) noexcept
        {
            outL = peakL.exchange(0.0F, std::memory_order_relaxed);
            outR = peakR.exchange(0.0F, std::memory_order_relaxed);
        }

    private:
        static void atomicMaxFloat(std::atomic<float>& a, float v) noexcept
        {
            float cur = a.load(std::memory_order_relaxed);
            while (v > cur && ! a.compare_exchange_weak(cur, v, std::memory_order_relaxed))
            {
                // `cur` refreshed by compare_exchange_weak on failure.
            }
        }
    };

    BusGraph() = default;
    ~BusGraph() override = default;

    BusGraph(const BusGraph&) = delete;
    BusGraph& operator=(const BusGraph&) = delete;

    // ─── juce::AudioSource ──────────────────────────────────────────
    void prepareToPlay(int samplesPerBlockExpected, double sampleRate) override
    {
        const juce::ScopedLock sl(lock);
        preparedMax = juce::jmax(1, samplesPerBlockExpected);
        preparedRate = sampleRate;
        scratch.setSize(/*numChannels*/ 2, preparedMax, /*keepExisting*/ false,
                        /*clearExtra*/ true, /*avoidReallocating*/ false);
        scratch.clear();
        for (auto& kv : runtimes)
            kv.second->prepareToPlay(preparedMax, preparedRate);
    }

    void releaseResources() override
    {
        const juce::ScopedLock sl(lock);
        for (auto& kv : runtimes)
            kv.second->releaseResources();
    }

    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override
    {
        if (info.buffer == nullptr || info.numSamples <= 0) return;

        // Clear the requested active region first; we additively
        // accumulate every track into it across all sub-blocks.
        for (int ch = 0; ch < info.buffer->getNumChannels(); ++ch)
            info.buffer->clear(ch, info.startSample, info.numSamples);

        const juce::ScopedLock sl(lock);
        if (preparedMax <= 0 || runtimes.empty()) return;

        const int outChannels = juce::jmin(scratch.getNumChannels(),
                                           info.buffer->getNumChannels());
        if (outChannels <= 0) return;

        int remaining = info.numSamples;
        int dst = info.startSample;
        while (remaining > 0)
        {
            const int n = juce::jmin(remaining, preparedMax);
            for (auto& kv : runtimes)
            {
                // Each TrackRuntime fills `n` frames into `scratch`
                // starting at offset 0; we then add into `info.buffer`
                // at the destination offset. The scratch is cleared
                // per-track (not just per sub-block) because the
                // inner MixerAudioSource clears it itself — but we
                // belt-and-braces re-clear to make oversize-chunk
                // semantics unambiguous if the inner mixer is ever
                // swapped for something that accumulates.
                scratch.clear(0, n);
                juce::AudioSourceChannelInfo sub(&scratch, 0, n);
                kv.second->getNextAudioBlock(sub);
                for (int ch = 0; ch < outChannels; ++ch)
                    info.buffer->addFrom(ch, dst, scratch, ch, 0, n);
            }
            remaining -= n;
            dst += n;
        }
    }

    // ─── Message-thread API (clip ↔ track wiring) ──────────────────

    /** Attach a clip transport to its UI track. Creates the
     *  `TrackRuntime` lazily on the first clip per `trackId`. The
     *  caller (`AudioEngine::addClip`) must `detachClip` any
     *  previously-existing clip with the same `clipId` first — this
     *  method does not handle replacement.
     *
     *  Safe to call while the engine is running; the audio thread
     *  takes the same `CriticalSection` at the top of
     *  `getNextAudioBlock` so the graph snapshot it iterates is
     *  always consistent. */
    void attachClip(const juce::String& trackId,
                    const juce::String& clipId,
                    juce::AudioSource* clipTransport)
    {
        if (clipTransport == nullptr || trackId.isEmpty() || clipId.isEmpty()) return;
        const juce::ScopedLock sl(lock);

        auto rIt = runtimes.find(trackId);
        if (rIt == runtimes.end())
        {
            auto rt = std::make_unique<TrackRuntime>();
            rt->trackId = trackId;
            if (preparedMax > 0)
                rt->prepareToPlay(preparedMax, preparedRate);
            rIt = runtimes.emplace(trackId, std::move(rt)).first;
        }
        auto* rt = rIt->second.get();
        rt->innerMixer.addInputSource(clipTransport, false);
        ++rt->clipCount;
        clipToTrack[clipId] = rt;

        // Re-apply any tone parameters captured for this track while it had
        // no runtime (or before its first clip). Snapped so the response is
        // steady-state immediately — matches the load / mixdown paths.
        auto toneIt = pendingTone.find(trackId);
        if (toneIt != pendingTone.end())
        {
            const auto& t = toneIt->second;
            rt->chain.setTone(t.bassDb, t.midDb, t.trebleDb, t.lowCut, t.highCut, /*snap*/ true);
        }
    }

    /** Detach a clip transport from its runtime. `clipTransport` MUST
     *  be the same pointer originally passed to `attachClip`.
     *  Destroys the runtime if this was its last clip. */
    void detachClip(const juce::String& clipId,
                    juce::AudioSource* clipTransport)
    {
        if (clipTransport == nullptr || clipId.isEmpty()) return;
        const juce::ScopedLock sl(lock);
        auto it = clipToTrack.find(clipId);
        if (it == clipToTrack.end() || it->second == nullptr) return;
        auto* rt = it->second;
        rt->innerMixer.removeInputSource(clipTransport);
        if (--rt->clipCount <= 0)
        {
            rt->releaseResources();
            runtimes.erase(rt->trackId);
        }
        clipToTrack.erase(it);
    }

    /** Drain `trackId`'s post-chain peak meter into the out params.
     *  Returns false (and writes 0/0) if the track is unknown. */
    bool consumeTrackPeaks(const juce::String& trackId,
                           float& outL, float& outR) noexcept
    {
        const juce::ScopedLock sl(lock);
        auto it = runtimes.find(trackId);
        if (it == runtimes.end())
        {
            outL = 0.0F;
            outR = 0.0F;
            return false;
        }
        it->second->consumePeaks(outL, outR);
        return true;
    }

    /** Publish per-track Tone EQ targets. Stored in `pendingTone` so the
     *  parameters survive the track having no runtime yet (clip-less track,
     *  or a clip removed then re-added) and are re-applied on the next
     *  `attachClip`. If a runtime already exists the targets are forwarded
     *  to its chain immediately. Takes the same `lock` the audio thread
     *  holds in `getNextAudioBlock`, so the chain's plain target members are
     *  written race-free. `snap` collapses the smoother (load / mixdown /
     *  runtime-creation paths); live UI gestures pass `snap=false`. */
    void setTrackTone(const juce::String& trackId,
                      float bassDb, float midDb, float trebleDb, bool lowCut,
                      bool highCut, bool snap)
    {
        if (trackId.isEmpty()) return;
        const juce::ScopedLock sl(lock);
        pendingTone[trackId] = {bassDb, midDb, trebleDb, lowCut, highCut};
        auto it = runtimes.find(trackId);
        if (it != runtimes.end())
            it->second->chain.setTone(bassDb, midDb, trebleDb, lowCut, highCut, snap);
    }

    /** Lightweight per-track peak snapshot used by the bridge
     *  broadcaster — copying out into a vector lets the caller
     *  release the BusGraph lock before iterating to build the
     *  envelope payload (which involves DynamicObject allocations). */
    struct TrackPeakSnapshot
    {
        juce::String trackId;
        float peakL;
        float peakR;
    };

    /** Drain every active runtime's post-chain peaks into `out`,
     *  resetting each lane atomically. `out` is `clear()`-then-
     *  populated so the caller can reuse a single vector across
     *  broadcaster ticks and skip per-tick allocation in steady
     *  state once capacity stabilises. */
    void drainAllTrackPeaks(std::vector<TrackPeakSnapshot>& out)
    {
        out.clear();
        const juce::ScopedLock sl(lock);
        out.reserve(runtimes.size());
        for (auto& kv : runtimes)
        {
            float l = 0.0F;
            float r = 0.0F;
            kv.second->consumePeaks(l, r);
            out.push_back({kv.first, l, r});
        }
    }

    /** Shutdown teardown — releases every runtime and clears the
     *  registry. Caller MUST guarantee no audio thread can call
     *  `getNextAudioBlock` after this returns. */
    void clear()
    {
        const juce::ScopedLock sl(lock);
        for (auto& kv : runtimes)
            kv.second->releaseResources();
        runtimes.clear();
        clipToTrack.clear();
        pendingTone.clear();
    }

private:
    juce::CriticalSection lock;
    std::unordered_map<juce::String, std::unique_ptr<TrackRuntime>> runtimes;
    std::unordered_map<juce::String, TrackRuntime*> clipToTrack;

    // Sticky per-track Tone targets, keyed by trackId. Updated on every
    // setTrackTone and re-applied to a runtime on creation in attachClip,
    // so EQ persists across the runtime's lazy create/destroy lifecycle.
    struct ToneParams
    {
        float bassDb = 0.0F;
        float midDb = 0.0F;
        float trebleDb = 0.0F;
        bool lowCut = false;
        bool highCut = false;
    };
    std::unordered_map<juce::String, ToneParams> pendingTone;

    juce::AudioBuffer<float> scratch;
    int preparedMax = 0;
    double preparedRate = 0.0;
};

} // namespace silverdaw
