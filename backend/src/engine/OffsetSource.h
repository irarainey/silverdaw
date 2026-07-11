#pragma once

#include "EdgeFadeSnapshot.h"
#include "EnvelopeSnapshot.h"
#include "BrakeSnapshot.h"
#include "BackspinSnapshot.h"
#include "WarpProcessor.h"

#include <atomic>
#include <cstdint>
#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

// Message-thread writes are published for bounded, lock-free audio-thread reads.
class OffsetSource : public juce::PositionableAudioSource
{
  public:
    explicit OffsetSource(juce::PositionableAudioSource* child) : child(child) {}

    void setOffsetSamples(juce::int64 samples)
    {
        const juce::int64 clamped = juce::jmax(static_cast<juce::int64>(0), samples);
        beginWindowWrite();
        offsetSamples.store(clamped, std::memory_order_relaxed);
        endWindowWrite();
    }
    juce::int64 getOffsetSamples() const
    {
        return offsetSamples.load();
    }

    void setInSourceSamples(juce::int64 samples)
    {
        const juce::int64 clamped = juce::jmax(static_cast<juce::int64>(0), samples);
        beginWindowWrite();
        inSourceSamples.store(clamped, std::memory_order_relaxed);
        endWindowWrite();
    }
    juce::int64 getInSourceSamples() const
    {
        return inSourceSamples.load();
    }

    void setClipDurationSamples(juce::int64 samples)
    {
        const juce::int64 clamped = juce::jmax(static_cast<juce::int64>(0), samples);
        beginWindowWrite();
        clipDurationSamples.store(clamped, std::memory_order_relaxed);
        endWindowWrite();
    }
    juce::int64 getClipDurationSamples() const
    {
        return clipDurationSamples.load();
    }

    void setClipWindowAtomic(juce::int64 offset, juce::int64 in, juce::int64 duration)
    {
        const juce::int64 off = juce::jmax(static_cast<juce::int64>(0), offset);
        const juce::int64 inS = juce::jmax(static_cast<juce::int64>(0), in);
        const juce::int64 dur = juce::jmax(static_cast<juce::int64>(0), duration);
        beginWindowWrite();
        offsetSamples.store(off, std::memory_order_relaxed);
        inSourceSamples.store(inS, std::memory_order_relaxed);
        clipDurationSamples.store(dur, std::memory_order_relaxed);
        endWindowWrite();
    }

    void setEnvelopeSnapshot(const EnvelopeSnapshot* snapshot) noexcept
    {
        envelope.store(snapshot, std::memory_order_release);
    }
    const EnvelopeSnapshot* getEnvelopeSnapshot() const noexcept
    {
        return envelope.load(std::memory_order_acquire);
    }

    // Non-owning audio-thread pointer; the owner retains replacements until a quiescent window.
    void setEdgeFadeSnapshot(const EdgeFadeSnapshot* snapshot) noexcept
    {
        edgeFade.store(snapshot, std::memory_order_release);
    }
    const EdgeFadeSnapshot* getEdgeFadeSnapshot() const noexcept
    {
        return edgeFade.load(std::memory_order_acquire);
    }

    // Non-owning audio-thread pointer; the owner retains replacements until quiescent.
    // The brake (turntable stop) decelerates the source read over the clip tail; v1
    // applies it only to forward, non-warped clips (see getNextAudioBlock).
    void setBrakeSnapshot(const BrakeSnapshot* snapshot) noexcept
    {
        brakeSnap.store(snapshot, std::memory_order_release);
    }
    const BrakeSnapshot* getBrakeSnapshot() const noexcept
    {
        return brakeSnap.load(std::memory_order_acquire);
    }

    // The backspin (turntable rewind) reverses the source read over the clip tail at
    // a high decaying speed; v1 applies it only to forward, non-warped clips. Brake
    // and backspin are mutually exclusive tail effects; backspin takes priority if
    // both are somehow set.
    void setBackspinSnapshot(const BackspinSnapshot* snapshot) noexcept
    {
        backspinSnap.store(snapshot, std::memory_order_release);
    }
    const BackspinSnapshot* getBackspinSnapshot() const noexcept
    {
        return backspinSnap.load(std::memory_order_acquire);
    }

    static juce::int64 timelineSamplesForSourceSamples(juce::int64 sourceSamples, WarpProcessor* w) noexcept
    {
        if (sourceSamples <= 0) return sourceSamples;
        if (w == nullptr || !w->isActive()) return sourceSamples;
        const double ratio = w->getTempoRatio();
        return WarpProcessor::timelineSamplesForSourceSamples(sourceSamples, ratio);
    }

