#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <atomic>
#include <cmath>

namespace silverdaw
{

// Per-track Tone EQ owned by `TrackChain`. Setters publish targets lock-free (atomics +
// a release `snapRequested` flag) so the message thread never blocks the audio callback;
// `process` consumes the flag and owns all coefficient recompute. Snap defers to the next
// `process` block, preserving live/export startup parity (the first block is steady-state).
class ToneEq
{
public:
    ToneEq() = default;

    /** Recalled on sample-rate or channel-count changes. */
    void prepare(double sampleRate, int numChannels) noexcept
    {
        sr = (sampleRate > 0.0 && std::isfinite(sampleRate)) ? sampleRate : 44100.0;
        channels = juce::jlimit(1, kMaxChannels, numChannels);
        snapToTargets();
        clearState();
        prepared = true;
        recomputeCoeffs();
        snapRequested.store(false, std::memory_order_relaxed);
    }

    /** Clears filter histories on stop/seek without changing targets. */
    void reset() noexcept { clearState(); }

    /** Lock-free message-thread setter; publishes targets and (on snap) a deferred snap flag.
     *  `filter` is the bipolar DJ-style sweep in `[-1, +1]`: negative engages the low-pass
     *  (High Cut), positive engages the high-pass (Low Cut), centre (0) is transparent. */
    void setParams(float bassDb, float midDb, float trebleDb, float filter, bool snap) noexcept
    {
        targetBassDb.store(sanitizeDb(bassDb), std::memory_order_relaxed);
        targetMidDb.store(sanitizeDb(midDb), std::memory_order_relaxed);
        targetTrebleDb.store(sanitizeDb(trebleDb), std::memory_order_relaxed);

        float lowCutHz = kLowCutOffHz;
        float highCutHz = kHighCutOffHz;
        filterToCorners(filter, lowCutHz, highCutHz);
        targetLowCutHz.store(lowCutHz, std::memory_order_relaxed);
        targetHighCutHz.store(highCutHz, std::memory_order_relaxed);

        // Release pairs with the acquire in `process`, so a consumed snap also sees the targets.
        if (snap) snapRequested.store(true, std::memory_order_release);
    }

    void process(juce::AudioBuffer<float>& buffer, int startSample, int numSamples) noexcept
    {
        if (! prepared || numSamples <= 0) return;

        if (snapRequested.exchange(false, std::memory_order_acquire))
        {
            snapToTargets();
            recomputeCoeffs();
        }

        const float alpha = blockAlpha(numSamples);
        bool moved = false;
        moved |= smoothToward(curBassDb, targetBassDb.load(std::memory_order_relaxed), alpha);
        moved |= smoothToward(curMidDb, targetMidDb.load(std::memory_order_relaxed), alpha);
        moved |= smoothToward(curTrebleDb, targetTrebleDb.load(std::memory_order_relaxed), alpha);
        moved |= smoothToward(curLowCutHz, targetLowCutHz.load(std::memory_order_relaxed), alpha);
        moved |= smoothToward(curHighCutHz, targetHighCutHz.load(std::memory_order_relaxed), alpha);
        if (moved) recomputeCoeffs();

        const int nCh = juce::jmin(buffer.getNumChannels(), channels);
        for (int ch = 0; ch < nCh; ++ch)
        {
            float* data = buffer.getWritePointer(ch);
            for (int i = 0; i < numSamples; ++i)
            {
                const int idx = startSample + i;
                float x = data[idx];
                x = bass.process(ch, x);
                x = mid.process(ch, x);
                x = treble.process(ch, x);
                x = lowCut1.process(ch, x);
                x = lowCut2.process(ch, x);
                x = highCut1.process(ch, x);
                x = highCut2.process(ch, x);
                data[idx] = x;
            }
        }
    }

private:
    static constexpr int kMaxChannels = 2;

