#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <cmath>

namespace silverdaw
{

// Per-track single-knob compressor; deterministic makeup keeps live/export parity.
// Owned by `TrackChain`, with message-thread setters protected by the `BusGraph` lock.
// `process` stays allocation/lock/log free, and per-track detector state avoids clip-edge thumps.
class Leveler
{
public:
    Leveler() = default;

    /** Recalled on sample-rate or channel-count changes. */
    void prepare(double sampleRate, int numChannels) noexcept
    {
        sr = (sampleRate > 0.0 && std::isfinite(sampleRate)) ? sampleRate : 44100.0;
        channels = juce::jlimit(1, kMaxChannels, numChannels);
        curAmount = targetAmount;
        attackCoeff = onePoleCoeff(kAttackSeconds);
        releaseCoeff = onePoleCoeff(kReleaseSeconds);
        recomputeDerived();
        grEnvDb = 0.0F;
        prepared = true;
    }

    /** Clears the detector envelope on stop/seek without changing params. */
    void reset() noexcept { grEnvDb = 0.0F; }

    /** Message-thread setter under the `BusGraph` lock; `snap` preserves setup parity. */
    void setParams(float amount, bool snap) noexcept
    {
        targetAmount = sanitizeAmount(amount);
        if (snap)
        {
            curAmount = targetAmount;
            recomputeDerived();
        }
    }

    /** Settled-off state leaves the block untouched for live/export parity. */
    void process(juce::AudioBuffer<float>& buffer, int startSample, int numSamples) noexcept
    {
        if (! prepared || numSamples <= 0) return;

        const bool moved = smoothAmount(numSamples);
        if (moved) recomputeDerived();

        // Exact passthrough for untouched tracks.
        if (curAmount <= 0.0F && grEnvDb <= kGrSilenceDb && makeupLin == 1.0F)
            return;

        const int nCh = juce::jmin(buffer.getNumChannels(), channels);
        if (nCh <= 0) return;

        float* chL = buffer.getWritePointer(0);
        float* chR = nCh > 1 ? buffer.getWritePointer(1) : nullptr;

        for (int i = 0; i < numSamples; ++i)
        {
            const int idx = startSample + i;
            const float l = chL[idx];
            const float r = chR != nullptr ? chR[idx] : l;

            // Stereo-linked sidechain keeps the image stable.
            const float sidechain = juce::jmax(std::abs(l), std::abs(r));

            float targetGrDb;
            if (sidechain <= kneeLowerLin)
            {
                // Skip log below the knee.
                targetGrDb = 0.0F;
            }
            else
            {
                const float sDb = 20.0F * std::log10(juce::jmax(sidechain, kTinyLevel));
                targetGrDb = gainReductionDb(sDb);
            }

            // Decoupled attack/release tracks gain reduction without pumping upward.
            const float coeff = (targetGrDb > grEnvDb) ? attackCoeff : releaseCoeff;
            grEnvDb = targetGrDb + (grEnvDb - targetGrDb) * coeff;
            // Reject non-finite detector state so one bad sample cannot poison the track.
            if (! std::isfinite(grEnvDb) || grEnvDb < kGrSilenceDb) grEnvDb = 0.0F;

            const float gain = (grEnvDb <= 0.0F)
                                   ? makeupLin
                                   : makeupLin * std::pow(10.0F, grEnvDb * -0.05F);

            chL[idx] = l * gain;
            if (chR != nullptr) chR[idx] = r * gain;
        }
    }

private:
    static constexpr int kMaxChannels = 2;

    // Amount maps to a leveller curve; peak protection is left to master/export.
    static constexpr float kMinThresholdDb = -24.0F; // at amount 1
    static constexpr float kMaxRatio = 4.0F;         // at amount 1
    static constexpr float kAttackSeconds = 0.012F;  // 12 ms
    static constexpr float kReleaseSeconds = 0.250F; // 250 ms
    static constexpr float kKneeDb = 6.0F;           // soft-knee full width
    static constexpr float kReferenceDb = -12.0F;    // auto-makeup reference level
    static constexpr float kMaxMakeupDb = 10.0F;     // cap so it can't become a pure loudness knob

    static constexpr float kSmoothTauSeconds = 0.02F; // 20 ms Amount glide
    static constexpr float kTinyLevel = 1.0e-9F;      // log-domain floor
    static constexpr float kGrSilenceDb = 1.0e-4F;    // GR below this counts as none

    static float sanitizeAmount(float amount) noexcept
    {
        if (! std::isfinite(amount)) return 0.0F;
        return juce::jlimit(0.0F, 1.0F, amount);
    }

    static float dbToGain(float db) noexcept { return std::pow(10.0F, db * 0.05F); }

    float onePoleCoeff(float tauSeconds) const noexcept
    {
        const double a = std::exp(-1.0 / (juce::jmax(1.0e-5, static_cast<double>(tauSeconds)) * sr));
        return static_cast<float>(juce::jlimit(0.0, 1.0, a));
    }

    /** Settles exactly so the identity fast path can become bit-exact. */
    bool smoothAmount(int numSamples) noexcept
    {
        if (std::abs(targetAmount - curAmount) < 1.0e-5F)
        {
            if (curAmount != targetAmount)
            {
                curAmount = targetAmount;
                return true;
            }
            return false;
        }
        const double a = std::exp(-static_cast<double>(numSamples)
                                  / (static_cast<double>(kSmoothTauSeconds) * sr));
        const float alpha = static_cast<float>(juce::jlimit(0.0, 1.0, a));
        curAmount = targetAmount + (curAmount - targetAmount) * alpha;
        return true;
    }

    void recomputeDerived() noexcept
    {
        const float amt = juce::jlimit(0.0F, 1.0F, curAmount);
        thresholdDb = kMinThresholdDb * amt;          // 0 dB → kMinThresholdDb
        ratio = 1.0F + (kMaxRatio - 1.0F) * amt;       // 1:1 → kMaxRatio
        slope = 1.0F - 1.0F / juce::jmax(1.0F, ratio); // 0 at ratio 1
        // Fixed-reference makeup boosts quieter material while preserving the zero-amount identity.
        const float makeupDb = juce::jlimit(0.0F, kMaxMakeupDb, gainReductionDb(kReferenceDb));
        makeupLin = (makeupDb <= 0.0F) ? 1.0F : dbToGain(makeupDb);
        kneeLowerLin = dbToGain(thresholdDb - kKneeDb * 0.5F);
    }

    float gainReductionDb(float sDb) const noexcept
    {
        const float over = sDb - thresholdDb;
        const float halfKnee = kKneeDb * 0.5F;
        if (over <= -halfKnee) return 0.0F;
        if (over >= halfKnee) return slope * over;
        // Quadratic knee keeps value and slope continuous.
        const float x = over + halfKnee;
        return slope * (x * x) / (2.0F * kKneeDb);
    }

    double sr = 44100.0;
    int channels = 2;
    bool prepared = false;

    float targetAmount = 0.0F;
    float curAmount = 0.0F;

    float thresholdDb = 0.0F;
    float ratio = 1.0F;
    float slope = 0.0F;       // 1 - 1/ratio
    float makeupLin = 1.0F;
    float kneeLowerLin = 1.0F;

    float attackCoeff = 0.0F;
    float releaseCoeff = 0.0F;

    // Persists across blocks; cleared only by `reset`.
    float grEnvDb = 0.0F;
};

} // namespace silverdaw