    void setWarpProcessor(WarpProcessor* w) noexcept
    {
        warp.store(w, std::memory_order_release);
    }

    void requestWarpReseek() noexcept
    {
        warpReseekRequested.store(true, std::memory_order_release);
    }

    // Reverse plays the clip window backwards by mirroring source reads; applied upstream of
    // warp/pitch so those still operate normally on the reversed stream.
    void setReversed(bool r) noexcept
    {
        reversed.store(r, std::memory_order_release);
    }
    bool isReversed() const noexcept
    {
        return reversed.load(std::memory_order_acquire);
    }

    void prepareToPlay(int blockSize, double sampleRate) override
    {
        cachedBlockSize.store(blockSize, std::memory_order_relaxed);
        cachedSampleRate.store(sampleRate, std::memory_order_relaxed);
        const int renderScratchSamples = juce::jmax(kRenderScratchSamples, blockSize);
        warpScratch.setSize(kMaxWarpChannels, renderScratchSamples,
                            /*keepExistingContent*/ false,
                            /*clearExtraSpace*/ true,
                            /*avoidReallocating*/ false);
        reverseScratch.setSize(kMaxWarpChannels, renderScratchSamples,
                               /*keepExistingContent*/ false,
                               /*clearExtraSpace*/ true,
                               /*avoidReallocating*/ false);
        if (child != nullptr)
        {
            child->prepareToPlay(blockSize, sampleRate);
        }
        if (auto* w = warp.load(std::memory_order_acquire))
        {
            w->prepareToPlay(blockSize);
        }
    }