    // Corners target audible body/presence rather than only spectral extremes.
    static constexpr double kBassHz = 250.0;
    static constexpr double kMidHz = 1000.0;
    static constexpr double kTrebleHz = 4000.0;
    static constexpr double kShelfSlope = 1.0;       // S=1, maximally flat shelf
    static constexpr double kMidQ = 0.9;             // gentle musical peak
    // Butterworth section Qs avoid a resonant bump at the cutoff.
    static constexpr double kButterQ1 = 0.54119610;
    static constexpr double kButterQ2 = 1.30656296;

    // Glide the corner instead of dry/wet blending to avoid clicks and combing; off resolves to identity.
    static constexpr float kLowCutOffHz = 0.0F;
    static constexpr float kLowCutIdentityHz = 12.0F;

    // High-cut mirrors low-cut; the high off-sentinel resolves to identity.
    static constexpr float kHighCutOffHz = 24000.0F;
    static constexpr float kHighCutIdentityHz = 20000.0F;

    // Bipolar DJ-style Filter sweep endpoints. A single control engages one
    // corner at a time and parks the other at its off sentinel:
    //   filter > 0 → high-pass (Low Cut)  corner glides kHpfMinHz → kHpfMaxHz
    //   filter < 0 → low-pass  (High Cut) corner glides kLpfMaxHz → kLpfMinHz
    // The exponential map keeps perceptually even steps across the throw.
    static constexpr float kHpfMinHz = 20.0F;
    static constexpr float kHpfMaxHz = 2000.0F;
    static constexpr float kLpfMinHz = 250.0F;
    static constexpr float kLpfMaxHz = 20000.0F;
    static constexpr float kFilterEpsilon = 1.0e-3F;

    static constexpr float kDbEpsilon = 1.0e-3F;
    static constexpr double kSmoothTauSeconds = 0.02; // 20 ms glide

    struct Biquad
    {
        float b0 = 1.0F, b1 = 0.0F, b2 = 0.0F, a1 = 0.0F, a2 = 0.0F;
        float z1[kMaxChannels] = {0.0F, 0.0F};
        float z2[kMaxChannels] = {0.0F, 0.0F};

        inline float process(int ch, float x) noexcept
        {
            const float y = b0 * x + z1[ch];
            z1[ch] = b1 * x - a1 * y + z2[ch];
            z2[ch] = b2 * x - a2 * y;
            return y;
        }

        void setIdentity() noexcept
        {
            b0 = 1.0F;
            b1 = 0.0F;
            b2 = 0.0F;
            a1 = 0.0F;
            a2 = 0.0F;
        }

        void setNormalized(double nb0, double nb1, double nb2, double a0, double na1,
                           double na2) noexcept
        {
            if (! (std::isfinite(a0)) || std::abs(a0) < 1.0e-12) { setIdentity(); return; }
            const double inv = 1.0 / a0;
            b0 = static_cast<float>(nb0 * inv);
            b1 = static_cast<float>(nb1 * inv);
            b2 = static_cast<float>(nb2 * inv);
            a1 = static_cast<float>(na1 * inv);
            a2 = static_cast<float>(na2 * inv);
            if (! (std::isfinite(b0) && std::isfinite(b1) && std::isfinite(b2)
                   && std::isfinite(a1) && std::isfinite(a2)))
                setIdentity();
        }

        void clear() noexcept
        {
            for (int c = 0; c < kMaxChannels; ++c)
            {
                z1[c] = 0.0F;
                z2[c] = 0.0F;
            }
        }
    };

    static float sanitizeDb(float db) noexcept
    {
        if (! std::isfinite(db)) return 0.0F;
        return juce::jlimit(-15.0F, 15.0F, db);
    }

