#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <cmath>

namespace silverdaw
{

/**
 * Per-track "Leveler" — the single-knob, soft-knee compressor documented in
 * §7.9.3 / §7.10 of `.ref/daw-design-plan.md`. Deliberately NOT a full
 * channel-strip compressor: the user sees one **Amount** knob in `[0, 1]`
 * that drives a curated path through classic compressor parameters with a
 * deterministic static makeup-gain map (no live loudness analysis), matching
 * the simplicity ethos. (The "Advanced" disclosure of raw threshold / ratio /
 * attack / release is intentionally deferred — see the Phase 5 checklist.)
 *
 * Amount → parameters (curated, deterministic so live and export agree):
 *   threshold = lerp(0 dBFS, -24 dBFS, amount)
 *   ratio     = lerp(1:1, 4:1, amount)
 *   attack    = 12 ms   (fixed — gentle "leveller", not a peak limiter)
 *   release   = 250 ms  (fixed)
 *   makeup    = clamp(0, +10 dB, gain reduction a steady -12 dBFS reference
 *                     signal would receive)   // auto-makeup
 * The makeup is the gain reduction the curve applies at a fixed -12 dBFS
 * reference level, so material quieter than the reference (the common case —
 * stems/loops usually sit well below 0 dBFS) is boosted while louder peaks are
 * pulled down: the knob audibly raises loudness and density, monotonically,
 * instead of merely squashing dynamics at constant loudness.
 * At amount 0 the ratio is exactly 1:1 and makeup is 0 dB (the reference sees
 * no reduction), so the node is a true bit-exact passthrough — preserving the
 * §7.9.6 "untouched track is sample-identical in export" parity guarantee.
 * Peak protection is deliberately NOT done here: as a leveller (not a limiter)
 * it leaves floating-point overs intact for the master / export stage to
 * resolve, rather than hard-clipping the per-track signal and destroying
 * recoverable headroom.
 *
 * **Detector.** Stereo-linked feed-forward peak detector: the sidechain is
 * `max(|L|, |R|)` so both channels share one gain envelope and the stereo
 * image never shifts. Gain reduction is computed in the dB domain with a
 * fixed 6 dB soft knee, then smoothed with a decoupled one-pole envelope
 * (attack coefficient while reduction is increasing, release while it is
 * recovering).
 *
 * **Threading.** Owned by `TrackChain`, driven by the audio thread inside
 * `BusGraph::getNextAudioBlock`. `setParams` arrives from the message thread
 * but always under the same `BusGraph` CriticalSection the audio thread holds
 * while calling `process`, so the plain (non-atomic) target member is
 * race-free. `setParams` only stores the target Amount; all derived-parameter
 * and detector math happens on the audio thread inside `process`.
 *
 * **Realtime safety.** No allocation, locking, or logging in `process`.
 * `prepare` is the only place to size state; `reset` clears the detector
 * envelope (transport stop / catastrophic seek, NOT pause — mirrors `ToneEq`
 * and the rest of the chain). The detector envelope lives across the whole
 * chain lifetime — that is why the chain is per-track, not per-clip: a
 * detector that reset at every clip edge would thump on adjacent clips.
 * `setParams(..., snap=true)` collapses the Amount smoother instantly — used
 * by project-load / mixdown-setup / runtime-creation so the offline export
 * starts at the steady-state response.
 */
class Leveler
{
public:
    Leveler() = default;

    /** Size internal state and snap the smoother to the current target.
     *  Re-called whenever sample rate / channel count changes. */
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

    /** Clear the detector envelope (transport stop / catastrophic seek).
     *  Keeps the derived parameters intact. */
    void reset() noexcept { grEnvDb = 0.0F; }

    /**
     * Publish a new Amount target. Called on the message thread under the
     * owning `BusGraph` lock. `snap` collapses the smoother so the new
     * response is in effect on the very next block (load / mixdown /
     * runtime-creation paths use this for live↔export parity); the live
     * UI-gesture path passes `snap=false` to glide and avoid zipper noise.
     */
    void setParams(float amount, bool snap) noexcept
    {
        targetAmount = sanitizeAmount(amount);
        if (snap)
        {
            curAmount = targetAmount;
            recomputeDerived();
        }
    }

