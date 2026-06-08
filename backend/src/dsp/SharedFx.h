#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <cmath>
#include <cstdint>
#include <vector>

namespace silverdaw
{

// Shared delay-note resolver keeps live and export timing identical.
inline double delayNoteToMs(const juce::String& noteValue, double bpm) noexcept
{
    const double safeBpm = juce::jlimit(15.0, 999.0, (bpm > 0.0 && std::isfinite(bpm)) ? bpm : 120.0);
    double beats = 0.5; // 1/8 default
    if (noteValue == "1/4") beats = 1.0;
    else if (noteValue == "1/8") beats = 0.5;
    else if (noteValue == "1/8T") beats = 1.0 / 3.0;
    else if (noteValue == "1/16") beats = 0.25;
    return beats * 60000.0 / safeBpm;
}

// Shared wet-only Reverb/Delay processor; live and export share it for parity.
// All buffers are sized in `prepare`, and `process` must stay allocation/lock/log free.
// Tail detectors bound offline render after the dry send goes silent.
class SharedFx
{
public:
    SharedFx() = default;

    /** Sizes buffers outside the audio callback and clears decay state. */
    void prepare(double sampleRate, int maxBlockSize) noexcept
    {
        sr = (sampleRate > 0.0 && std::isfinite(sampleRate)) ? sampleRate : 44100.0;
        maxBlock = juce::jmax(1, maxBlockSize);

        wetL.assign(static_cast<size_t>(maxBlock), 0.0F);
        wetR.assign(static_cast<size_t>(maxBlock), 0.0F);

        maxDelaySamples = juce::jmax(2, static_cast<int>(std::ceil(kMaxDelayMs * sr / 1000.0)) + 1);
        delayBufL.assign(static_cast<size_t>(maxDelaySamples), 0.0F);
        delayBufR.assign(static_cast<size_t>(maxDelaySamples), 0.0F);

        reverb.setSampleRate(sr);
        recomputeReverbToneCoeff();
        recomputeEchoToneCoeff();
        snapSmoothers();
        prepared = true;
        reset();
    }

    /** Clears decay state on stop/seek and promotes staged delay time for the next cold start. */
    void reset() noexcept
    {
        reverb.reset();
        std::fill(delayBufL.begin(), delayBufL.end(), 0.0F);
        std::fill(delayBufR.begin(), delayBufR.end(), 0.0F);
        delayWriteIdx = 0;
        reverbToneStateL = reverbToneStateR = 0.0F;
        echoToneStateL = echoToneStateR = 0.0F;

        activeDelaySamples = pendingDelaySamples;

        resetDetectors();
    }

    /** `snap` gives load/mixdown/runtime setup a steady-state first block; live gestures glide. */
    void setReverbParams(float size, float decay, float tone, float mix, bool snap) noexcept
    {
        const float s = juce::jlimit(0.0F, 1.0F, sanitize(size));
        const float d = juce::jlimit(0.0F, 1.0F, sanitize(decay));
        // Keep Size and Decay independent so each knob has an obvious effect.
        targetRoomSize = juce::jlimit(0.0F, 1.0F, 0.05F + 0.92F * s);
        targetDamping = 1.0F - d;
        targetReverbToneHz = mapToneHz(juce::jlimit(0.0F, 1.0F, sanitize(tone)));
        targetReverbMix = juce::jlimit(0.0F, 1.0F, sanitize(mix));

        applyReverbParams();
        if (snap)
        {
            curRoomSize = targetRoomSize;
            curDamping = targetDamping;
            curReverbToneHz = targetReverbToneHz;
            curReverbMix = targetReverbMix;
            applyReverbParams();
            recomputeReverbToneCoeff();
            if (prepared) reverb.reset();
        }
    }

