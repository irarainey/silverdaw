#pragma once

#include "EdgeFadeSnapshot.h"
#include "EnvelopeSnapshot.h"
#include "BrakeSnapshot.h"
#include "BackspinSnapshot.h"
#include "WarpProcessor.h"

#include <atomic>
#include <cstdint>
#include <limits>
#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw::scratch
{
struct PatternReplaySnapshot;
} // namespace silverdaw::scratch

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

    // Non-owning audio-thread pointer to an immutable pattern replay snapshot.
    // When set, the clip applies the scratch trajectory after warp/static-pitch
    // and before gain/fades/effects. Null = no pattern applied.
    void setPatternSnapshot(const scratch::PatternReplaySnapshot* snapshot) noexcept
    {
        patternSnap.store(snapshot, std::memory_order_release);
    }
    const scratch::PatternReplaySnapshot* getPatternSnapshot() const noexcept
    {
        return patternSnap.load(std::memory_order_acquire);
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

    void prepareToPlay(int blockSize, double sampleRate) override;
    void releaseResources() override;

    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override;

    void setNextReadPosition(juce::int64 newPosition) override;

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
                       juce::int64 audibleStart, juce::int64 clipStart) noexcept;

    juce::PositionableAudioSource* child = nullptr;
    std::atomic<juce::int64> position{0};
    std::atomic<juce::int64> offsetSamples{0};
    std::atomic<juce::int64> inSourceSamples{0};
    std::atomic<juce::int64> clipDurationSamples{0};
    std::atomic<const EnvelopeSnapshot*> envelope{nullptr};
    std::atomic<const EdgeFadeSnapshot*> edgeFade{nullptr};
    std::atomic<const BrakeSnapshot*> brakeSnap{nullptr};
    std::atomic<const BackspinSnapshot*> backspinSnap{nullptr};
    std::atomic<const scratch::PatternReplaySnapshot*> patternSnap{nullptr};
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

    ClipWindow readClipWindow() const noexcept;

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
                          double sourceRateScale = 1.0);

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
                             double sourceRateScale = 1.0);

    // Reads `n` source samples for forward clip-source position `srcPos` into `dst`. When
    // `rev` is set the clip window `[inSrc, inSrc + sourceDur)` is mirrored so the audio plays
    // backwards; samples outside the window are silenced rather than leaking neighbouring audio.
    void readChildReversibleBlock(float* const* dst, int numCh, juce::int64 srcPos, int n,
                                  bool rev, juce::int64 inSrc, juce::int64 sourceDur);

    void pullThroughWarp(WarpProcessor& w, juce::AudioBuffer<float>& dest, int startSample, int numSamples,
                         bool rev, juce::int64 inSrc, juce::int64 sourceDur);
};

} // namespace silverdaw
