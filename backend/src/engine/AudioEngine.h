#pragma once

#include "BusGraph.h"
#include "AudioConstants.h"
#include "EdgeFadeSnapshot.h"
#include "EnvelopeSnapshot.h"
#include "Log.h"
#include "OutputKeepAlive.h"
#include "TrackChain.h"
#include "WarpProcessor.h"

#include <atomic>
#include <cstdint>
#include <functional>
#include <limits>
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <memory>
#include <optional>
#include <unordered_map>

namespace silverdaw
{

// Apply master gain before metering; inject keep-alive after gain so the endpoint floor is
// volume-independent.
class MeteringSource : public juce::AudioSource
{
  public:
    MeteringSource(juce::AudioSource& s, OutputKeepAlive& keepAlive) : source(s), keepAlive(keepAlive) {}

    void prepareToPlay(int samplesPerBlockExpected, double sampleRate) override
    {
        source.prepareToPlay(samplesPerBlockExpected, sampleRate);
        smoothedGain.reset(sampleRate, 0.01);
        smoothedGain.setCurrentAndTargetValue(targetGain.load(std::memory_order_relaxed));
    }

    void releaseResources() override { source.releaseResources(); }

    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override
    {
        // ScopedNoDenormals protects realtime DSP from denormal CPU spikes.
        const juce::ScopedNoDenormals scopedNoDenormals;
        source.getNextAudioBlock(info);
        if (info.buffer == nullptr || info.numSamples <= 0)
            return;

        const int n = info.numSamples;
        const int numCh = info.buffer->getNumChannels();

        float programPeak = 0.0F;
        for (int ch = 0; ch < numCh; ++ch)
            programPeak = juce::jmax(programPeak, info.buffer->getMagnitude(ch, info.startSample, n));

        smoothedGain.setTargetValue(targetGain.load(std::memory_order_relaxed));
        const float startGain = smoothedGain.getNextValue();
        if (n > 1)
            smoothedGain.skip(n - 1);
        const float endGain = smoothedGain.getCurrentValue();

        const bool unity = std::abs(startGain - 1.0F) < 1.0e-6F &&
                           std::abs(endGain - 1.0F) < 1.0e-6F;
        if (! unity)
        {
            for (int ch = 0; ch < numCh; ++ch)
                info.buffer->applyGainRamp(ch, info.startSample, n, startGain, endGain);
        }

        if (numCh > 0)
            atomicMaxFloat(peakL_, info.buffer->getMagnitude(0, info.startSample, n));
        if (numCh > 1)
            atomicMaxFloat(peakR_, info.buffer->getMagnitude(1, info.startSample, n));
        else if (numCh > 0)
            atomicMaxFloat(peakR_, info.buffer->getMagnitude(0, info.startSample, n));

        keepAlive.maybeApplyFloor(*info.buffer, info.startSample, n, programPeak);
    }

    void setTargetGain(float g) noexcept
    {
        targetGain.store(juce::jlimit(0.0F, 1.0F, g), std::memory_order_relaxed);
    }

    void consumePeaks(float& outL, float& outR) noexcept
    {
        outL = peakL_.exchange(0.0F, std::memory_order_relaxed);
        outR = peakR_.exchange(0.0F, std::memory_order_relaxed);
    }

  private:
    static void atomicMaxFloat(std::atomic<float>& a, float v) noexcept
    {
        float cur = a.load(std::memory_order_relaxed);
        while (v > cur && ! a.compare_exchange_weak(cur, v, std::memory_order_relaxed))
        {
        }
    }

    juce::AudioSource& source;
    OutputKeepAlive& keepAlive;
    juce::LinearSmoothedValue<float> smoothedGain;
    std::atomic<float> targetGain{1.0F};
    std::atomic<float> peakL_{0.0F};
    std::atomic<float> peakR_{0.0F};
};

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

class MasterClockSource : public juce::AudioSource
{
  public:
    MasterClockSource(juce::AudioSource& child, OutputKeepAlive& keepAlive)
        : child(child), keepAlive(keepAlive) {}

    void prepareToPlay(int blockSize, double newSampleRate) override
    {
        const double oldSr = sampleRate.load(std::memory_order_acquire);
        if (oldSr > 0.0 && newSampleRate > 0.0 && oldSr != newSampleRate)
        {
            const juce::int64 oldPos = positionSamples.load(std::memory_order_relaxed);
            const auto rescaled = static_cast<juce::int64>(
                (static_cast<double>(oldPos) * newSampleRate) / oldSr);
            positionSamples.store(rescaled, std::memory_order_relaxed);
        }
        sampleRate.store(newSampleRate, std::memory_order_release);
        silverdaw::log::info("master",
                             "prepareToPlay block=" + juce::String(blockSize) + " sr=" + juce::String(newSampleRate));
        child.prepareToPlay(blockSize, newSampleRate);
    }

