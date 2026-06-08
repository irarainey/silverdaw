#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <cmath>

namespace silverdaw
{

// Per-track Tone EQ owned by `TrackChain`; message-thread setters publish under the `BusGraph` lock.
// `process` stays allocation/lock/log free, and snap paths keep live/export startup parity.
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
    }

    /** Clears filter histories on stop/seek without changing targets. */
    void reset() noexcept { clearState(); }

    /** Message-thread setter under the `BusGraph` lock; `snap` preserves setup parity. */
    void setParams(float bassDb, float midDb, float trebleDb, bool lowCutOn,
                   bool highCutOn, bool snap) noexcept
    {
        targetBassDb = sanitizeDb(bassDb);
        targetMidDb = sanitizeDb(midDb);
        targetTrebleDb = sanitizeDb(trebleDb);
        targetLowCutHz = lowCutOn ? kLowCutOnHz : kLowCutOffHz;
        targetHighCutHz = highCutOn ? kHighCutOnHz : kHighCutOffHz;

        if (snap)
        {
            snapToTargets();
            if (prepared) recomputeCoeffs();
        }
    }

    void process(juce::AudioBuffer<float>& buffer, int startSample, int numSamples) noexcept
    {
        if (! prepared || numSamples <= 0) return;

        const float alpha = blockAlpha(numSamples);
        bool moved = false;
        moved |= smoothToward(curBassDb, targetBassDb, alpha);
        moved |= smoothToward(curMidDb, targetMidDb, alpha);
        moved |= smoothToward(curTrebleDb, targetTrebleDb, alpha);
        moved |= smoothToward(curLowCutHz, targetLowCutHz, alpha);
        moved |= smoothToward(curHighCutHz, targetHighCutHz, alpha);
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
    static constexpr float kLowCutOnHz = 120.0F;
    static constexpr float kLowCutOffHz = 0.0F;
    static constexpr float kLowCutIdentityHz = 12.0F;

    // High-cut mirrors low-cut; the high off-sentinel resolves to identity.
    static constexpr float kHighCutOnHz = 6000.0F;
    static constexpr float kHighCutOffHz = 24000.0F;
    static constexpr float kHighCutIdentityHz = 20000.0F;

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
        curBassDb = targetBassDb;
        curMidDb = targetMidDb;
        curTrebleDb = targetTrebleDb;
        curLowCutHz = targetLowCutHz;
        curHighCutHz = targetHighCutHz;
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

    float targetBassDb = 0.0F, targetMidDb = 0.0F, targetTrebleDb = 0.0F;
    float targetLowCutHz = kLowCutOffHz;
    float targetHighCutHz = kHighCutOffHz;

    float curBassDb = 0.0F, curMidDb = 0.0F, curTrebleDb = 0.0F;
    float curLowCutHz = kLowCutOffHz;
    float curHighCutHz = kHighCutOffHz;
};

} // namespace silverdaw