    /** `applyTimeNow` avoids live-time jumps; `snap` gives setup paths steady-state params. */
    void setDelayParams(double delayMs, float feedback, float tone, float mix, bool snap,
                        bool applyTimeNow) noexcept
    {
        const double clampedMs = juce::jlimit(1.0, kMaxDelayMs, std::isfinite(delayMs) ? delayMs : 1.0);
        pendingDelaySamples =
            juce::jlimit(1, maxDelaySamples - 1, static_cast<int>(std::round(clampedMs * sr / 1000.0)));
        if (applyTimeNow) activeDelaySamples = pendingDelaySamples;

        targetFeedback = juce::jlimit(0.0F, kMaxFeedback, sanitize(feedback));
        targetEchoToneHz = mapToneHz(juce::jlimit(0.0F, 1.0F, sanitize(tone)));
        targetEchoMix = juce::jlimit(0.0F, 1.0F, sanitize(mix));

        recomputeAnalyticTail();
        if (snap)
        {
            curFeedback = targetFeedback;
            curEchoToneHz = targetEchoToneHz;
            curEchoMix = targetEchoMix;
            recomputeEchoToneCoeff();
        }
    }

    void process(const juce::AudioBuffer<float>& reverbSend,
                 const juce::AudioBuffer<float>& delaySend,
                 juce::AudioBuffer<float>& out, int startSample, int numSamples) noexcept
    {
        if (! prepared || numSamples <= 0 || numSamples > maxBlock) return;
        if (out.getNumChannels() < 1) return;

        const float alpha = blockAlpha(numSamples);
        const bool reverbInputPresent = bufferHasSignal(reverbSend, numSamples);
        const bool delayInputPresent = bufferHasSignal(delaySend, numSamples);

        processReverb(reverbSend, out, startSample, numSamples, alpha, reverbInputPresent);
        processEcho(delaySend, out, startSample, numSamples, alpha, delayInputPresent);
    }

    /** True once the Reverb tail has decayed below audibility (§7.10). */
    bool reverbTerminated() const noexcept { return reverbDone; }
    /** True once the Delay tail has fully repeated out (§7.10). */
    bool echoTerminated() const noexcept { return echoDone; }
    /** True once **both** shared FX have terminated — the bus is silent. */
    bool bothTerminated() const noexcept { return reverbDone && echoDone; }

    SharedFx(const SharedFx&) = delete;
    SharedFx& operator=(const SharedFx&) = delete;

private:
    // Tunables for tail detection and smoothing.
    static constexpr double kMaxDelayMs = 4000.0;     // 1/4 note at 15 BPM (worst case)
    static constexpr float kMaxFeedback = 0.95F;      // loop gain < unity
    static constexpr float kRmsFloorLin = 0.001F;     // -60 dBFS
    static constexpr float kRmsRestartLin = 0.0014125F; // -57 dBFS (+3 dB hysteresis)
    static constexpr double kRoomCapSeconds = 8.0;
    static constexpr double kEchoCapSeconds = 4.0;
    static constexpr double kSilenceWindowMs = 50.0;  // Reverb RMS run + Delay hold pad
    static constexpr float kSignalEpsilon = 1.0e-7F;
    static constexpr double kSmoothTauSeconds = 0.02; // 20 ms glide
    static constexpr double kToneMinHz = 800.0;
    static constexpr double kToneMaxHz = 18000.0;

    static float sanitize(float v) noexcept { return std::isfinite(v) ? v : 0.0F; }

    // Log mapping makes the tone knob feel even across octaves.
    static double mapToneHz(float tone01) noexcept
    {
        const double t = juce::jlimit(0.0, 1.0, static_cast<double>(tone01));
        return kToneMinHz * std::pow(kToneMaxHz / kToneMinHz, t);
    }

    float blockAlpha(int numSamples) const noexcept
    {
        const double a = std::exp(-static_cast<double>(numSamples) / (kSmoothTauSeconds * sr));
        return static_cast<float>(juce::jlimit(0.0, 1.0, a));
    }

