#pragma once

#include "SharedFx.h"
#include "TrackChain.h"

#include <atomic>
#include <memory>
#include <unordered_map>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

namespace silverdaw
{

// Message-thread writes are published for bounded, lock-free audio-thread reads.
class BusGraph final : public juce::AudioSource
{
public:
    struct TrackRuntime final : public juce::AudioSource
    {
        juce::String trackId;
        juce::MixerAudioSource innerMixer;
        TrackChain chain;
        int clipCount = 0;
        // Scalar mix params: atomically published by message-thread setters and
        // read by the audio thread, so setTrackSends/setTrackPan need no lock.
        std::atomic<float> reverbSend{0.0F};
        std::atomic<float> delaySend{0.0F};
        std::atomic<float> pan{0.0F};
        std::atomic<float> panGainL{1.0F};
        std::atomic<float> panGainR{1.0F};
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
            }
        }
    };

    BusGraph() = default;
    ~BusGraph() override = default;

    BusGraph(const BusGraph&) = delete;
    BusGraph& operator=(const BusGraph&) = delete;

    void prepareToPlay(int samplesPerBlockExpected, double sampleRate) override
    {
        const juce::ScopedLock sl(lock);
        preparedMax = juce::jmax(1, samplesPerBlockExpected);
        preparedRate = sampleRate;
        scratch.setSize(/*numChannels*/ 2, preparedMax, /*keepExisting*/ false,
                        /*clearExtra*/ true, /*avoidReallocating*/ false);
        scratch.clear();
        reverbSendBuf.setSize(2, preparedMax, false, true, false);
        delaySendBuf.setSize(2, preparedMax, false, true, false);
        reverbSendBuf.clear();
        delaySendBuf.clear();
        sharedFx.prepare(preparedRate, preparedMax);
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

        for (int ch = 0; ch < info.buffer->getNumChannels(); ++ch)
            info.buffer->clear(ch, info.startSample, info.numSamples);

        // Bounded real-time mitigation: never block the audio thread (the hard
        // invariant forbids it). If the message thread is mid-mutation we skip
        // this block (already cleared above -> silence) and record it for the
        // debug logs, rather than waiting and risking priority inversion.
        // The lock now guards only structural graph edits (attach/detach/clear)
        // and prepare/release; all DSP param mutation (TrackChain/SharedFx) is
        // published lock-free, so live FX automation no longer contends here.
        const juce::ScopedTryLock sl(lock);
        if (! sl.isLocked())
        {
            skippedBlocks.fetch_add(1, std::memory_order_relaxed);
            return;
        }
        // NOTE: do NOT early-return on empty runtimes; shared FX tails still need pumping.
        if (preparedMax <= 0) return;

        const int outChannels = juce::jmin(scratch.getNumChannels(),
                                           info.buffer->getNumChannels());
        if (outChannels <= 0) return;

        const int sendChannels = juce::jmin(2, outChannels);

        int remaining = info.numSamples;
        int dst = info.startSample;
        while (remaining > 0)
        {
            const int n = juce::jmin(remaining, preparedMax);

            for (int ch = 0; ch < 2; ++ch)
            {
                reverbSendBuf.clear(ch, 0, n);
                delaySendBuf.clear(ch, 0, n);
            }

            for (auto& kv : runtimes)
            {
                scratch.clear(0, n);
                juce::AudioSourceChannelInfo sub(&scratch, 0, n);
                kv.second->getNextAudioBlock(sub);

                const float rSend = kv.second->reverbSend.load(std::memory_order_relaxed);
                const float dSend = kv.second->delaySend.load(std::memory_order_relaxed);
                for (int ch = 0; ch < sendChannels; ++ch)
                {
                    if (rSend != 0.0F)
                        reverbSendBuf.addFrom(ch, 0, scratch, ch, 0, n, rSend);
                    if (dSend != 0.0F)
                        delaySendBuf.addFrom(ch, 0, scratch, ch, 0, n, dSend);
                }
                if (kv.second->pan.load(std::memory_order_relaxed) == 0.0F || outChannels < 2)
                {
                    for (int ch = 0; ch < outChannels; ++ch)
                        info.buffer->addFrom(ch, dst, scratch, ch, 0, n);
                }
                else
                {
                    info.buffer->addFrom(0, dst, scratch, 0, 0, n,
                                         kv.second->panGainL.load(std::memory_order_relaxed));
                    info.buffer->addFrom(1, dst, scratch, 1, 0, n,
                                         kv.second->panGainR.load(std::memory_order_relaxed));
                    for (int ch = 2; ch < outChannels; ++ch)
                        info.buffer->addFrom(ch, dst, scratch, ch, 0, n);
                }
            }

            sharedFx.process(reverbSendBuf, delaySendBuf, *info.buffer, dst, n);

            remaining -= n;
            dst += n;
        }
    }


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

        auto toneIt = pendingTone.find(trackId);
        if (toneIt != pendingTone.end())
        {
            const auto& t = toneIt->second;
            rt->chain.setTone(t.bassDb, t.midDb, t.trebleDb, t.filter, /*snap*/ true);
        }

        auto levelerIt = pendingLeveler.find(trackId);
        if (levelerIt != pendingLeveler.end())
        {
            rt->chain.setLeveler(levelerIt->second, /*snap*/ true);
        }

        auto sendIt = pendingSends.find(trackId);
        if (sendIt != pendingSends.end())
        {
            rt->reverbSend.store(sendIt->second.reverbSend, std::memory_order_relaxed);
            rt->delaySend.store(sendIt->second.delaySend, std::memory_order_relaxed);
        }

        auto panIt = pendingPans.find(trackId);
        if (panIt != pendingPans.end())
        {
            float gL = 1.0F;
            float gR = 1.0F;
            equalPowerPanGains(panIt->second, gL, gR);
            rt->pan.store(panIt->second, std::memory_order_relaxed);
            rt->panGainL.store(gL, std::memory_order_relaxed);
            rt->panGainR.store(gR, std::memory_order_relaxed);
        }
    }

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

    bool consumeTrackPeaks(const juce::String& trackId,
                           float& outL, float& outR) noexcept
    {
        // Lock-free: the map is only ever mutated on this (message) thread, and
        // peaks are atomic, so this read cannot race the audio thread.
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

    void setTrackTone(const juce::String& trackId,
                      float bassDb, float midDb, float trebleDb, float filter,
                      bool snap)
    {
        if (trackId.isEmpty()) return;
        // Lock-free: `pendingTone` and the runtime map are message-thread-only (serialised vs
        // attach/detach/clear), and `ToneEq` publishes its params atomically, so the audio
        // thread's read-only map iteration is never raced.
        pendingTone[trackId] = {bassDb, midDb, trebleDb, filter};
        auto it = runtimes.find(trackId);
        if (it != runtimes.end())
            it->second->chain.setTone(bassDb, midDb, trebleDb, filter, snap);
    }

    void setTrackLeveler(const juce::String& trackId, float amount, bool snap)
    {
        if (trackId.isEmpty()) return;
        const float a = juce::jlimit(0.0F, 1.0F, std::isfinite(amount) ? amount : 0.0F);
        // Lock-free: see `setTrackTone`; `Leveler` publishes its param atomically.
        pendingLeveler[trackId] = a;
        auto it = runtimes.find(trackId);
        if (it != runtimes.end())
            it->second->chain.setLeveler(a, snap);
    }

    void setTrackSends(const juce::String& trackId, float reverbSend, float delaySend)
    {
        if (trackId.isEmpty()) return;
        const float r = juce::jlimit(0.0F, 1.0F, std::isfinite(reverbSend) ? reverbSend : 0.0F);
        const float d = juce::jlimit(0.0F, 1.0F, std::isfinite(delaySend) ? delaySend : 0.0F);
        // Lock-free: publishes atomic scalars; pending* and the map are
        // message-thread-only, so this never contends the audio callback.
        pendingSends[trackId] = {r, d};
        auto it = runtimes.find(trackId);
        if (it != runtimes.end())
        {
            it->second->reverbSend.store(r, std::memory_order_relaxed);
            it->second->delaySend.store(d, std::memory_order_relaxed);
        }
    }

    static void equalPowerPanGains(float pan, float& gainL, float& gainR) noexcept
    {
        const float p = juce::jlimit(-1.0F, 1.0F, std::isfinite(pan) ? pan : 0.0F);
        const float theta = (p + 1.0F) * (juce::MathConstants<float>::pi * 0.25F);
        gainL = juce::MathConstants<float>::sqrt2 * std::cos(theta);
        gainR = juce::MathConstants<float>::sqrt2 * std::sin(theta);
    }

    void setTrackPan(const juce::String& trackId, float pan)
    {
        if (trackId.isEmpty()) return;
        const float p = juce::jlimit(-1.0F, 1.0F, std::isfinite(pan) ? pan : 0.0F);
        float gL = 1.0F;
        float gR = 1.0F;
        equalPowerPanGains(p, gL, gR);
        // Lock-free: publishes atomic scalars. Map/pending* are message-thread-only.
        // A concurrent audio read may briefly see a mismatched pan/gain pair; each
        // value is individually valid so the worst case is a one-block transient.
        pendingPans[trackId] = p;
        auto it = runtimes.find(trackId);
        if (it != runtimes.end())
        {
            it->second->panGainL.store(gL, std::memory_order_relaxed);
            it->second->panGainR.store(gR, std::memory_order_relaxed);
            it->second->pan.store(p, std::memory_order_relaxed);
        }
    }

    void setProjectReverb(float size, float decay, float tone, float mix, bool snap)
    {
        // Lock-free: `SharedFx` publishes targets + a deferred snap flag atomically; the
        // persistent target atomics are re-snapped by `sharedFx.prepare` after device changes.
        sharedFx.setReverbParams(size, decay, tone, mix, snap);
    }

    void setProjectDelay(double delayMs, float feedback, float tone, float mix, bool snap,
                         bool applyTimeNow)
    {
        // Lock-free: see `setProjectReverb`.
        sharedFx.setDelayParams(delayMs, feedback, tone, mix, snap, applyTimeNow);
    }

    void resetSharedFx()
    {
        // Lock-free: schedules the reset for the next audio block instead of mutating
        // decay state from the message thread.
        sharedFx.requestReset();
    }

    bool sharedFxTerminated()
    {
        // Lock-free: reads atomic done flags written by the audio-thread tail detectors.
        return sharedFx.bothTerminated();
    }

    struct TrackPeakSnapshot
    {
        juce::String trackId;
        float peakL;
        float peakR;
    };

    void drainAllTrackPeaks(std::vector<TrackPeakSnapshot>& out)
    {
        // Lock-free: message-thread-only map iteration; peaks are atomic.
        out.clear();
        out.reserve(runtimes.size());
        for (auto& kv : runtimes)
        {
            float l = 0.0F;
            float r = 0.0F;
            kv.second->consumePeaks(l, r);
            out.push_back({kv.first, l, r});
        }
    }

    // Total audio blocks skipped because the audio thread could not acquire the
    // lock (message-thread mutation in flight). Monotonic; for debug telemetry.
    juce::uint64 audioBlocksSkipped() const noexcept
    {
        return skippedBlocks.load(std::memory_order_relaxed);
    }

    void clear()
    {
        const juce::ScopedLock sl(lock);
        for (auto& kv : runtimes)
            kv.second->releaseResources();
        runtimes.clear();
        clipToTrack.clear();
        pendingTone.clear();
        pendingLeveler.clear();
        pendingSends.clear();
        pendingPans.clear();
        sharedFx.reset();
    }

private:
    juce::CriticalSection lock;
    std::atomic<juce::uint64> skippedBlocks{0};
    std::unordered_map<juce::String, std::unique_ptr<TrackRuntime>> runtimes;
    std::unordered_map<juce::String, TrackRuntime*> clipToTrack;

    struct ToneParams
    {
        float bassDb = 0.0F;
        float midDb = 0.0F;
        float trebleDb = 0.0F;
        float filter = 0.0F;
    };
    std::unordered_map<juce::String, ToneParams> pendingTone;

    std::unordered_map<juce::String, float> pendingLeveler;

    struct SendParams
    {
        float reverbSend = 0.0F;
        float delaySend = 0.0F;
    };
    std::unordered_map<juce::String, SendParams> pendingSends;

    std::unordered_map<juce::String, float> pendingPans;

    SharedFx sharedFx;
    juce::AudioBuffer<float> reverbSendBuf;
    juce::AudioBuffer<float> delaySendBuf;

    juce::AudioBuffer<float> scratch;
    int preparedMax = 0;
    double preparedRate = 0.0;
};

} // namespace silverdaw
