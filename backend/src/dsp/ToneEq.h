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
    void prepare(double sampleRate, int numChannels) noexcept;

    /** Clears filter histories on stop/seek without changing targets. */
    void reset() noexcept;

    /** Lock-free message-thread setter; publishes targets and (on snap) a deferred snap flag.
     *  `filter` is the bipolar DJ-style sweep in `[-1, +1]`: negative engages the low-pass
     *  (High Cut), positive engages the high-pass (Low Cut), centre (0) is transparent. */
    void setParams(float bassDb, float midDb, float trebleDb, float filter, bool snap) noexcept;

    /** Audio-thread-safe filter-only target update for per-track automation. Touches only the
     *  filter corners (not bass/mid/treble), so a curve can sweep the Filter while the manual
     *  EQ stays put. `snap` is set on a transport discontinuity (seek/loop) so the sweep jumps
     *  to the curve value instead of gliding the 20 ms smoother across the jump. */
    void setFilterTarget(float filter, bool snap) noexcept;

    /** Audio-thread per-band dB automation (touches one shelf/peak target only). */
    void setBassTarget(float db, bool snap) noexcept { targetBassDb.store(sanitizeDb(db), std::memory_order_relaxed); if (snap) snapRequested.store(true, std::memory_order_release); }
    void setMidTarget(float db, bool snap) noexcept { targetMidDb.store(sanitizeDb(db), std::memory_order_relaxed); if (snap) snapRequested.store(true, std::memory_order_release); }
    void setTrebleTarget(float db, bool snap) noexcept { targetTrebleDb.store(sanitizeDb(db), std::memory_order_relaxed); if (snap) snapRequested.store(true, std::memory_order_release); }

    void process(juce::AudioBuffer<float>& buffer, int startSample, int numSamples) noexcept;

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
                           double na2) noexcept;

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

    static bool isNeutralState(float bassDb, float midDb, float trebleDb,
                               float lowCutHz, float highCutHz) noexcept;
    // Maps the bipolar Filter control to the corner-frequency pair the biquads
    // consume. Only one side is ever engaged; the other parks at its off
    // sentinel so the unused stage resolves to identity in `recomputeCoeffs`.
    static void filterToCorners(float filter, float& lowCutHz, float& highCutHz) noexcept;
    static bool smoothToward(float& cur, float target, float alpha) noexcept;
    void snapToTargets() noexcept;
    void clearState() noexcept;
    void recomputeCoeffs() noexcept;
    void designPeak(Biquad& f, double freq, float gainDb) noexcept;
    void designLowShelf(Biquad& f, double freq, float gainDb) noexcept;
    void designHighShelf(Biquad& f, double freq, float gainDb) noexcept;
    void designHighPass(Biquad& f, double freq, double q) noexcept;
    void designLowPass(Biquad& f, double freq, double q) noexcept;
    double omega(double freq) const noexcept;

    Biquad bass, mid, treble, lowCut1, lowCut2, highCut1, highCut2;

    double sr = 44100.0;
    int channels = 2;
    bool prepared = false;
    bool neutralBypassed = false;
    int neutralIdentitySamples = 0;

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