    void releaseResources() override
    {
        if (child != nullptr)
        {
            child->releaseResources();
        }
    }

    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override
    {
        if (child == nullptr || info.numSamples <= 0)
        {
            info.clearActiveBufferRegion();
            return;
        }

        const juce::int64 startPos = position.load(std::memory_order_relaxed);
        const juce::int64 endPos = startPos + info.numSamples;
        const ClipWindow window = readClipWindow();
        const juce::int64 clipStart = window.offsetSamples;
        auto* currentWarp = warp.load(std::memory_order_acquire);
        const juce::int64 sourceDur = window.clipDurationSamples;
        const juce::int64 dur = timelineSamplesForSourceSamples(sourceDur, currentWarp);
        const juce::int64 clipEnd =
            dur > 0 ? clipStart + dur : std::numeric_limits<juce::int64>::max();
        const juce::int64 inSrc = window.inSourceSamples;

        if (endPos <= clipStart || startPos >= clipEnd)
        {
            info.clearActiveBufferRegion();
            position.store(endPos, std::memory_order_relaxed);
            return;
        }

        const juce::int64 audibleStart = juce::jmax(startPos, clipStart);
        const juce::int64 audibleEnd = juce::jmin(endPos, clipEnd);
        const int silentLeading = static_cast<int>(audibleStart - startPos);
        const int audibleSamples = static_cast<int>(audibleEnd - audibleStart);
        const int silentTrailing = info.numSamples - silentLeading - audibleSamples;

        if (silentLeading > 0)
        {
            juce::AudioSourceChannelInfo lead = info;
            lead.numSamples = silentLeading;
            lead.clearActiveBufferRegion();
        }

        if (audibleSamples > 0)
        {
            juce::AudioSourceChannelInfo audible = info;
            audible.startSample += silentLeading;
            audible.numSamples = audibleSamples;
            auto* w = currentWarp;
            const bool rev = reversed.load(std::memory_order_acquire);

            // Tail effects (turntable brake / backspin). Mutually exclusive; backspin
            // wins if both are set. Reverse is excluded (out of scope). v1 now composes
            // with warp: the part before the effect is warped normally, then the tail is
            // read straight from the source as a varispeed (a record-stop is pitch-
            // changing, so it can't go through the pitch-preserving stretcher). The warp
            // tempo ratio only positions the tail and scales its rate for continuity.
            const BackspinSnapshot* backspin = backspinSnap.load(std::memory_order_acquire);
            const BrakeSnapshot* brake = brakeSnap.load(std::memory_order_acquire);
            const bool backspinActive = backspin != nullptr && !backspin->isEmpty() && !rev;
            const bool brakeActive = !backspinActive && brake != nullptr && !brake->isEmpty() && !rev;
            const bool tailActive = backspinActive || brakeActive;
            const double rateScale = (w != nullptr && w->isActive()) ? w->getTempoRatio() : 1.0;

            float* planes[kMaxWarpChannels] = {nullptr};
            const int numCh = juce::jmin(audible.buffer->getNumChannels(), kMaxWarpChannels);
            for (int c = 0; c < numCh; ++c)
            {
                planes[c] = audible.buffer->getWritePointer(c, audible.startSample);
            }

            // Warp `cnt` output samples (from `audibleStart`) through the stretcher,
            // reseeking only on a discontinuity so steady-state keeps its history.
            const auto warpInto = [&](int cnt) {
                if (w == nullptr || cnt <= 0) return;
                const bool forceReseek = warpReseekRequested.exchange(false, std::memory_order_acq_rel);
                if (forceReseek || lastBlockEnded || audibleStart != lastAudibleEnd)
                {
                    const double ratio = w->getTempoRatio();
                    const juce::int64 warpedSourcePos =
                        inSrc + static_cast<juce::int64>(static_cast<double>(audibleStart - clipStart) * ratio);
                    w->seekSource(warpedSourcePos);
                }
                pullThroughWarp(*w, *audible.buffer, audible.startSample, cnt, rev, inSrc, sourceDur);
            };

            if (!tailActive)
            {
                if (w != nullptr)
                {
                    warpInto(audibleSamples);
                }
                else
                {
                    const juce::int64 sourcePos = (audibleStart - clipStart) + inSrc;
                    readChildReversibleBlock(planes, numCh, sourcePos, audibleSamples, rev, inSrc, sourceDur);
                }
            }
            else
            {
                // Split this block at the effect trigger (last `effLen` of the timeline
                // footprint). The pre-tail part plays normally (warped or direct); the
                // tail part renders the varispeed straight from the source.
                const juce::int64 effLen = backspinActive
                    ? juce::jmin(backspin->getBackspinLenSamples(), dur)
                    : juce::jmin(brake->getBrakeLenSamples(), dur);
                const juce::int64 tailStart = clipEnd - effLen;
                const juce::int64 normalEnd = juce::jmin(audibleEnd, tailStart);
                const int normalCount =
                    static_cast<int>(juce::jmax(static_cast<juce::int64>(0), normalEnd - audibleStart));
                if (normalCount > 0)
                {
                    if (w != nullptr)
                    {
                        warpInto(normalCount);
                    }
                    else
                    {
                        const juce::int64 sourcePos = (audibleStart - clipStart) + inSrc;
                        readChildReversibleBlock(planes, numCh, sourcePos, normalCount, rev, inSrc, sourceDur);
                    }
                }
                const juce::int64 tailAudibleStart = juce::jmax(audibleStart, tailStart);
                const int tailCount = static_cast<int>(audibleEnd - tailAudibleStart);
                if (tailCount > 0)
                {
                    if (backspinActive)
                    {
                        renderBackspinBlock(planes, numCh, normalCount, *backspin,
                                            static_cast<double>(effLen), tailStart, tailAudibleStart,
                                            tailCount, clipStart, inSrc, sourceDur, rateScale);
                    }
                    else
                    {
                        renderBrakeBlock(planes, numCh, normalCount, *brake,
                                         static_cast<double>(effLen), tailStart, tailAudibleStart,
                                         tailCount, clipStart, inSrc, sourceDur, rateScale);
                    }
                }
            }
            lastBlockEnded = false;
            lastAudibleEnd = audibleEnd;

            applyClipGain(*audible.buffer,
                          audible.startSample, audibleSamples,
                          audibleStart, clipStart);
        }
        else
        {
            lastBlockEnded = true;
        }

        if (silentTrailing > 0)
        {
            juce::AudioSourceChannelInfo trail = info;
            trail.startSample += silentLeading + audibleSamples;
            trail.numSamples = silentTrailing;
            trail.clearActiveBufferRegion();
        }

        position.store(endPos, std::memory_order_relaxed);
        lastBlockEndPosition.store(endPos, std::memory_order_relaxed);
    }

    void setNextReadPosition(juce::int64 newPosition) override
    {
        // Rebuild stale JUCE read-ahead buffers after timeline changes so playback starts at
        // the new position.
        const juce::int64 prevExpected = lastBlockEndPosition.load(std::memory_order_relaxed);
        constexpr juce::int64 kContinuityToleranceSamples = 16384;
        const bool isDiscontinuous =
            prevExpected < 0 ||
            std::abs(newPosition - prevExpected) > kContinuityToleranceSamples;

        position.store(newPosition, std::memory_order_relaxed);
        const ClipWindow window = readClipWindow();
        const juce::int64 off = window.offsetSamples;
        const juce::int64 inSrc = window.inSourceSamples;
        if (child != nullptr)
        {
            // Silverdaw tempoRatio is project/source; Rubber Band receives the inverse
            // internally.
            juce::int64 childPos = inSrc;
            if (newPosition >= off)
            {
                if (auto* w = warp.load(std::memory_order_acquire); w != nullptr && w->isActive())
                {
                    childPos = inSrc + static_cast<juce::int64>(
                        static_cast<double>(newPosition - off) * w->getTempoRatio());
                }
                else
                {
                    childPos = (newPosition - off) + inSrc;
                }
            }
            child->setNextReadPosition(childPos);
        }
        if (isDiscontinuous)
        {
            lastBlockEnded = true;
            if (auto* w = warp.load(std::memory_order_acquire))
            {
                w->requestReset();
            }
        }
    }