    template <typename T>
    static bool smoothToward(T& cur, T target, float alpha) noexcept
    {
        if (std::abs(target - cur) < static_cast<T>(1.0e-5))
        {
            cur = target;
            return false;
        }
        cur = target + (cur - target) * static_cast<T>(alpha);
        return true;
    }

    float onePoleCoeff(double hz) const noexcept
    {
        const double f = juce::jlimit(20.0, sr * 0.49, hz);
        const double x = std::exp(-2.0 * juce::MathConstants<double>::pi * f / sr);
        return static_cast<float>(juce::jlimit(0.0, 1.0, 1.0 - x));
    }

    void recomputeReverbToneCoeff() noexcept { reverbToneCoeff = onePoleCoeff(curReverbToneHz); }
    void recomputeEchoToneCoeff() noexcept { echoToneCoeff = onePoleCoeff(curEchoToneHz); }

    void applyReverbParams() noexcept
    {
        const float roomSize = juce::jlimit(0.0F, 1.0F, curRoomSize);
        const float damping = juce::jlimit(0.0F, 1.0F, curDamping);
        if (reverbParamsApplied && juce::approximatelyEqual(roomSize, lastAppliedRoomSize)
            && juce::approximatelyEqual(damping, lastAppliedDamping))
            return; // skip redundant smoother re-targeting when nothing changed

        juce::Reverb::Parameters p;
        p.roomSize = roomSize;
        p.damping = damping;
        p.wetLevel = 1.0F; // fully wet; the Mix knob is applied as our own return gain
        p.dryLevel = 0.0F;
        p.width = 1.0F;
        p.freezeMode = 0.0F;
        reverb.setParameters(p);
        lastAppliedRoomSize = roomSize;
        lastAppliedDamping = damping;
        reverbParamsApplied = true;
    }

    void snapSmoothers() noexcept
    {
        curRoomSize = targetRoomSize;
        curDamping = targetDamping;
        curReverbToneHz = targetReverbToneHz;
        curReverbMix = targetReverbMix;
        curFeedback = targetFeedback;
        curEchoToneHz = targetEchoToneHz;
        curEchoMix = targetEchoMix;
        applyReverbParams();
        recomputeReverbToneCoeff();
        recomputeEchoToneCoeff();
    }

    static bool bufferHasSignal(const juce::AudioBuffer<float>& buf, int numSamples) noexcept
    {
        const int nCh = juce::jmin(2, buf.getNumChannels());
        for (int ch = 0; ch < nCh; ++ch)
            if (buf.getMagnitude(ch, 0, numSamples) > kSignalEpsilon) return true;
        return false;
    }

    void resetDetectors() noexcept
    {
        reverbSilentBlocks = 0;
        reverbFramesSinceInput = 0;
        reverbDone = false;
        echoFramesSinceInput = 0;
        echoDone = false;
    }

    void recomputeAnalyticTail() noexcept
    {
        // Feedback is clamped below unity, so the analytic tail log stays finite.
        const double fb = juce::jlimit(0.0, static_cast<double>(kMaxFeedback), static_cast<double>(targetFeedback));
        if (fb <= 1.0e-4)
        {
            analyticTailRepeats = 1; // effectively a single slap
            return;
        }
        const double n = std::ceil(std::log(static_cast<double>(kRmsFloorLin)) / std::log(fb));
        analyticTailRepeats = juce::jlimit(1, 4096, static_cast<int>(n));
    }