    /** In-place per-block processing over `[startSample, startSample+numSamples)`.
     *
     *  When the Amount has settled to 0 and the detector envelope has fully
     *  recovered, the block is left untouched (exact passthrough) so a track
     *  with no Leveler is bit-identical between live playback and export. */
    void process(juce::AudioBuffer<float>& buffer, int startSample, int numSamples) noexcept
    {
        if (! prepared || numSamples <= 0) return;

        const bool moved = smoothAmount(numSamples);
        if (moved) recomputeDerived();

        // Exact passthrough once the knob has settled to off and the detector
        // has released — preserves the parity guarantee for untouched tracks.
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

            // Stereo-linked sidechain (one envelope drives both channels).
            const float sidechain = juce::jmax(std::abs(l), std::abs(r));

            float targetGrDb;
            if (sidechain <= kneeLowerLin)
            {
                // Clearly below the knee — no reduction, and skip the log.
                targetGrDb = 0.0F;
            }
            else
            {
                const float sDb = 20.0F * std::log10(juce::jmax(sidechain, kTinyLevel));
                targetGrDb = gainReductionDb(sDb);
            }

            // Decoupled one-pole: attack while reduction grows, release while
            // it recovers. Coefficients are per-sample retention factors.
            const float coeff = (targetGrDb > grEnvDb) ? attackCoeff : releaseCoeff;
            grEnvDb = targetGrDb + (grEnvDb - targetGrDb) * coeff;
            // Squash denormals and reject any non-finite value: a single
            // NaN/Inf input sample must not permanently poison the detector
            // envelope (and through it every later block on this track).
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

    // Curated Amount → parameter ranges (see class doc). A "leveller", not a
    // brickwall limiter: a moderate 4:1 at full with an auto-makeup that lifts
    // loudness; floating-point overs are left for the master / export stage.
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

    /** Per-block Amount smoothing. Settles exactly to the target (like
     *  `ToneEq`) so an idle knob stops recomputing and can reach the exact
     *  identity state used by the passthrough fast path. */
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

    /** Derive the compressor parameters from the smoothed Amount. */
    void recomputeDerived() noexcept
    {
        const float amt = juce::jlimit(0.0F, 1.0F, curAmount);
        thresholdDb = kMinThresholdDb * amt;          // 0 dB → kMinThresholdDb
        ratio = 1.0F + (kMaxRatio - 1.0F) * amt;       // 1:1 → kMaxRatio
        slope = 1.0F - 1.0F / juce::jmax(1.0F, ratio); // 0 at ratio 1
        // Auto-makeup: cancel the gain reduction the curve applies at a fixed
        // reference level so material below the reference is boosted (louder,
        // denser) while peaks above it are pulled down. Zero at amount 0 (the
        // reference sees no reduction), keeping the passthrough fast path exact.
        const float makeupDb = juce::jlimit(0.0F, kMaxMakeupDb, gainReductionDb(kReferenceDb));
        makeupLin = (makeupDb <= 0.0F) ? 1.0F : dbToGain(makeupDb);
        kneeLowerLin = dbToGain(thresholdDb - kKneeDb * 0.5F);
    }

    /** Soft-knee static gain-reduction curve (dB in → GR dB out, >= 0). */
    float gainReductionDb(float sDb) const noexcept
    {
        const float over = sDb - thresholdDb;
        const float halfKnee = kKneeDb * 0.5F;
        if (over <= -halfKnee) return 0.0F;
        if (over >= halfKnee) return slope * over;
        // Quadratic spline through the knee: continuous value and slope at
        // both corners, monotonic, never negative.
        const float x = over + halfKnee;
        return slope * (x * x) / (2.0F * kKneeDb);
    }

    double sr = 44100.0;
    int channels = 2;
    bool prepared = false;

    float targetAmount = 0.0F;
    float curAmount = 0.0F;

    // Derived per-block from `curAmount`.
    float thresholdDb = 0.0F;
    float ratio = 1.0F;
    float slope = 0.0F;       // 1 - 1/ratio
    float makeupLin = 1.0F;
    float kneeLowerLin = 1.0F;

    // Fixed per sample-rate.
    float attackCoeff = 0.0F;
    float releaseCoeff = 0.0F;

    // Detector state (persists across blocks; cleared by `reset`).
    float grEnvDb = 0.0F;
};

} // namespace silverdaw