    juce::int64 getNextReadPosition() const override
    {
        return position.load(std::memory_order_relaxed);
    }

    juce::int64 getTotalLength() const override
    {
        return child != nullptr ? child->getTotalLength() + offsetSamples.load() : offsetSamples.load();
    }

    bool isLooping() const override
    {
        return false;
    }

  private:
    void applyClipGain(juce::AudioBuffer<float>& buffer,
                       int startSample, int count,
                       juce::int64 audibleStart, juce::int64 clipStart) noexcept
    {
        if (count <= 0) return;
        const EnvelopeSnapshot* env = envelope.load(std::memory_order_acquire);
        const EdgeFadeSnapshot* fade = edgeFade.load(std::memory_order_acquire);
        const bool haveFade = fade != nullptr && !fade->isEmpty();
        const double sr = cachedSampleRate.load(std::memory_order_relaxed);
        const bool haveEnv = env != nullptr && !env->isEmpty() && sr > 0.0;
        if (!haveEnv && !haveFade) return;

        const double msPerSample = sr > 0.0 ? 1000.0 / sr : 0.0;
        const int numCh = buffer.getNumChannels();
        std::size_t seg = 0;
        for (int i = 0; i < count; ++i)
        {
            const juce::int64 timelineSample = audibleStart + i;
            float gain = 1.0F;
            if (haveEnv)
            {
                const double ms = static_cast<double>(timelineSample - clipStart) * msPerSample;
                gain *= env->gainAtMs(ms, seg);
            }
            if (haveFade)
            {
                gain *= fade->gainAtSample(timelineSample);
            }
            if (gain == 1.0F) continue;
            for (int ch = 0; ch < numCh; ++ch)
            {
                auto* data = buffer.getWritePointer(ch);
                data[startSample + i] *= gain;
            }
        }
    }

    juce::PositionableAudioSource* child = nullptr;
    std::atomic<juce::int64> position{0};
    std::atomic<juce::int64> offsetSamples{0};
    std::atomic<juce::int64> inSourceSamples{0};
    std::atomic<juce::int64> clipDurationSamples{0};
    std::atomic<const EnvelopeSnapshot*> envelope{nullptr};
    std::atomic<const EdgeFadeSnapshot*> edgeFade{nullptr};
    std::atomic<const BrakeSnapshot*> brakeSnap{nullptr};
    std::atomic<const BackspinSnapshot*> backspinSnap{nullptr};
    std::atomic<WarpProcessor*> warp{nullptr};
    std::atomic<bool> warpReseekRequested{false};
    std::atomic<bool> reversed{false};
    juce::int64 lastAudibleEnd{std::numeric_limits<juce::int64>::min()};
    std::atomic<juce::int64> lastBlockEndPosition{-1};
    bool lastBlockEnded{true};
    std::atomic<int> cachedBlockSize{0};
    std::atomic<double> cachedSampleRate{0.0};

    struct ClipWindow
    {
        juce::int64 offsetSamples;
        juce::int64 inSourceSamples;
        juce::int64 clipDurationSamples;
    };

    // Seqlock keeps multi-field clip-window reads consistent without locking the audio thread.
    mutable std::atomic<std::uint32_t> windowSeq{0};
    // Last CONSISTENT clip-window read, returned as a wait-free fallback when the seqlock can't get
    // a clean read within the bounded spin — so the audio path is never handed a torn multi-field
    // state. Touched only inside readClipWindow, which for a live source runs on its single owning
    // read-ahead / offline-render thread (see readClipWindow).
    mutable ClipWindow lastGoodWindow{};

    void beginWindowWrite() noexcept
    {
        windowSeq.fetch_add(1, std::memory_order_acq_rel);
    }
    void endWindowWrite() noexcept
    {
        windowSeq.fetch_add(1, std::memory_order_acq_rel);
    }