    void processReverb(const juce::AudioBuffer<float>& send, juce::AudioBuffer<float>& out,
                       int startSample, int numSamples, float alpha, bool inputPresent) noexcept
    {
        smoothToward(curRoomSize, targetRoomSize, alpha);
        smoothToward(curDamping, targetDamping, alpha);
        if (smoothToward(curReverbToneHz, targetReverbToneHz, alpha)) recomputeReverbToneCoeff();
        smoothToward(curReverbMix, targetReverbMix, alpha);
        applyReverbParams();

        const int sendCh = send.getNumChannels();
        const float* inL = sendCh > 0 ? send.getReadPointer(0) : nullptr;
        const float* inR = sendCh > 1 ? send.getReadPointer(1) : inL;
        for (int i = 0; i < numSamples; ++i)
        {
            wetL[static_cast<size_t>(i)] = inL ? inL[i] : 0.0F;
            wetR[static_cast<size_t>(i)] = inR ? inR[i] : 0.0F;
        }

        reverb.processStereo(wetL.data(), wetR.data(), numSamples);

        // Accumulate post-mix RMS so the detector follows the audible return.
        double sumSq = 0.0;
        const float mix = curReverbMix;
        for (int i = 0; i < numSamples; ++i)
        {
            reverbToneStateL += reverbToneCoeff * (wetL[static_cast<size_t>(i)] - reverbToneStateL);
            reverbToneStateR += reverbToneCoeff * (wetR[static_cast<size_t>(i)] - reverbToneStateR);
            const float l = reverbToneStateL * mix;
            const float r = reverbToneStateR * mix;
            wetL[static_cast<size_t>(i)] = l;
            wetR[static_cast<size_t>(i)] = r;
            sumSq += static_cast<double>(l) * l + static_cast<double>(r) * r;
        }

        addWet(out, startSample, numSamples);
        updateReverbDetector(sumSq, numSamples, inputPresent);
    }

    void processEcho(const juce::AudioBuffer<float>& send, juce::AudioBuffer<float>& out,
                     int startSample, int numSamples, float alpha, bool inputPresent) noexcept
    {
        smoothToward(curFeedback, targetFeedback, alpha);
        if (smoothToward(curEchoToneHz, targetEchoToneHz, alpha)) recomputeEchoToneCoeff();
        smoothToward(curEchoMix, targetEchoMix, alpha);

        const int sendCh = send.getNumChannels();
        const float* inL = sendCh > 0 ? send.getReadPointer(0) : nullptr;
        const float* inR = sendCh > 1 ? send.getReadPointer(1) : inL;
        const int delaySamps = juce::jlimit(1, maxDelaySamples - 1, activeDelaySamples);
        const float fb = curFeedback;
        const float mix = curEchoMix;

        double sumSq = 0.0;
        for (int i = 0; i < numSamples; ++i)
        {
            int readIdx = delayWriteIdx - delaySamps;
            if (readIdx < 0) readIdx += maxDelaySamples;

            const float delayedL = delayBufL[static_cast<size_t>(readIdx)];
            const float delayedR = delayBufR[static_cast<size_t>(readIdx)];

            echoToneStateL += echoToneCoeff * (delayedL - echoToneStateL);
            echoToneStateR += echoToneCoeff * (delayedR - echoToneStateR);

            const float dryL = inL ? inL[i] : 0.0F;
            const float dryR = inR ? inR[i] : 0.0F;
            delayBufL[static_cast<size_t>(delayWriteIdx)] = dryL + fb * echoToneStateL;
            delayBufR[static_cast<size_t>(delayWriteIdx)] = dryR + fb * echoToneStateR;

            if (++delayWriteIdx >= maxDelaySamples) delayWriteIdx = 0;

            const float l = delayedL * mix;
            const float r = delayedR * mix;
            wetL[static_cast<size_t>(i)] = l;
            wetR[static_cast<size_t>(i)] = r;
            sumSq += static_cast<double>(l) * l + static_cast<double>(r) * r;
        }

        addWet(out, startSample, numSamples);
        updateEchoDetector(sumSq, numSamples, delaySamps, inputPresent);
    }

    void addWet(juce::AudioBuffer<float>& out, int startSample, int numSamples) noexcept
    {
        const int outCh = out.getNumChannels();
        if (outCh > 0) out.addFrom(0, startSample, wetL.data(), numSamples);
        if (outCh > 1) out.addFrom(1, startSample, wetR.data(), numSamples);
    }

