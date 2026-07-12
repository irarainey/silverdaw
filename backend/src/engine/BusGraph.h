#pragma once

#include "SharedFx.h"
#include "TrackAutomationSnapshot.h"
#include "TrackChain.h"

#include <atomic>
#include <algorithm>
#include <cmath>
#include <memory>
#include <thread>
#include <unordered_map>
#include <vector>

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
        TrackChain chain;
        // Message-thread-owned source list. The audio thread reads an immutable copy
        // from RenderSnapshot, never this vector directly.
        std::vector<juce::AudioSource*> clips;
        // Scalar mix params: atomically published by message-thread setters and
        // read by the audio thread, so setTrackSends/setTrackPan need no lock.
        std::atomic<float> reverbSend{0.0F};
        std::atomic<float> delaySend{0.0F};
        std::atomic<float> pan{0.0F};
        std::atomic<float> panGainL{1.0F};
        std::atomic<float> panGainR{1.0F};
        std::atomic<float> peakL{0.0F};
        std::atomic<float> peakR{0.0F};
        std::atomic<bool> automationResetRequested{false};
        std::atomic<bool> bypassRequested{false};
        std::atomic<bool> bypassReady{false};
        bool renderEnabled = true;
        // Message-thread-owned pointer copied into each immutable RenderSnapshot.
        const TrackAutomationSnapshot* publishedAutomation = nullptr;
        const TrackAutomationSnapshot* lastAutomationSnapshot = nullptr;
        std::size_t automationSegments[TrackAutomationSnapshot::kNumParams] = {};
        juce::int64 automationLastEndSamples = -1;

        void prepareToPlay(int samplesPerBlockExpected, double sampleRate) override;
        void releaseResources() override;
        void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override;

        void renderClips(const std::vector<juce::AudioSource*>& sources,
                         const juce::AudioSourceChannelInfo& info);

        void consumePeaks(float& outL, float& outR) noexcept
        {
            outL = peakL.exchange(0.0F, std::memory_order_relaxed);
            outR = peakR.exchange(0.0F, std::memory_order_relaxed);
        }

    private:
        juce::AudioBuffer<float> mixScratch;
        int preparedBlockSize = 0;
        double preparedRate = 0.0;

        static void atomicMaxFloat(std::atomic<float>& a, float v) noexcept
        {
            float cur = a.load(std::memory_order_relaxed);
            while (v > cur && ! a.compare_exchange_weak(cur, v, std::memory_order_relaxed))
            {
            }
        }
    };

private:
    struct RenderTrack
    {
        TrackRuntime* runtime = nullptr;
        std::vector<juce::AudioSource*> clips;
        const TrackAutomationSnapshot* automation = nullptr;
    };

    struct RenderSnapshot
    {
        std::vector<RenderTrack> tracks;
        bool hasAutomation = false;
    };

    class RenderReadGuard
    {
    public:
        explicit RenderReadGuard(BusGraph& owner) noexcept;
        ~RenderReadGuard();

        const RenderSnapshot& get() const noexcept { return *snapshot; }

    private:
        BusGraph& graph;
        const RenderSnapshot* snapshot = nullptr;
    };