    ClipWindow readClipWindow() const noexcept
    {
        constexpr int kMaxRetries = 4;
        ClipWindow w{};
        for (int attempt = 0; attempt < kMaxRetries; ++attempt)
        {
            const auto s1 = windowSeq.load(std::memory_order_acquire);
            if ((s1 & 1u) != 0u) continue; // writer mid-update; spin briefly
            w.offsetSamples = offsetSamples.load(std::memory_order_relaxed);
            w.inSourceSamples = inSourceSamples.load(std::memory_order_relaxed);
            w.clipDurationSamples = clipDurationSamples.load(std::memory_order_relaxed);
            std::atomic_thread_fence(std::memory_order_acquire);
            const auto s2 = windowSeq.load(std::memory_order_relaxed);
            if (s1 == s2)
            {
                lastGoodWindow = w; // cache the last CONSISTENT snapshot (single reader thread)
                return w;
            }
        }
        // The writer held the seqlock open for the whole bounded spin — e.g. the message thread was
        // preempted between the field stores. Return the last consistent window rather than falling
        // through to torn relaxed reads (which could pair a new offset with an old duration and
        // glitch the block). It is at worst one update stale — imperceptible and self-correcting on
        // the next block — but never inconsistent. Spinning longer to wait out the writer is avoided
        // deliberately: this runs on the (high-priority) audio read-ahead thread, and busy-waiting
        // on a preempted lower-priority writer risks priority inversion.
        return lastGoodWindow;
    }

    // Fixed scratch capacity keeps oversized read-ahead requests allocation-free; reverse,
    // warp, brake, and backspin render in bounded chunks through these buffers.
    static constexpr int kMaxWarpChannels = 8;
    static constexpr int kRenderScratchSamples = 1024;

    juce::AudioBuffer<float> warpScratch;
    // Holds the mirrored forward read before it is reversed into the caller's planes.
    juce::AudioBuffer<float> reverseScratch;
    // Renders `count` decelerating ("turntable brake") output samples into dst[*]
    // starting at dstOffset. The source distance consumed since the brake start is
    // the analytic, STATELESS curve `BrakeSnapshot::sourceConsumedAt(u)`, so live
    // and offline render identically regardless of block size and seeks can't
    // desync it. Forward, non-warped clips only (v1).
    //
    // The output is processed in sub-chunks no larger than the scratch buffer: the
    // read-ahead thread can request blocks far bigger than `blockSize`, and each
    // sub-chunk reads its own contiguous forward source span (rate ≤ 1, so the span
    // is ≤ the sub-chunk + a couple of interpolation neighbours) and linearly
    // interpolates. A short click-guard gain ramps the final samples to silence.
    void renderBrakeBlock(float* const* dst, int numCh, int dstOffset,
                          const BrakeSnapshot& brake, double effLen,
                          juce::int64 brakeStart, juce::int64 brakeAudibleStart, int count,
                          juce::int64 clipStart, juce::int64 inSrc, juce::int64 sourceDur,
                          double sourceRateScale = 1.0)
    {
        if (child == nullptr || count <= 0 || numCh <= 0) return;

        // Absolute source position where the brake begins. For a warped clip the warp
        // read source at `sourceRateScale` (tempo ratio) per timeline sample, so the
        // trigger position and the decelerating read scale by it (the brake decelerates
        // from the warped rate to 0 — continuous at the trigger, pitch no longer
        // preserved as a real record-stop is a varispeed). 1.0 for non-warped clips.
        const juce::int64 baseSrc =
            inSrc + static_cast<juce::int64>(static_cast<double>(brakeStart - clipStart) * sourceRateScale);
        const int scratchCap = warpScratch.getNumSamples();
        // The span grows with the read rate (≤ sourceRateScale), so size each sub-chunk
        // so the contiguous read still fits the scratch buffer.
        const int maxChunk =
            juce::jmax(1, static_cast<int>((scratchCap - 8) / juce::jmax(1.0, sourceRateScale)));
        const int scratchPlanes = juce::jmin(numCh, kMaxWarpChannels);

        for (int done = 0; done < count;)
        {
            const int n = juce::jmin(maxChunk, count - done);
            const double uStart = static_cast<double>(brakeAudibleStart - brakeStart) + done;
            const double uEnd = uStart + static_cast<double>(n - 1);
            const double sStart = sourceRateScale * brake.sourceConsumedAt(uStart, effLen);
            const double sEnd = sourceRateScale * brake.sourceConsumedAt(uEnd, effLen);

            // Contiguous forward span with one guard sample either side for the
            // 4-point cubic (Catmull-Rom) interpolation.
            const juce::int64 spanStart = static_cast<juce::int64>(std::floor(sStart)) - 1;
            const juce::int64 spanEndExclusive = static_cast<juce::int64>(std::ceil(sEnd)) + 3;
            int spanLen = static_cast<int>(spanEndExclusive - spanStart);
            spanLen = juce::jlimit(1, scratchCap, spanLen);

            warpScratch.clear(0, spanLen);
            {
                float* sp[kMaxWarpChannels] = {nullptr};
                for (int c = 0; c < scratchPlanes; ++c) sp[c] = warpScratch.getWritePointer(c);
                // Forward read, windowed to the clip's source range (rev=false in v1).
                readChildReversibleBlock(sp, scratchPlanes, baseSrc + spanStart, spanLen,
                                         /*rev*/ false, inSrc, sourceDur);
            }

            for (int i = 0; i < n; ++i)
            {
                const double u = uStart + static_cast<double>(i);
                const double local =
                    sourceRateScale * brake.sourceConsumedAt(u, effLen) - static_cast<double>(spanStart);
                const int i1 = static_cast<int>(std::floor(local));
                const float frac = static_cast<float>(local - static_cast<double>(i1));
                // Cubic needs idx-1 .. idx+2; clamp each to the span (edges only).
                const int k0 = juce::jlimit(0, spanLen - 1, i1 - 1);
                const int k1 = juce::jlimit(0, spanLen - 1, i1);
                const int k2 = juce::jlimit(0, spanLen - 1, i1 + 1);
                const int k3 = juce::jlimit(0, spanLen - 1, i1 + 2);
                const float g = brake.gainAt(u, effLen);
                for (int c = 0; c < numCh; ++c)
                {
                    const float* s = warpScratch.getReadPointer(juce::jmin(c, scratchPlanes - 1));
                    const float p0 = s[k0], p1 = s[k1], p2 = s[k2], p3 = s[k3];
                    // Catmull-Rom: exact for linear data, smooth for audio (low grain).
                    const float out =
                        p1 + 0.5F * frac *
                                 ((p2 - p0) +
                                  frac * ((2.0F * p0 - 5.0F * p1 + 4.0F * p2 - p3) +
                                          frac * (3.0F * (p1 - p2) + p3 - p0)));
                    dst[c][dstOffset + done + i] = out * g;
                }
            }
            done += n;
        }
    }