    // Maps the bipolar Filter control to the corner-frequency pair the biquads
    // consume. Only one side is ever engaged; the other parks at its off
    // sentinel so the unused stage resolves to identity in `recomputeCoeffs`.
    static void filterToCorners(float filter, float& lowCutHz, float& highCutHz) noexcept
    {
        const float f = std::isfinite(filter) ? juce::jlimit(-1.0F, 1.0F, filter) : 0.0F;
        if (f > kFilterEpsilon)
        {
            lowCutHz = kHpfMinHz * std::pow(kHpfMaxHz / kHpfMinHz, f);
            highCutHz = kHighCutOffHz;
        }
        else if (f < -kFilterEpsilon)
        {
            highCutHz = kLpfMaxHz * std::pow(kLpfMinHz / kLpfMaxHz, -f);
            lowCutHz = kLowCutOffHz;
        }
        else
        {
            lowCutHz = kLowCutOffHz;
            highCutHz = kHighCutOffHz;
        }
    }

    float blockAlpha(int numSamples) const noexcept
    {
        // Block-size-independent glide.
        const double a = std::exp(-static_cast<double>(numSamples)
                                  / (kSmoothTauSeconds * sr));
        return static_cast<float>(juce::jlimit(0.0, 1.0, a));
    }

    static bool smoothToward(float& cur, float target, float alpha) noexcept
    {
        if (std::abs(target - cur) < 1.0e-4F)
        {
            if (cur != target)
            {
                cur = target; // settle exactly to avoid endless tiny recomputes
                return true;
            }
            return false;
        }
        cur = target + (cur - target) * alpha;
        return true;
    }

    void snapToTargets() noexcept
    {
        curBassDb = targetBassDb.load(std::memory_order_relaxed);
        curMidDb = targetMidDb.load(std::memory_order_relaxed);
        curTrebleDb = targetTrebleDb.load(std::memory_order_relaxed);
        curLowCutHz = targetLowCutHz.load(std::memory_order_relaxed);
        curHighCutHz = targetHighCutHz.load(std::memory_order_relaxed);
    }

    void clearState() noexcept
    {
        bass.clear();
        mid.clear();
        treble.clear();
        lowCut1.clear();
        lowCut2.clear();
        highCut1.clear();
        highCut2.clear();
    }

    void recomputeCoeffs() noexcept
    {
        designLowShelf(bass, kBassHz, curBassDb);
        designPeak(mid, kMidHz, curMidDb);
        designHighShelf(treble, kTrebleHz, curTrebleDb);
        if (curLowCutHz > kLowCutIdentityHz)
        {
            designHighPass(lowCut1, static_cast<double>(curLowCutHz), kButterQ1);
            designHighPass(lowCut2, static_cast<double>(curLowCutHz), kButterQ2);
        }
        else
        {
            lowCut1.setIdentity();
            lowCut2.setIdentity();
        }
        if (curHighCutHz < kHighCutIdentityHz)
        {
            designLowPass(highCut1, static_cast<double>(curHighCutHz), kButterQ1);
            designLowPass(highCut2, static_cast<double>(curHighCutHz), kButterQ2);
        }
        else
        {
            highCut1.setIdentity();
            highCut2.setIdentity();
        }
    }

    void designPeak(Biquad& f, double freq, float gainDb) noexcept
    {
        if (std::abs(gainDb) < kDbEpsilon) { f.setIdentity(); return; }
        const double w0 = omega(freq);
        const double cw = std::cos(w0);
        const double sw = std::sin(w0);
        const double A = std::pow(10.0, gainDb / 40.0);
        const double alpha = sw / (2.0 * kMidQ);

        f.setNormalized(1.0 + alpha * A, -2.0 * cw, 1.0 - alpha * A,
                        1.0 + alpha / A, -2.0 * cw, 1.0 - alpha / A);
    }

    void designLowShelf(Biquad& f, double freq, float gainDb) noexcept
    {
        if (std::abs(gainDb) < kDbEpsilon) { f.setIdentity(); return; }
        const double w0 = omega(freq);
        const double cw = std::cos(w0);
        const double sw = std::sin(w0);
        const double A = std::pow(10.0, gainDb / 40.0);
        const double alpha = (sw / 2.0)
            * std::sqrt((A + 1.0 / A) * (1.0 / kShelfSlope - 1.0) + 2.0);
        const double twoSqrtAAlpha = 2.0 * std::sqrt(A) * alpha;

        f.setNormalized(A * ((A + 1.0) - (A - 1.0) * cw + twoSqrtAAlpha),
                        2.0 * A * ((A - 1.0) - (A + 1.0) * cw),
                        A * ((A + 1.0) - (A - 1.0) * cw - twoSqrtAAlpha),
                        (A + 1.0) + (A - 1.0) * cw + twoSqrtAAlpha,
                        -2.0 * ((A - 1.0) + (A + 1.0) * cw),
                        (A + 1.0) + (A - 1.0) * cw - twoSqrtAAlpha);
    }

