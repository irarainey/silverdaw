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
        warpScratch.setSize(kMaxWarpChannels, juce::jmax(64, blockSize),
                            /*keepExistingContent*/ false,
                            /*clearExtraSpace*/ true,
                            /*avoidReallocating*/ false);
        reverseScratch.setSize(kMaxWarpChannels, juce::jmax(64, blockSize),
                               /*keepExistingContent*/ false,
                               /*clearExtraSpace*/ true,
                               /*avoidReallocating*/ false);
        // Brake reads a contiguous source span ≤ the sub-chunk it renders (rate ≤ 1).
        // Sized generously so large read-ahead requests render in few sub-chunks;
        // `renderBrakeBlock` still chunks to this capacity, so correctness never
        // depends on the request size.
        brakeScratch.setSize(kMaxWarpChannels, juce::jmax(8192, blockSize) + 16,
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
            if (w != nullptr)
            {
                // Only reseek warp on discontinuities; steady-state playback lets the stretcher
                // keep history.
                const bool forceReseek = warpReseekRequested.exchange(false, std::memory_order_acq_rel);
                if (forceReseek || lastBlockEnded || audibleStart != lastAudibleEnd)
                {
                    const double ratio = w->getTempoRatio();
                    const juce::int64 warpedSourcePos =
                        inSrc + static_cast<juce::int64>(static_cast<double>(audibleStart - clipStart) * ratio);
                    w->seekSource(warpedSourcePos);
                }
                pullThroughWarp(*w, *audible.buffer, audible.startSample, audibleSamples,
                                rev, inSrc, sourceDur);
                lastBlockEnded = false;
                lastAudibleEnd = audibleEnd;
            }
            else
            {
                const BackspinSnapshot* backspin = backspinSnap.load(std::memory_order_acquire);
                const BrakeSnapshot* brake = brakeSnap.load(std::memory_order_acquire);
                // v1: tail effects apply to forward, non-warped clips only (warp is
                // already excluded here; reverse is excluded explicitly). Backspin and
                // brake are mutually exclusive; backspin wins if both are set.
                const bool backspinActive = backspin != nullptr && !backspin->isEmpty() && !rev;
                const bool brakeActive = !backspinActive && brake != nullptr && !brake->isEmpty() && !rev;
                float* planes[kMaxWarpChannels] = {nullptr};
                const int numCh = juce::jmin(audible.buffer->getNumChannels(), kMaxWarpChannels);
                for (int c = 0; c < numCh; ++c)
                {
                    planes[c] = audible.buffer->getWritePointer(c, audible.startSample);
                }

                if (!backspinActive && !brakeActive)
                {
                    const juce::int64 sourcePos = (audibleStart - clipStart) + inSrc;
                    readChildReversibleBlock(planes, numCh, sourcePos, audibleSamples, rev, inSrc, sourceDur);
                }
                else
                {
                    // The tail effect occupies the last `effLen` of the clip's
                    // (non-warped) timeline footprint; split this block into the
                    // normal (forward) part and the effected part.
                    const juce::int64 effLen = backspinActive
                        ? juce::jmin(backspin->getBackspinLenSamples(), dur)
                        : juce::jmin(brake->getBrakeLenSamples(), dur);
                    const juce::int64 tailStart = clipEnd - effLen;
                    const juce::int64 normalEnd = juce::jmin(audibleEnd, tailStart);
                    const int normalCount =
                        static_cast<int>(juce::jmax(static_cast<juce::int64>(0), normalEnd - audibleStart));
                    if (normalCount > 0)
                    {
                        const juce::int64 sourcePos = (audibleStart - clipStart) + inSrc;
                        readChildReversibleBlock(planes, numCh, sourcePos, normalCount, rev, inSrc, sourceDur);
                    }
                    const juce::int64 tailAudibleStart = juce::jmax(audibleStart, tailStart);
                    const int tailCount = static_cast<int>(audibleEnd - tailAudibleStart);
                    if (tailCount > 0)
                    {
                        if (backspinActive)
                        {
                            renderBackspinBlock(planes, numCh, normalCount, *backspin,
                                                static_cast<double>(effLen), tailStart, tailAudibleStart,
                                                tailCount, clipStart, inSrc, sourceDur);
                        }
                        else
                        {
                            renderBrakeBlock(planes, numCh, normalCount, *brake,
                                             static_cast<double>(effLen), tailStart, tailAudibleStart,
                                             tailCount, clipStart, inSrc, sourceDur);
                        }
                    }
                }
                lastBlockEnded = false;
                lastAudibleEnd = audibleEnd;
            }

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
            if (s1 == s2) return w;
        }
        w.offsetSamples = offsetSamples.load(std::memory_order_relaxed);
        w.inSourceSamples = inSourceSamples.load(std::memory_order_relaxed);
        w.clipDurationSamples = clipDurationSamples.load(std::memory_order_relaxed);
        return w;
    }

    // Preallocated warp scratch keeps the audio callback bounded and handles source/output
    // channel mismatches.
    static constexpr int kMaxWarpChannels = 8;

    juce::AudioBuffer<float> warpScratch;
    // Holds the mirrored forward read before it is reversed into the caller's planes.
    juce::AudioBuffer<float> reverseScratch;
    // Holds the contiguous forward source span the brake resamples from.
    juce::AudioBuffer<float> brakeScratch;

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
                          juce::int64 clipStart, juce::int64 inSrc, juce::int64 sourceDur)
    {
        if (child == nullptr || count <= 0 || numCh <= 0) return;

        // Absolute source position where the brake begins (= linear playback pos there).
        const juce::int64 baseSrc = inSrc + (brakeStart - clipStart);
        const int scratchCap = brakeScratch.getNumSamples();
        // A sub-chunk of M output samples consumes ≤ M source samples (rate ≤ 1); the
        // span adds ≤ 2 interpolation neighbours, so M ≤ cap-3 always fits the scratch.
        const int maxChunk = juce::jmax(1, scratchCap - 8);
        const int scratchPlanes = juce::jmin(numCh, kMaxWarpChannels);

        for (int done = 0; done < count;)
        {
            const int n = juce::jmin(maxChunk, count - done);
            const double uStart = static_cast<double>(brakeAudibleStart - brakeStart) + done;
            const double uEnd = uStart + static_cast<double>(n - 1);
            const double sStart = brake.sourceConsumedAt(uStart, effLen);
            const double sEnd = brake.sourceConsumedAt(uEnd, effLen);

            // Contiguous forward span with one guard sample either side for the
            // 4-point cubic (Catmull-Rom) interpolation.
            const juce::int64 spanStart = static_cast<juce::int64>(std::floor(sStart)) - 1;
            const juce::int64 spanEndExclusive = static_cast<juce::int64>(std::ceil(sEnd)) + 3;
            int spanLen = static_cast<int>(spanEndExclusive - spanStart);
            spanLen = juce::jlimit(1, scratchCap, spanLen);

            brakeScratch.clear(0, spanLen);
            {
                float* sp[kMaxWarpChannels] = {nullptr};
                for (int c = 0; c < scratchPlanes; ++c) sp[c] = brakeScratch.getWritePointer(c);
                // Forward read, windowed to the clip's source range (rev=false in v1).
                readChildReversibleBlock(sp, scratchPlanes, baseSrc + spanStart, spanLen,
                                         /*rev*/ false, inSrc, sourceDur);
            }

            for (int i = 0; i < n; ++i)
            {
                const double u = uStart + static_cast<double>(i);
                const double local = brake.sourceConsumedAt(u, effLen) - static_cast<double>(spanStart);
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
                    const float* s = brakeScratch.getReadPointer(juce::jmin(c, scratchPlanes - 1));
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
    // clips only (v1). Reuses `brakeScratch` (brake/backspin are mutually exclusive).
    void renderBackspinBlock(float* const* dst, int numCh, int dstOffset,
                             const BackspinSnapshot& spin, double effLen,
                             juce::int64 tailStart, juce::int64 tailAudibleStart, int count,
                             juce::int64 clipStart, juce::int64 inSrc, juce::int64 sourceDur)
    {
        if (child == nullptr || count <= 0 || numCh <= 0) return;

        // Forward source position at the spin trigger; the read rewinds backward from here.
        const double s0 = static_cast<double>(inSrc + (tailStart - clipStart));
        const double minSrc = static_cast<double>(inSrc); // never rewind before the clip start
        const int scratchCap = brakeScratch.getNumSamples();
        const double spinSpeed = spin.getSpinSpeed();
        // The contiguous span grows with the spin speed (|rate| up to spinSpeed), so
        // size each sub-chunk so the read still fits the scratch buffer.
        const int maxChunk =
            juce::jmax(1, static_cast<int>((scratchCap - 8) / juce::jmax(1.0, spinSpeed)));
        const int scratchPlanes = juce::jmin(numCh, kMaxWarpChannels);

        for (int done = 0; done < count;)
        {
            const int n = juce::jmin(maxChunk, count - done);
            const double uStart = static_cast<double>(tailAudibleStart - tailStart) + done;
            const double uEnd = uStart + static_cast<double>(n - 1);
            // Source positions DECREASE with u (rewind): uStart is the latest (highest).
            const double posHi = juce::jmax(minSrc, s0 - spin.sourceRewoundAt(uStart, effLen));
            const double posLo = juce::jmax(minSrc, s0 - spin.sourceRewoundAt(uEnd, effLen));

            const juce::int64 spanStart =
                juce::jmax(static_cast<juce::int64>(0), static_cast<juce::int64>(std::floor(posLo)) - 1);
            const juce::int64 spanEndExclusive = static_cast<juce::int64>(std::ceil(posHi)) + 3;
            int spanLen = static_cast<int>(spanEndExclusive - spanStart);
            spanLen = juce::jlimit(1, scratchCap, spanLen);

            brakeScratch.clear(0, spanLen);
            {
                float* sp[kMaxWarpChannels] = {nullptr};
                for (int c = 0; c < scratchPlanes; ++c) sp[c] = brakeScratch.getWritePointer(c);
                readChildReversibleBlock(sp, scratchPlanes, spanStart, spanLen,
                                         /*rev*/ false, inSrc, sourceDur);
            }

            for (int i = 0; i < n; ++i)
            {
                const double u = uStart + static_cast<double>(i);
                const double srcPos = juce::jmax(minSrc, s0 - spin.sourceRewoundAt(u, effLen));
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
                    const float* s = brakeScratch.getReadPointer(juce::jmin(c, scratchPlanes - 1));
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
            child->setNextReadPosition(srcPos);
            juce::AudioBuffer<float> bufView(const_cast<float**>(dst), numCh, n);
            juce::AudioSourceChannelInfo info(&bufView, 0, n);
            child->getNextAudioBlock(info);
            return;
        }

        if (reverseScratch.getNumChannels() < numCh || reverseScratch.getNumSamples() < n)
        {
            reverseScratch.setSize(juce::jmax(reverseScratch.getNumChannels(), numCh),
                                   juce::jmax(reverseScratch.getNumSamples(), n),
                                   /*keepExistingContent*/ false,
                                   /*clearExtraSpace*/ false,
                                   /*avoidReallocating*/ false);
        }
        reverseScratch.clear(0, n);

        const juce::int64 localStart = srcPos - inSrc;
        const juce::int64 mirroredLocalStart = sourceDur - localStart - n;
        const juce::int64 validStart = juce::jmax(static_cast<juce::int64>(0), mirroredLocalStart);
        const juce::int64 validEnd = juce::jmin(mirroredLocalStart + n, sourceDur);
        const int validCount = static_cast<int>(validEnd - validStart);
        const int scratchPlanes = juce::jmin(numCh, kMaxWarpChannels);
        if (validCount > 0)
        {
            const int destOffset = static_cast<int>(validStart - mirroredLocalStart);
            float* sp[kMaxWarpChannels] = {nullptr};
            for (int c = 0; c < scratchPlanes; ++c)
            {
                sp[c] = reverseScratch.getWritePointer(c) + destOffset;
            }
            child->setNextReadPosition(inSrc + validStart);
            juce::AudioBuffer<float> bufView(sp, scratchPlanes, validCount);
            juce::AudioSourceChannelInfo info(&bufView, 0, validCount);
            child->getNextAudioBlock(info);
        }

        for (int c = 0; c < numCh; ++c)
        {
            const float* s = reverseScratch.getReadPointer(juce::jmin(c, scratchPlanes - 1));
            float* d = dst[c];
            for (int i = 0, j = n - 1; i < n; ++i, --j)
            {
                d[i] = s[j];
            }
        }
    }

    void pullThroughWarp(WarpProcessor& w, juce::AudioBuffer<float>& dest, int startSample, int numSamples,
                         bool rev, juce::int64 inSrc, juce::int64 sourceDur)
    {
        if (child == nullptr || numSamples <= 0) return;

        const int sourceCh = juce::jmax(1, w.getNumChannels());
        const int destCh = juce::jmax(1, dest.getNumChannels());

        if (warpScratch.getNumChannels() < sourceCh || warpScratch.getNumSamples() < numSamples)
        {
            warpScratch.setSize(juce::jmax(warpScratch.getNumChannels(), sourceCh),
                                juce::jmax(warpScratch.getNumSamples(), numSamples),
                                /*keepExistingContent*/ false,
                                /*clearExtraSpace*/ false,
                                /*avoidReallocating*/ false);
        }
        warpScratch.clear(0, numSamples);

        float* warpOut[kMaxWarpChannels] = {nullptr};
        const int outPlanes = juce::jmin(sourceCh, kMaxWarpChannels);
        for (int c = 0; c < outPlanes; ++c)
        {
            warpOut[c] = warpScratch.getWritePointer(c);
        }

        auto readSource =
            [this, sourceCh, rev, inSrc, sourceDur](float* const* dst, juce::int64 srcPos, int n)
        {
            readChildReversibleBlock(dst, sourceCh, srcPos, n, rev, inSrc, sourceDur);
        };
        w.process(warpOut, numSamples, readSource);

        if (sourceCh == 1 && destCh > 1)
        {
            const float* src = warpScratch.getReadPointer(0);
            for (int c = 0; c < destCh; ++c)
            {
                juce::FloatVectorOperations::copy(
                    dest.getWritePointer(c, startSample), src, numSamples);
            }
        }
        else
        {
            const int common = juce::jmin(sourceCh, destCh);
            for (int c = 0; c < common; ++c)
            {
                juce::FloatVectorOperations::copy(
                    dest.getWritePointer(c, startSample),
                    warpScratch.getReadPointer(c),
                    numSamples);
            }
            for (int c = common; c < destCh; ++c)
            {
                juce::FloatVectorOperations::clear(
                    dest.getWritePointer(c, startSample), numSamples);
            }
        }
    }
};

} // namespace silverdaw