    // Renders `count` reverse-rewind ("turntable backspin") output samples into
    // dst[*] starting at dstOffset. The source position rewinds BACKWARD from the
    // trigger `s0` by the analytic, STATELESS curve `BackspinSnapshot::sourceRewoundAt(u)`,
    // so live and offline render identically regardless of block size. Reads a
    // contiguous forward source span per sub-chunk and 4-point cubic-interpolates;
    // a rate-keyed fade silences the tail as the spin stops. Forward, non-warped
    // clips only (v1). Reuses `warpScratch` because warp and tail rendering are sequential.
    void renderBackspinBlock(float* const* dst, int numCh, int dstOffset,
                             const BackspinSnapshot& spin, double effLen,
                             juce::int64 tailStart, juce::int64 tailAudibleStart, int count,
                             juce::int64 clipStart, juce::int64 inSrc, juce::int64 sourceDur,
                             double sourceRateScale = 1.0)
    {
        if (child == nullptr || count <= 0 || numCh <= 0) return;

        // Forward source position at the spin trigger. For a warped clip the warp read
        // source at `sourceRateScale` (tempo ratio) per timeline sample, so the trigger
        // position and the rewind distance scale by it (the spin reverses relative to the
        // warped playback). 1.0 for non-warped clips.
        const double s0 =
            static_cast<double>(inSrc) + static_cast<double>(tailStart - clipStart) * sourceRateScale;
        const double minSrc = static_cast<double>(inSrc); // never rewind before the clip start
        const int scratchCap = warpScratch.getNumSamples();
        const double spinSpeed = spin.getSpinSpeed();
        // Cap the rewind to the source available before the clip start. Without this the
        // spin (which rewinds spinSpeed*T/(p+1) of source) slams into the clip start and
        // FREEZES for the rest of the region on any clip shorter than ~3x the spin length,
        // so a long backspin sounds short. Instead, scale the rewind uniformly so it spans
        // the FULL duration — a gentler rewind that still ends right at the clip start.
        const double available = juce::jmax(0.0, s0 - minSrc);
        const double requestedTotal = sourceRateScale * spin.totalRewound(effLen);
        const double rewindScale =
            (requestedTotal > available && requestedTotal > 0.0) ? (available / requestedTotal) : 1.0;
        // Effective multiplier applied to the analytic rewind distance (fit x warp ratio).
        const double rewMul = rewindScale * sourceRateScale;
        // The contiguous span grows with the (scaled) spin speed, so size each sub-chunk
        // so the read still fits the scratch buffer.
        const int maxChunk =
            juce::jmax(1, static_cast<int>((scratchCap - 8) / juce::jmax(1.0, spinSpeed * rewMul)));
        const int scratchPlanes = juce::jmin(numCh, kMaxWarpChannels);

        for (int done = 0; done < count;)
        {
            const int n = juce::jmin(maxChunk, count - done);
            const double uStart = static_cast<double>(tailAudibleStart - tailStart) + done;
            const double uEnd = uStart + static_cast<double>(n - 1);
            // Source positions DECREASE with u (rewind): uStart is the latest (highest).
            const double posHi = juce::jmax(minSrc, s0 - rewMul * spin.sourceRewoundAt(uStart, effLen));
            const double posLo = juce::jmax(minSrc, s0 - rewMul * spin.sourceRewoundAt(uEnd, effLen));

            const juce::int64 spanStart =
                juce::jmax(inSrc, static_cast<juce::int64>(std::floor(posLo)) - 1);
            const juce::int64 spanEndExclusive = static_cast<juce::int64>(std::ceil(posHi)) + 3;
            int spanLen = static_cast<int>(spanEndExclusive - spanStart);
            spanLen = juce::jlimit(1, scratchCap, spanLen);

            warpScratch.clear(0, spanLen);
            {
                float* sp[kMaxWarpChannels] = {nullptr};
                for (int c = 0; c < scratchPlanes; ++c) sp[c] = warpScratch.getWritePointer(c);
                readChildReversibleBlock(sp, scratchPlanes, spanStart, spanLen,
                                         /*rev*/ false, inSrc, sourceDur);
            }

            for (int i = 0; i < n; ++i)
            {
                const double u = uStart + static_cast<double>(i);
                const double srcPos = juce::jmax(minSrc, s0 - rewMul * spin.sourceRewoundAt(u, effLen));
                const double local = srcPos - static_cast<double>(spanStart);
                const int i1 = static_cast<int>(std::floor(local));
                const float frac = static_cast<float>(local - static_cast<double>(i1));
                const int k0 = juce::jlimit(0, spanLen - 1, i1 - 1);
                const int k1 = juce::jlimit(0, spanLen - 1, i1);
                const int k2 = juce::jlimit(0, spanLen - 1, i1 + 1);
                const int k3 = juce::jlimit(0, spanLen - 1, i1 + 2);
                const float g = spin.gainAt(u, effLen);
                for (int c = 0; c < numCh; ++c)
                {
                    const float* s = warpScratch.getReadPointer(juce::jmin(c, scratchPlanes - 1));
                    const float p0 = s[k0], p1 = s[k1], p2 = s[k2], p3 = s[k3];
                    const float out =
                        p1 + 0.5F * frac *
                                 ((p2 - p0) +
                                  frac * ((2.0F * p0 - 5.0F * p1 + 4.0F * p2 - p3) +
                                          frac * (3.0F * (p1 - p2) + p3 - p0)));
                    dst[c][dstOffset + done + i] = out * g;
                }
            }
            done += n;
        }
    }

