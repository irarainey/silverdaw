#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include "DspSmooth.h"

#include <atomic>
#include <cmath>
#include <cstdint>
#include <vector>

namespace silverdaw
{

// Shared delay-note resolver keeps live and export timing identical.
double delayNoteToMs(const juce::String& noteValue, double bpm) noexcept;

// Shared wet-only Reverb/Delay processor; live and export share it for parity.
// All buffers are sized in `prepare`. Message-thread setters publish targets and control
// flags lock-free (atomics + release flags); `process` consumes them and owns every cur*/
// coefficient/`juce::Reverb` mutation, so the audio callback is never blocked. Snap is a
// deferred flag consumed at the top of `process`, preserving live/export first-block parity.
// Tail detectors bound offline render after the dry send goes silent.
class SharedFx
{
public:
    SharedFx() = default;

    /** Sizes buffers outside the audio callback and clears decay state. */
    void prepare(double sampleRate, int maxBlockSize) noexcept;

    /** Clears decay state and recomputes delay time from the persistent target at the current rate. */
    void reset() noexcept;

    /** Lock-free: schedules a decay-state reset consumed at the top of the next `process` block. */
    void requestReset() noexcept { resetRequested.store(true, std::memory_order_release); }

    /** Lock-free; `snap` schedules a steady-state first block for setup/load/runtime paths. */
    void setReverbParams(float size, float decay, float tone, float mix, bool snap) noexcept;

    /** Lock-free; `applyTimeNow` schedules a delay-time jump, `snap` a steady-state first block. */
    void setDelayParams(double delayMs, float feedback, float tone, float mix, bool snap,
                        bool applyTimeNow) noexcept;

    /** Returns the minimum delay-tail duration needed to preserve feedback repeats. */
    static double minimumEchoTailSeconds(double delayMs, float feedback) noexcept;

    void process(const juce::AudioBuffer<float>& reverbSend,
                 const juce::AudioBuffer<float>& delaySend,
                 juce::AudioBuffer<float>& out, int startSample, int numSamples) noexcept;

    /** True once the Reverb tail has decayed below audibility (§7.10). */
    bool reverbTerminated() const noexcept { return reverbDone.load(std::memory_order_relaxed); }
    /** True once the Delay tail has fully repeated out (§7.10). */
    bool echoTerminated() const noexcept { return echoDone.load(std::memory_order_relaxed); }
    /** True once **both** shared FX have terminated — the bus is silent. */
    bool bothTerminated() const noexcept { return reverbTerminated() && echoTerminated(); }
    SharedFx(const SharedFx&) = delete;
    SharedFx& operator=(const SharedFx&) = delete;

private:
    // Tunables for tail detection and smoothing.
    static constexpr double kMaxDelayMs = 4000.0;     // 1/4 note at 15 BPM (worst case)
    static constexpr float kMaxFeedback = 0.95F;      // loop gain < unity
    static constexpr float kRmsFloorLin = 0.001F;     // -60 dBFS
    static constexpr float kRmsRestartLin = 0.0014125F; // -57 dBFS (+3 dB hysteresis)
    static constexpr double kRoomCapSeconds = 8.0;
    static constexpr double kEchoCapSeconds = 4.0; // Minimum fallback cap.
    static constexpr double kSilenceWindowMs = 50.0;  // Reverb RMS run + Delay hold pad
    static constexpr float kSignalEpsilon = 1.0e-7F;
    static constexpr double kSmoothTauSeconds = 0.02; // 20 ms glide
    static constexpr double kToneMinHz = 800.0;
    static constexpr double kToneMaxHz = 18000.0;

    static float sanitize(float v) noexcept { return std::isfinite(v) ? v : 0.0F; }

    int computeDelaySamples(double ms) const noexcept;
    static int analyticEchoTailRepeats(float feedback) noexcept;
    static double mapToneHz(float tone01) noexcept;
    float blockAlpha(int numSamples) const noexcept;