    void updateReverbDetector(double sumSq, int numSamples, bool inputPresent) noexcept
    {
        if (inputPresent) reverbFramesSinceInput = 0;
        else reverbFramesSinceInput += numSamples;

        const float rms = static_cast<float>(std::sqrt(sumSq / (2.0 * numSamples)));
        const int n = silenceBlockTarget(numSamples);
        if (rms < kRmsFloorLin)
        {
            if (reverbSilentBlocks < n) ++reverbSilentBlocks;
        }
        else if (rms > kRmsRestartLin)
        {
            reverbSilentBlocks = 0;
        }

        const bool decayed = reverbSilentBlocks >= n;
        const bool capped = reverbFramesSinceInput >= static_cast<int64_t>(kRoomCapSeconds * sr);
        reverbDone = decayed || capped;
    }

    void updateEchoDetector(double sumSq, int numSamples, int delaySamps, bool inputPresent) noexcept
    {
        if (inputPresent) echoFramesSinceInput = 0;
        else echoFramesSinceInput += numSamples;

        const float rms = static_cast<float>(std::sqrt(sumSq / (2.0 * numSamples)));
        const int64_t holdFrames =
            static_cast<int64_t>(delaySamps) + static_cast<int64_t>(kSilenceWindowMs * sr / 1000.0);
        const int64_t analyticFrames = static_cast<int64_t>(analyticTailRepeats) * delaySamps;
        const int64_t requiredFrames = juce::jmax(holdFrames, analyticFrames);
        const int64_t capFrames = static_cast<int64_t>(kEchoCapSeconds * sr);

        const bool rmsSilent = rms < kRmsFloorLin;
        const bool repeatAwareDone = rmsSilent && echoFramesSinceInput >= requiredFrames;
        const bool capped = echoFramesSinceInput >= capFrames;
        echoDone = repeatAwareDone || capped;
    }

    int silenceBlockTarget(int numSamples) const noexcept
    {
        const double blockMs = 1000.0 * numSamples / sr;
        return juce::jmax(1, static_cast<int>(std::ceil(kSilenceWindowMs / juce::jmax(1.0e-3, blockMs))));
    }

    // State.
    double sr = 44100.0;
    int maxBlock = 0;
    bool prepared = false;

    juce::Reverb reverb;
    std::vector<float> wetL, wetR;

    float targetRoomSize = 0.0F, curRoomSize = 0.0F;
    float targetDamping = 1.0F, curDamping = 1.0F;
    double targetReverbToneHz = kToneMaxHz, curReverbToneHz = kToneMaxHz;
    float targetReverbMix = 0.0F, curReverbMix = 0.0F;
    float reverbToneCoeff = 1.0F;
    float reverbToneStateL = 0.0F, reverbToneStateR = 0.0F;
    float lastAppliedRoomSize = -1.0F, lastAppliedDamping = -1.0F;
    bool reverbParamsApplied = false;

    std::vector<float> delayBufL, delayBufR;
    int maxDelaySamples = 2;
    int delayWriteIdx = 0;
    int activeDelaySamples = 1;
    int pendingDelaySamples = 1;
    float targetFeedback = 0.0F, curFeedback = 0.0F;
    double targetEchoToneHz = kToneMaxHz, curEchoToneHz = kToneMaxHz;
    float targetEchoMix = 0.0F, curEchoMix = 0.0F;
    float echoToneCoeff = 1.0F;
    float echoToneStateL = 0.0F, echoToneStateR = 0.0F;
    int analyticTailRepeats = 1;

    int reverbSilentBlocks = 0;
    int64_t reverbFramesSinceInput = 0;
    bool reverbDone = false;
    int64_t echoFramesSinceInput = 0;
    bool echoDone = false;
};

} // namespace silverdaw