    void releaseResources() override
    {
        silverdaw::log::info("master", "releaseResources");
        child.releaseResources();
    }

    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override
    {
        const juce::ScopedNoDenormals scopedNoDenormals;
        const auto startTicks = juce::Time::getHighResolutionTicks();
        const auto count = callbackCount.fetch_add(1, std::memory_order_relaxed) + 1;
        if (! keepAlive.isPlaying())
        {
            // Keep-alive only wakes sleep-prone endpoints; idle output remains true digital
            // silence.
            info.clearActiveBufferRegion();
            maybeLogAudioPerf(count, startTicks, info.numSamples);
            return;
        }

        child.getNextAudioBlock(info);
        positionSamples.fetch_add(static_cast<juce::int64>(info.numSamples), std::memory_order_relaxed);
        maybeLogAudioPerf(count, startTicks, info.numSamples);
    }

    void setPlaying(bool p) noexcept
    {
        keepAlive.setPlaying(p);
    }
    bool isPlaying() const noexcept
    {
        return keepAlive.isPlaying();
    }

    void setContentLoaded(bool loaded) noexcept
    {
        keepAlive.setContentLoaded(loaded);
    }
    bool isContentLoaded() const noexcept
    {
        return keepAlive.isContentLoaded();
    }

    void setPositionSamples(juce::int64 p) noexcept
    {
        positionSamples.store(juce::jmax(static_cast<juce::int64>(0), p), std::memory_order_relaxed);
    }
    juce::int64 getPositionSamples() const noexcept
    {
        return positionSamples.load(std::memory_order_relaxed);
    }

    double getSampleRate() const noexcept
    {
        return sampleRate.load(std::memory_order_acquire);
    }

  private:
    void maybeLogAudioPerf(std::uint64_t count, juce::int64 startTicks, int numSamples) const
    {
        if ((count % 100) != 0) return;
        const auto elapsedTicks = juce::Time::getHighResolutionTicks() - startTicks;
        const double elapsedMs = juce::Time::highResolutionTicksToSeconds(elapsedTicks) * 1000.0;
        const double sr = sampleRate.load(std::memory_order_acquire);
        const double budgetMs = sr > 0.0 && numSamples > 0 ? (static_cast<double>(numSamples) * 1000.0) / sr : 0.0;
        const double pct = budgetMs > 0.0 ? (elapsedMs / budgetMs) * 100.0 : 0.0;
        silverdaw::log::debug("perf.audio",
                              "cb#" + juce::String(static_cast<juce::int64>(count)) +
                                  " playing=" + juce::String(keepAlive.isPlaying() ? 1 : 0) +
                                  " pos=" + juce::String(positionSamples.load(std::memory_order_relaxed)) +
                                  " elapsedMs=" + juce::String(elapsedMs, 3) +
                                  " budgetMs=" + juce::String(budgetMs, 3) +
                                  " budgetPct=" + juce::String(pct, 1));
    }

    juce::AudioSource& child;
    OutputKeepAlive& keepAlive;
    std::atomic<juce::int64> positionSamples{0};
    std::atomic<double> sampleRate{0.0};
    std::atomic<std::uint64_t> callbackCount{0};

    static_assert(std::atomic<juce::int64>::is_always_lock_free,
                  "MasterClockSource requires a lock-free 64-bit atomic counter on the audio thread");
};

class AudioEngine
{
  public:
    AudioEngine();
    ~AudioEngine();

    AudioEngine(const AudioEngine&) = delete;
    AudioEngine& operator=(const AudioEngine&) = delete;

    juce::String initialise(const juce::String& preferredTypeName = {},
                            const juce::String& preferredDeviceName = {},
                            bool* outFellBackToDefault = nullptr);

    void shutdown();

    bool addClip(const juce::String& trackId, const juce::String& clipId,
                 const juce::File& filePath, double initialOffsetMs = 0.0,
                 double inMs = 0.0, double clipDurationMs = 0.0, float initialGain = 1.0F,
                 juce::String* outError = nullptr);

    bool removeClip(const juce::String& clipId);

    bool setClipGain(const juce::String& clipId, float gain);

    void play();

