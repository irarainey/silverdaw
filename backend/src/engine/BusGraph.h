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
        float reverbSend = 0.0F;
        float delaySend = 0.0F;
        float pan = 0.0F;
        float panGainL = 1.0F;
        float panGainR = 1.0F;
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
        reapplyStickyProjectFx();
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

        const juce::ScopedLock sl(lock);
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

                const float rSend = kv.second->reverbSend;
                const float dSend = kv.second->delaySend;
                for (int ch = 0; ch < sendChannels; ++ch)
                {
                    if (rSend != 0.0F)
                        reverbSendBuf.addFrom(ch, 0, scratch, ch, 0, n, rSend);
                    if (dSend != 0.0F)
                        delaySendBuf.addFrom(ch, 0, scratch, ch, 0, n, dSend);
                }
                if (kv.second->pan == 0.0F || outChannels < 2)
                {
                    for (int ch = 0; ch < outChannels; ++ch)
                        info.buffer->addFrom(ch, dst, scratch, ch, 0, n);
                }
                else
                {
                    info.buffer->addFrom(0, dst, scratch, 0, 0, n, kv.second->panGainL);
                    info.buffer->addFrom(1, dst, scratch, 1, 0, n, kv.second->panGainR);
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
            rt->chain.setTone(t.bassDb, t.midDb, t.trebleDb, t.lowCut, t.highCut, /*snap*/ true);
        }

        auto levelerIt = pendingLeveler.find(trackId);
        if (levelerIt != pendingLeveler.end())
        {
            rt->chain.setLeveler(levelerIt->second, /*snap*/ true);
        }

        auto sendIt = pendingSends.find(trackId);
        if (sendIt != pendingSends.end())
        {
            rt->reverbSend = sendIt->second.reverbSend;
            rt->delaySend = sendIt->second.delaySend;
        }

        auto panIt = pendingPans.find(trackId);
        if (panIt != pendingPans.end())
        {
            rt->pan = panIt->second;
            equalPowerPanGains(panIt->second, rt->panGainL, rt->panGainR);
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

    void setTrackLeveler(const juce::String& trackId, float amount, bool snap)
    {
        if (trackId.isEmpty()) return;
        const float a = juce::jlimit(0.0F, 1.0F, std::isfinite(amount) ? amount : 0.0F);
        const juce::ScopedLock sl(lock);
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
        const juce::ScopedLock sl(lock);
        pendingSends[trackId] = {r, d};
        auto it = runtimes.find(trackId);
        if (it != runtimes.end())
        {
            it->second->reverbSend = r;
            it->second->delaySend = d;
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
        const juce::ScopedLock sl(lock);
        pendingPans[trackId] = p;
        auto it = runtimes.find(trackId);
        if (it != runtimes.end())
        {
            it->second->pan = p;
            it->second->panGainL = gL;
            it->second->panGainR = gR;
        }
    }

    void setProjectReverb(float size, float decay, float tone, float mix, bool snap)
    {
        const juce::ScopedLock sl(lock);
        stickyReverb = {size, decay, tone, mix, true};
        sharedFx.setReverbParams(size, decay, tone, mix, snap);
    }

    void setProjectDelay(double delayMs, float feedback, float tone, float mix, bool snap,
                         bool applyTimeNow)
    {
        const juce::ScopedLock sl(lock);
        stickyDelay = {delayMs, feedback, tone, mix, applyTimeNow, true};
        sharedFx.setDelayParams(delayMs, feedback, tone, mix, snap, applyTimeNow);
    }

    void resetSharedFx()
    {
        const juce::ScopedLock sl(lock);
        sharedFx.reset();
    }

    bool sharedFxTerminated()
    {
        const juce::ScopedLock sl(lock);
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
    void reapplyStickyProjectFx() noexcept
    {
        if (stickyReverb.valid)
            sharedFx.setReverbParams(stickyReverb.size, stickyReverb.decay,
                                     stickyReverb.tone, stickyReverb.mix, /*snap*/ true);
        if (stickyDelay.valid)
            sharedFx.setDelayParams(stickyDelay.delayMs, stickyDelay.feedback,
                                    stickyDelay.tone, stickyDelay.mix, /*snap*/ true,
                                    /*applyTimeNow*/ true);
    }

    juce::CriticalSection lock;
    std::unordered_map<juce::String, std::unique_ptr<TrackRuntime>> runtimes;
    std::unordered_map<juce::String, TrackRuntime*> clipToTrack;

    struct ToneParams
    {
        float bassDb = 0.0F;
        float midDb = 0.0F;
        float trebleDb = 0.0F;
        bool lowCut = false;
        bool highCut = false;
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

    struct StickyReverb
    {
        float size = 0.0F, decay = 0.0F, tone = 0.0F, mix = 0.0F;
        bool valid = false;
    } stickyReverb;
    struct StickyDelay
    {
        double delayMs = 1.0;
        float feedback = 0.0F, tone = 0.0F, mix = 0.0F;
        bool applyTimeNow = true;
        bool valid = false;
    } stickyDelay;

    SharedFx sharedFx;
    juce::AudioBuffer<float> reverbSendBuf;
    juce::AudioBuffer<float> delaySendBuf;

    juce::AudioBuffer<float> scratch;
    int preparedMax = 0;
    double preparedRate = 0.0;
};

} // namespace silverdaw
