#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <cmath>

namespace silverdaw
{

/**
 * Per-track "Tone" EQ — the simple, fixed-frequency 3-band tilt + low-cut
 * documented in §7.9.3 / §7.10 of `.ref/daw-design-plan.md`. Deliberately
 * NOT a parametric EQ: three musical bands (Bass / Mid / Treble) plus a
 * one-button Low Cut, matching the GarageBand-style simplicity ethos.
 *
 *   Bass   = low  shelf @ 250 Hz   (-15..+15 dB)
 *   Mid    = peak       @ 1 kHz    (-15..+15 dB, fixed Q)
 *   Treble = high shelf @ 4 kHz    (-15..+15 dB)
 *   LowCut = 4th-order Butterworth high-pass @ 120 Hz, 24 dB/oct (toggle)
 *   HighCut= 4th-order Butterworth low-pass  @ 6 kHz, 24 dB/oct (toggle)
 *
 * **Threading.** This object is owned by `TrackChain`, which is driven by
 * the audio thread inside `BusGraph::getNextAudioBlock`. Parameter updates
 * (`setParams`) arrive from the message thread but always under the same
 * `BusGraph` CriticalSection the audio thread holds while calling
 * `process` — so the plain (non-atomic) target members are race-free
 * without extra synchronisation. `setParams` only stores the targets; all
 * trig-heavy coefficient recomputation happens on the audio thread inside
 * `process`, so the message thread never blocks on DSP math.
 *
 * **Realtime safety.** No allocation, locking, or logging in `process`.
 * Coefficients are recomputed only while a smoothed parameter is still
 * moving toward its target. Targets are smoothed per-block with a
 * block-size-independent one-pole coefficient so drag gestures don't
 * zipper. `setParams(..., snap=true)` collapses the smoother instantly —
 * used for project load / mixdown setup / newly-created runtimes so the
 * offline export starts at the steady-state response (no ramp-from-flat
 * divergence between live and export).
 */
class ToneEq
{
public:
    ToneEq() = default;

    /** Size internal state and snap the smoother to the current targets.
     *  Re-called whenever sample rate / channel count changes. */
    void prepare(double sampleRate, int numChannels) noexcept
    {
        sr = (sampleRate > 0.0 && std::isfinite(sampleRate)) ? sampleRate : 44100.0;
        channels = juce::jlimit(1, kMaxChannels, numChannels);
        snapToTargets();
        clearState();
        prepared = true;
        recomputeCoeffs();
    }

    /** Clear filter histories (transport stop / catastrophic seek). Keeps
     *  coefficients and targets intact. */
    void reset() noexcept { clearState(); }

    /**
     * Publish new tone targets. Called on the message thread under the
     * owning `BusGraph` lock. `snap` collapses the smoother so the new
     * response is in effect on the very next block (load / mixdown /
     * runtime-creation paths use this for live↔export parity); the live
     * UI-gesture path passes `snap=false` to glide.
     */
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

    /** In-place per-block processing over `[startSample, startSample+numSamples)`. */
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

    // Fixed band centres / type-specific Q (see class doc). Corners are
    // pulled in from the spectral extremes (Bass 120→250 Hz, Treble
    // 6k→4k) so each band acts on audible low-mid body / presence rather
    // than only sub-bass and air, giving the controls obvious impact.
    static constexpr double kBassHz = 250.0;
    static constexpr double kMidHz = 1000.0;
    static constexpr double kTrebleHz = 4000.0;
    static constexpr double kShelfSlope = 1.0;       // S=1, maximally flat shelf
    static constexpr double kMidQ = 0.9;             // gentle musical peak
    // Low Cut and High Cut are 4th-order Butterworth filters, each realised
    // as two cascaded 2nd-order sections; these are the Butterworth section
    // Qs that combine to a maximally-flat 24 dB/oct response (no resonant
    // bump at the corner). Shared by both the high-pass and low-pass designs.
    static constexpr double kButterQ1 = 0.54119610;
    static constexpr double kButterQ2 = 1.30656296;

    // Low-cut is a 4th-order high-pass (two cascaded biquads) whose corner
    // glides instead of being switched in/out — that avoids the comb/phase
    // coloration a dry/wet blend would cause and the click a cold-state
    // enable would cause. "Off" parks the corner at the identity sentinel
    // (0 Hz) so a flat, low-cut-off track is bit-exact passthrough (preserves
    // the §7.9.6 parity guarantee); enabling glides the corner up to 120 Hz.
    // Corners at/below kLowCutIdentityHz resolve to true identity coefficients
    // — a ~12 Hz high-pass is already inaudible, so the tiny step to exact
    // identity at the bottom of the glide is imperceptible.
    static constexpr float kLowCutOnHz = 120.0F;
    static constexpr float kLowCutOffHz = 0.0F;
    static constexpr float kLowCutIdentityHz = 12.0F;

    // High-cut mirrors low-cut but as a 4th-order low-pass. "Off" parks the
    // corner at a high sentinel (above the audible band) which resolves to
    // identity, so a flat, high-cut-off track is bit-exact passthrough
    // (preserves the §7.9.6 parity guarantee); enabling glides the corner
    // down to 6 kHz. Corners at/above kHighCutIdentityHz resolve to true
    // identity coefficients — a >20 kHz low-pass is already inaudible, so the
    // tiny step to exact identity at the top of the glide is imperceptible.
    static constexpr float kHighCutOnHz = 6000.0F;
    static constexpr float kHighCutOffHz = 24000.0F;
    static constexpr float kHighCutIdentityHz = 20000.0F;

    static constexpr float kDbEpsilon = 1.0e-3F;
    static constexpr double kSmoothTauSeconds = 0.02; // 20 ms glide

    /** One stereo biquad: shared coefficients, per-channel Transposed
     *  Direct-Form II state. */
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
        // Per-block one-pole retention factor. Independent of block size:
        // a larger block advances the glide proportionally further.
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

    // ── RBJ Audio-EQ-Cookbook biquad designs (normalised by a0) ───────

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

        // RBJ high-pass numerator uses (1 + cos w0). Using (1 - cos w0) here
        // would yield a LOW-pass — i.e. "Low Cut" would strip everything
        // ABOVE the corner and leave only sub-bass, sounding like a mute.
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

        // RBJ low-pass numerator uses (1 - cos w0) — the mirror image of the
        // high-pass. This is "High Cut": it passes lows and removes highs.
        f.setNormalized(oneMinusCw / 2.0, oneMinusCw, oneMinusCw / 2.0,
                        1.0 + alpha, -2.0 * cw, 1.0 - alpha);
    }

    double omega(double freq) const noexcept
    {
        // Keep the corner safely below Nyquist for any supported rate.
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
