#pragma once

#include "EdgeFadeSnapshot.h"
#include "EnvelopeSnapshot.h"
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

    void prepareToPlay(int blockSize, double sampleRate) override
    {
        cachedBlockSize.store(blockSize, std::memory_order_relaxed);
        cachedSampleRate.store(sampleRate, std::memory_order_relaxed);
        warpScratch.setSize(kMaxWarpChannels, juce::jmax(64, blockSize),
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
            const juce::int64 sourcePos = (audibleStart - clipStart) + inSrc;
            auto* w = currentWarp;
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
                pullThroughWarp(*w, *audible.buffer, audible.startSample, audibleSamples);
                lastBlockEnded = false;
                lastAudibleEnd = audibleEnd;
            }
            else
            {
                child->setNextReadPosition(sourcePos);
                child->getNextAudioBlock(audible);
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
    std::atomic<WarpProcessor*> warp{nullptr};
    std::atomic<bool> warpReseekRequested{false};
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

    void pullThroughWarp(WarpProcessor& w, juce::AudioBuffer<float>& dest, int startSample, int numSamples)
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
            [this, sourceCh](float* const* dst, juce::int64 srcPos, int n)
        {
            child->setNextReadPosition(srcPos);
            juce::AudioBuffer<float> bufView(const_cast<float**>(dst), sourceCh, n);
            juce::AudioSourceChannelInfo info(&bufView, 0, n);
            child->getNextAudioBlock(info);
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