    void designHighShelf(Biquad& f, double freq, float gainDb) noexcept
    {
        if (std::abs(gainDb) < kDbEpsilon) { f.setIdentity(); return; }
        const double w0 = omega(freq);
        const double cw = std::cos(w0);
        const double sw = std::sin(w0);
        const double A = std::pow(10.0, gainDb / 40.0);
        const double alpha = (sw / 2.0)
            * std::sqrt((A + 1.0 / A) * (1.0 / kShelfSlope - 1.0) + 2.0);
        const double twoSqrtAAlpha = 2.0 * std::sqrt(A) * alpha;

        f.setNormalized(A * ((A + 1.0) + (A - 1.0) * cw + twoSqrtAAlpha),
                        -2.0 * A * ((A - 1.0) + (A + 1.0) * cw),
                        A * ((A + 1.0) + (A - 1.0) * cw - twoSqrtAAlpha),
                        (A + 1.0) - (A - 1.0) * cw + twoSqrtAAlpha,
                        2.0 * ((A - 1.0) - (A + 1.0) * cw),
                        (A + 1.0) - (A - 1.0) * cw - twoSqrtAAlpha);
    }

    void designHighPass(Biquad& f, double freq, double q) noexcept
    {
        const double w0 = omega(freq);
        const double cw = std::cos(w0);
        const double sw = std::sin(w0);
        const double alpha = sw / (2.0 * q);
        const double onePlusCw = 1.0 + cw;

        // High-pass needs (1 + cos w0); the low-pass numerator would invert Low Cut.
        f.setNormalized(onePlusCw / 2.0, -onePlusCw, onePlusCw / 2.0,
                        1.0 + alpha, -2.0 * cw, 1.0 - alpha);
    }

    void designLowPass(Biquad& f, double freq, double q) noexcept
    {
        const double w0 = omega(freq);
        const double cw = std::cos(w0);
        const double sw = std::sin(w0);
        const double alpha = sw / (2.0 * q);
        const double oneMinusCw = 1.0 - cw;

        // Low-pass mirrors the high-pass numerator for High Cut.
        f.setNormalized(oneMinusCw / 2.0, oneMinusCw, oneMinusCw / 2.0,
                        1.0 + alpha, -2.0 * cw, 1.0 - alpha);
    }

    double omega(double freq) const noexcept
    {
        // Keep the corner safely below Nyquist.
        const double f = juce::jlimit(1.0, sr * 0.49, freq);
        return 2.0 * juce::MathConstants<double>::pi * f / sr;
    }

    Biquad bass, mid, treble, lowCut1, lowCut2, highCut1, highCut2;

    double sr = 44100.0;
    int channels = 2;
    bool prepared = false;

    // Targets published lock-free by the message thread; consumed by `process` on the audio thread.
    std::atomic<float> targetBassDb{0.0F};
    std::atomic<float> targetMidDb{0.0F};
    std::atomic<float> targetTrebleDb{0.0F};
    std::atomic<float> targetLowCutHz{kLowCutOffHz};
    std::atomic<float> targetHighCutHz{kHighCutOffHz};
    std::atomic<bool> snapRequested{false};

    float curBassDb = 0.0F, curMidDb = 0.0F, curTrebleDb = 0.0F;
    float curLowCutHz = kLowCutOffHz;
    float curHighCutHz = kHighCutOffHz;

    static_assert(std::atomic<float>::is_always_lock_free,
                  "ToneEq publishes params via lock-free atomics on the audio thread");
};

} // namespace silverdaw