public:
    BusGraph();
    ~BusGraph() override = default;

    BusGraph(const BusGraph&) = delete;
    BusGraph& operator=(const BusGraph&) = delete;

    void prepareToPlay(int samplesPerBlockExpected, double sampleRate) override;
    void releaseResources() override;
    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override;

    void attachClip(const juce::String& trackId,
                    const juce::String& clipId,
                    juce::AudioSource* clipTransport,
                    bool trackRenderingEnabled = true,
                    bool prepareSource = true);

    void detachClip(const juce::String& clipId,
                    juce::AudioSource* clipTransport,
                    bool releaseSource = true);

    bool consumeTrackPeaks(const juce::String& trackId,
                           float& outL, float& outR) noexcept;

    /** Let one final gain-ramp block render before removing the track. */
    void requestTrackBypass(const juce::String& trackId);

    /** Remove a track whose final block has rendered. Returns true when complete. */
    bool finalizeTrackBypass(const juce::String& trackId);

    /** Immediately include or exclude a track at a quiescent graph boundary. */
    void setTrackRenderingEnabled(const juce::String& trackId, bool enabled);

    void setTrackTone(const juce::String& trackId,
                      float bassDb, float midDb, float trebleDb, float filter,
                      bool snap);

    void setTrackLeveler(const juce::String& trackId, float amount, bool snap);

    void setTrackSends(const juce::String& trackId, float reverbSend, float delaySend);

    static void equalPowerPanGains(float pan, float& gainL, float& gainR) noexcept
    {
        const float p = juce::jlimit(-1.0F, 1.0F, std::isfinite(pan) ? pan : 0.0F);
        const float theta = (p + 1.0F) * (juce::MathConstants<float>::pi * 0.25F);
        gainL = juce::MathConstants<float>::sqrt2 * std::cos(theta);
        gainR = juce::MathConstants<float>::sqrt2 * std::sin(theta);
    }

    void setTrackPan(const juce::String& trackId, float pan);

    void setProjectReverb(float size, float decay, float tone, float mix, bool snap);

    void setProjectDelay(double delayMs, float feedback, float tone, float mix, bool snap,
                         bool applyTimeNow);

    void resetSharedFx();

    /** Wire the block-start transport counter for automation sampling (once, at setup). */
    void setTimelineSamplesSource(const std::atomic<juce::int64>* p) noexcept
    {
        timelineSamplesPtr = p;
    }

    /** Force the next automated block to snap (no glide) — call on transport start
     *  so playback lands exactly on the curve value at the playhead. */
    void snapAutomationCursors() noexcept;

    /** Snap one param's DSP target back to its neutral default — used when a lane is
     *  cleared so the chain stops holding the last automated value. */
    void snapParamToDefault(const juce::String& trackId, AutomationParam p) noexcept;

    /** Publish a track's automation snapshot (or nullptr to clear). The snapshot
     *  memory is owned + retired by the caller (AudioEngine). Resets the sampling
     *  cursor when the pointer changes so the next block re-seeks cleanly. */
    void setTrackAutomationPtr(const juce::String& trackId, const TrackAutomationSnapshot* snap);

    bool sharedFxTerminated()
    {
        // Lock-free: reads atomic done flags written by the audio-thread tail detectors.
        return sharedFx.bothTerminated();
    }

    /** Publish an equivalent render snapshot and wait for any callback using the
     *  previous snapshot. Message thread only; never called from the audio callback. */
    void synchronizeRenderThread();

    struct TrackPeakSnapshot
    {
        juce::String trackId;
        float peakL;
        float peakR;
    };

    void drainAllTrackPeaks(std::vector<TrackPeakSnapshot>& out);

    // Retained for diagnostics compatibility. Lock-free snapshots keep this at zero.
    juce::uint64 audioBlocksSkipped() const noexcept
    {
        return skippedBlocks.load(std::memory_order_relaxed);
    }

    void clear();

private:
    juce::CriticalSection lock;

    const RenderSnapshot* pinRenderSnapshot() noexcept;

    std::unique_ptr<RenderSnapshot> buildRenderSnapshot() const;

    std::unique_ptr<RenderSnapshot> buildRenderSnapshotExcluding(
        const juce::AudioSource* excluded) const;

    void publishRenderSnapshot();
    void publishEmptyRenderSnapshot();
    void publishRenderSnapshot(std::unique_ptr<RenderSnapshot> next) noexcept;

    void applyTrackAutomation(TrackRuntime& rt, const TrackAutomationSnapshot* snap,
                              juce::int64 subStartSamples, int numSamples, double rate) noexcept;

    std::atomic<juce::uint64> skippedBlocks{0};
    std::unique_ptr<RenderSnapshot> currentRenderSnapshot;
    std::atomic<const RenderSnapshot*> publishedRenderSnapshot{nullptr};
    std::atomic<const RenderSnapshot*> renderHazard{nullptr};
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
    std::unordered_map<juce::String, const TrackAutomationSnapshot*> pendingAutomation;

    SharedFx sharedFx;
    juce::AudioBuffer<float> reverbSendBuf;
    juce::AudioBuffer<float> delaySendBuf;

    juce::AudioBuffer<float> scratch;
    int preparedMax = 0;
    double preparedRate = 0.0;

    // Fixed automation sampling granularity (frames). Keeps live and offline render
    // sampling the curves identically regardless of their differing block sizes.
    static constexpr int kAutomationControlQuantum = 256;

    // Block-start transport counter, read live on the audio thread (MasterClock).
    const std::atomic<juce::int64>* timelineSamplesPtr = nullptr;
};

} // namespace silverdaw