    // Deep read-ahead priming avoids JUCE BufferingAudioSource dropping cold samples at play
    // start.
    bool primeTracksForPlayback(int totalBudgetMs);

    void pause();

    void stop();

    void setMasterGain(float gain);

    void consumeMasterPeaks(float& outL, float& outR);

    bool consumeTrackPeaks(const juce::String& trackId, float& outL, float& outR);

    void setTrackTone(const juce::String& trackId,
                      float bassDb, float midDb, float trebleDb, bool lowCut,
                      bool highCut, bool snap);

    void setTrackLeveler(const juce::String& trackId, float amount, bool snap);

    void setTrackSends(const juce::String& trackId, float reverbSend, float delaySend);

    void setTrackPan(const juce::String& trackId, float pan);

    void setProjectReverb(float size, float decay, float tone, float mix, bool snap);

    // Delay time is staged while playing; feedback, tone, and mix apply live.
    void setProjectDelay(double delayMs, float feedback, float tone, float mix, bool snap);

    void drainAllTrackPeaks(std::vector<BusGraph::TrackPeakSnapshot>& out);

    void setPositionMs(double ms);

    bool setClipOffsetMs(const juce::String& clipId, double offsetMs);
    bool commitClipOffset(const juce::String& clipId);

    bool setClipTrim(const juce::String& clipId, double startMs, double inMs, double clipDurationMs);

    bool setClipWarp(const juce::String& clipId,
                     std::optional<bool> enabled,
                     std::optional<juce::String> mode,
                     std::optional<double> tempoRatio,
                     std::optional<double> semitones,
                     std::optional<double> cents);

    bool setClipEnvelope(const juce::String& clipId, const juce::Array<juce::var>& points);

    bool setClipEdgeFade(const juce::String& clipId,
                         bool hasFadeIn, double fadeInStartMs, double fadeInEndMs,
                         bool hasFadeOut, double fadeOutStartMs, double fadeOutEndMs);

    bool isPlaying() const;

    bool isContentLoaded() const;

    double getPositionMs() const;

    double getClipDurationMs(const juce::String& clipId) const;


    bool loadPreview(const juce::File& filePath, double inMs, double durationMs,
                     juce::String* outError = nullptr,
                     std::optional<bool> initialWarpEnabled = std::nullopt,
                     std::optional<juce::String> initialWarpMode = std::nullopt,
                     std::optional<double> initialTempoRatio = std::nullopt,
                     std::optional<double> initialSemitones = std::nullopt,
                     std::optional<double> initialCents = std::nullopt);

    void unloadPreview();

    void playPreview();

    void pausePreview();

    void stopPreview();

    void setPreviewPositionMs(double ms);

    double getPreviewPositionMs() const;

    double getPreviewDurationMs() const;

    bool isPreviewPlaying() const;

    bool isPreviewLoaded() const;

    bool setPreviewWarp(std::optional<bool> enabled,
                        std::optional<juce::String> mode,
                        std::optional<double> tempoRatio,
                        std::optional<double> semitones,
                        std::optional<double> cents);

    bool setPreviewEnvelope(const juce::Array<juce::var>& points);

    juce::int64 getPreviewGeneration() const;

    // Windows under-reports Bluetooth endpoint latency, so known headset names get a
    // conservative visual offset.
    double getOutputLatencyMs() const;

    double getHeuristicExtraLatencyMs() const;

    juce::AudioFormatManager& getFormatManager() noexcept
    {
        return formatManager;
    }

    // Avoid full device scans on startup; ASIO probing can block for hundreds of ms.
    struct DeviceTypeListing
    {
        juce::String typeName;
        juce::StringArray deviceNames;
    };

    struct AudioDevicesSnapshot
    {
        juce::Array<DeviceTypeListing> types;
        juce::String currentTypeName;
        juce::String currentDeviceName;
        double currentSampleRate = 0.0;
        int currentBufferSize = 0;
        double outputLatencyMs = 0.0;
        double heuristicExtraLatencyMs = 0.0;
        bool fellBackToDefault = false;
    };

    AudioDevicesSnapshot getAudioDevicesSnapshot() const
    {
        return devicesSnapshot;
    }

    void clearFellBackToDefault() noexcept
    {
        devicesSnapshot.fellBackToDefault = false;
    }

    void refreshAudioDevices();

    bool hasScannedAllDevices() const noexcept
    {
        return hasFullyScanned;
    }

    juce::String selectOutputDevice(const juce::String& typeName, const juce::String& deviceName);