    template <typename T>
    static bool smoothToward(T& cur, T target, float alpha) noexcept
    {
        return dsp::smoothToward<T, false>(cur, target, alpha, static_cast<T>(1.0e-5));
    }

    float onePoleCoeff(double hz) const noexcept;
    void recomputeReverbToneCoeff() noexcept;
    void recomputeEchoToneCoeff() noexcept;

    void applyReverbParams() noexcept;
    void snapSmoothers() noexcept;
    static bool bufferHasSignal(const juce::AudioBuffer<float>& buf, int numSamples) noexcept;
    void resetDetectors() noexcept;
    void recomputeAnalyticTail() noexcept;
    void processReverb(const juce::AudioBuffer<float>& send, juce::AudioBuffer<float>& out,
                       int startSample, int numSamples, float alpha,
                       bool inputPresent) noexcept;
    void processEcho(const juce::AudioBuffer<float>& send, juce::AudioBuffer<float>& out,
                     int startSample, int numSamples, float alpha,
                     bool inputPresent) noexcept;
    void addWet(juce::AudioBuffer<float>& out, int startSample, int numSamples) noexcept;
    void updateReverbDetector(double sumSq, int numSamples, bool inputPresent) noexcept;
    void updateEchoDetector(double sumSq, int numSamples, int delaySamps,
                            bool inputPresent) noexcept;
    int silenceBlockTarget(int numSamples) const noexcept;
    void invalidateDelayBuffer() noexcept;

    // State.
    double sr = 44100.0;
    int maxBlock = 0;
    bool prepared = false;

    juce::Reverb reverb;
    std::vector<float> wetL, wetR;

    // Targets + control flags are published lock-free by the message thread; cur*/coeff/state
    // below are owned exclusively by the audio thread (or by prepare/clear with audio excluded).
    std::atomic<float> targetRoomSize{0.0F};
    std::atomic<float> targetDamping{1.0F};
    std::atomic<double> targetReverbToneHz{kToneMaxHz};
    std::atomic<float> targetReverbMix{0.0F};
    std::atomic<float> targetFeedback{0.0F};
    std::atomic<double> targetEchoToneHz{kToneMaxHz};
    std::atomic<float> targetEchoMix{0.0F};
    std::atomic<double> targetDelayMs{1.0};
    std::atomic<int> activeDelaySamples{1};
    std::atomic<int> analyticTailRepeats{1};

    std::atomic<bool> reverbSnapRequested{false};
    std::atomic<bool> echoSnapRequested{false};
    std::atomic<bool> applyDelayTimeRequested{false};
    std::atomic<bool> resetRequested{false};

    float curRoomSize = 0.0F;
    float curDamping = 1.0F;
    double curReverbToneHz = kToneMaxHz;
    float curReverbMix = 0.0F;
    float reverbToneCoeff = 1.0F;
    float reverbToneStateL = 0.0F, reverbToneStateR = 0.0F;
    float lastAppliedRoomSize = -1.0F, lastAppliedDamping = -1.0F;
    bool reverbParamsApplied = false;

    std::vector<float> delayBufL, delayBufR;
    std::vector<uint64_t> delayGeneration;
    uint64_t activeDelayGeneration = 1;
    int maxDelaySamples = 2;
    int delayWriteIdx = 0;
    float curFeedback = 0.0F;
    double curEchoToneHz = kToneMaxHz;
    float curEchoMix = 0.0F;
    float echoToneCoeff = 1.0F;
    float echoToneStateL = 0.0F, echoToneStateR = 0.0F;

    int reverbSilentBlocks = 0;
    int64_t reverbFramesSinceInput = 0;
    std::atomic<bool> reverbDone{false};
    int64_t echoFramesSinceInput = 0;
    std::atomic<bool> echoDone{false};
    static_assert(std::atomic<float>::is_always_lock_free && std::atomic<double>::is_always_lock_free
                      && std::atomic<int>::is_always_lock_free,
                  "SharedFx publishes params via lock-free atomics on the audio thread");
};

} // namespace silverdaw