    // Reads `n` source samples for forward clip-source position `srcPos` into `dst`. When
    // `rev` is set the clip window `[inSrc, inSrc + sourceDur)` is mirrored so the audio plays
    // backwards; samples outside the window are silenced rather than leaking neighbouring audio.
    void readChildReversibleBlock(float* const* dst, int numCh, juce::int64 srcPos, int n,
                                  bool rev, juce::int64 inSrc, juce::int64 sourceDur)
    {
        if (child == nullptr || n <= 0 || numCh <= 0) return;

        if (!rev)
        {
            if (sourceDur <= 0)
            {
                child->setNextReadPosition(srcPos);
                juce::AudioBuffer<float> bufView(dst, numCh, n);
                juce::AudioSourceChannelInfo info(&bufView, 0, n);
                child->getNextAudioBlock(info);
                return;
            }

            for (int c = 0; c < numCh; ++c)
                juce::FloatVectorOperations::clear(dst[c], n);

            const juce::int64 localStart = srcPos - inSrc;
            const juce::int64 validStart =
                juce::jmax(static_cast<juce::int64>(0), localStart);
            const juce::int64 validEnd = juce::jmin(localStart + n, sourceDur);
            const int validCount =
                static_cast<int>(juce::jmax(static_cast<juce::int64>(0),
                                            validEnd - validStart));
            if (validCount > 0)
            {
                const int destOffset = static_cast<int>(validStart - localStart);
                float* validDest[kMaxWarpChannels] = {nullptr};
                const int planes = juce::jmin(numCh, kMaxWarpChannels);
                for (int c = 0; c < planes; ++c)
                    validDest[c] = dst[c] + destOffset;
                child->setNextReadPosition(inSrc + validStart);
                juce::AudioBuffer<float> bufView(validDest, planes, validCount);
                juce::AudioSourceChannelInfo info(&bufView, 0, validCount);
                child->getNextAudioBlock(info);
            }
            return;
        }

        const int scratchPlanes = juce::jmin(numCh, kMaxWarpChannels);
        const int scratchCapacity = reverseScratch.getNumSamples();
        if (scratchPlanes <= 0 || scratchCapacity <= 0) return;

        int done = 0;
        while (done < n)
        {
            const int chunk = juce::jmin(n - done, scratchCapacity);
            reverseScratch.clear(0, chunk);

            const juce::int64 localStart = srcPos + done - inSrc;
            const juce::int64 mirroredLocalStart = sourceDur - localStart - chunk;
            const juce::int64 validStart =
                juce::jmax(static_cast<juce::int64>(0), mirroredLocalStart);
            const juce::int64 validEnd =
                juce::jmin(mirroredLocalStart + chunk, sourceDur);
            const int validCount =
                static_cast<int>(juce::jmax(static_cast<juce::int64>(0),
                                            validEnd - validStart));
            if (validCount > 0)
            {
                const int destOffset = static_cast<int>(validStart - mirroredLocalStart);
                float* sp[kMaxWarpChannels] = {nullptr};
                for (int c = 0; c < scratchPlanes; ++c)
                    sp[c] = reverseScratch.getWritePointer(c) + destOffset;
                child->setNextReadPosition(inSrc + validStart);
                juce::AudioBuffer<float> bufView(sp, scratchPlanes, validCount);
                juce::AudioSourceChannelInfo info(&bufView, 0, validCount);
                child->getNextAudioBlock(info);
            }

            for (int c = 0; c < numCh; ++c)
            {
                const float* s =
                    reverseScratch.getReadPointer(juce::jmin(c, scratchPlanes - 1));
                float* d = dst[c] + done;
                for (int i = 0, j = chunk - 1; i < chunk; ++i, --j)
                    d[i] = s[j];
            }
            done += chunk;
        }
    }