    using DeviceListChangedCallback = std::function<void()>;
    void setDeviceListChangedCallback(DeviceListChangedCallback cb)
    {
        deviceListChangedCallback = std::move(cb);
    }

  private:
    struct Track
    {
        std::unique_ptr<juce::AudioFormatReaderSource> readerSource;
        std::unique_ptr<OffsetSource> offsetSource;
        std::unique_ptr<juce::BufferingAudioSource> bufferingSource;
        std::unique_ptr<juce::AudioTransportSource> transportSource;
        std::unique_ptr<WarpProcessor> warp;
        std::vector<std::unique_ptr<WarpProcessor>> retiredWarps;
        std::unique_ptr<EnvelopeSnapshot> envelopeSnapshot;
        // Retire replaced snapshots/processors until the audio thread is quiescent.
        std::vector<std::unique_ptr<EnvelopeSnapshot>> retiredEnvelopes;
        std::unique_ptr<EdgeFadeSnapshot> edgeFadeSnapshot;
        std::vector<std::unique_ptr<EdgeFadeSnapshot>> retiredEdgeFades;
        double sampleRate = 44100.0;
        int numChannels = 2;
        juce::int64 latencySamples = 0;

        bool prefetchDirty = false;
    };

    double trackSeekSecondsFor(const Track& track, juce::int64 masterSamples) const;

    void rebuildTrackPrefetch(Track& track);

    void flushAllDirtyRebuildsSync();

    void flushDirtyRebuilds();

    class RebuildTimer : public juce::Timer
    {
      public:
        explicit RebuildTimer(AudioEngine& e) : engine(e) {}
        void timerCallback() override
        {
            stopTimer();
            engine.flushDirtyRebuilds();
        }

      private:
        AudioEngine& engine;
    };
    RebuildTimer rebuildTimer{*this};
    static constexpr int kRebuildDebounceMs = 150;

    // Wake pre-roll spends endpoint fade-in on the keep-alive floor, not the first content
    // attack.
    class PrerollTimer : public juce::Timer
    {
      public:
        explicit PrerollTimer(AudioEngine& e) : engine(e) {}
        void timerCallback() override { engine.completeWakePreroll(); }

      private:
        AudioEngine& engine;
    };
    PrerollTimer prerollTimer{*this};
    std::function<void()> prerollAction;

    double lastOutputActiveMs = 0.0;

    void startWithWakePreroll(std::function<void()> startFn);
    void cancelWakePreroll();
    void completeWakePreroll();

    bool pendingSeekPrewarm = false;

    juce::AudioDeviceManager deviceManager;
    juce::AudioSourcePlayer sourcePlayer;
    BusGraph busGraph;

    void rebuildDevicesSnapshot(bool rescan);

    void onDeviceListChanged();

    AudioDevicesSnapshot devicesSnapshot;
    DeviceListChangedCallback deviceListChangedCallback;
    bool hasFullyScanned = false;

    class DeviceChangeListener : public juce::ChangeListener
    {
      public:
        explicit DeviceChangeListener(AudioEngine& e) : engine(e) {}
        void changeListenerCallback(juce::ChangeBroadcaster*) override
        {
            engine.onDeviceListChanged();
        }

      private:
        AudioEngine& engine;
    };
    DeviceChangeListener deviceChangeListener{*this};

    OutputKeepAlive outputKeepAlive;
    MasterClockSource master{busGraph, outputKeepAlive};
    juce::MixerAudioSource topMixer;
    MeteringSource masterMeter{topMixer, outputKeepAlive};
    juce::AudioFormatManager formatManager;

    juce::TimeSliceThread readAheadThread{"silverdaw-readahead"};

    std::unordered_map<juce::String, std::unique_ptr<Track>> tracks; // keyed by clipId


    struct Preview
    {
        std::unique_ptr<juce::AudioFormatReaderSource> readerSource;
        std::unique_ptr<OffsetSource> offsetSource;
        std::unique_ptr<juce::AudioTransportSource> transportSource;
        std::unique_ptr<WarpProcessor> warp;
        std::vector<std::unique_ptr<WarpProcessor>> retiredWarps;
        std::unique_ptr<EnvelopeSnapshot> envelopeSnapshot;
        std::vector<std::unique_ptr<EnvelopeSnapshot>> retiredEnvelopes;
        juce::String warpMode{"rhythmic"};
        double sampleRate = 44100.0;
        double inMs = 0.0;
        double durationMs = 0.0;
        double sourceDurationMs = 0.0;
    };
    Preview preview;
    std::atomic<juce::int64> previewGeneration{0};
};

} // namespace silverdaw