    void pullThroughWarp(WarpProcessor& w, juce::AudioBuffer<float>& dest, int startSample, int numSamples,
                         bool rev, juce::int64 inSrc, juce::int64 sourceDur)
    {
        if (child == nullptr || numSamples <= 0) return;

        const int sourceCh = juce::jmax(1, w.getNumChannels());
        const int destCh = juce::jmax(1, dest.getNumChannels());

        const int outPlanes = juce::jmin(sourceCh, kMaxWarpChannels);
        const int scratchCapacity = warpScratch.getNumSamples();
        if (outPlanes <= 0 || scratchCapacity <= 0) return;

        auto readSource =
            [this, sourceCh, rev, inSrc, sourceDur](float* const* dst, juce::int64 srcPos, int n)
        {
            readChildReversibleBlock(dst, sourceCh, srcPos, n, rev, inSrc, sourceDur);
        };

        int done = 0;
        while (done < numSamples)
        {
            const int chunk = juce::jmin(numSamples - done, scratchCapacity);
            warpScratch.clear(0, chunk);

            float* warpOut[kMaxWarpChannels] = {nullptr};
            for (int c = 0; c < outPlanes; ++c)
                warpOut[c] = warpScratch.getWritePointer(c);
            w.process(warpOut, chunk, readSource);

            if (sourceCh == 1 && destCh > 1)
            {
                const float* src = warpScratch.getReadPointer(0);
                for (int c = 0; c < destCh; ++c)
                    juce::FloatVectorOperations::copy(
                        dest.getWritePointer(c, startSample + done), src, chunk);
            }
            else
            {
                const int common = juce::jmin(sourceCh, destCh);
                for (int c = 0; c < common; ++c)
                    juce::FloatVectorOperations::copy(
                        dest.getWritePointer(c, startSample + done),
                        warpScratch.getReadPointer(c),
                        chunk);
                for (int c = common; c < destCh; ++c)
                    juce::FloatVectorOperations::clear(
                        dest.getWritePointer(c, startSample + done), chunk);
            }
            done += chunk;
        }
    }
};

} // namespace silverdaw
