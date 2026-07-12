#include "ToneEq.h"
#include "DspSmooth.h"

namespace silverdaw
{

void ToneEq::prepare(double sampleRate, int numChannels) noexcept
{
    sr = (sampleRate > 0.0 && std::isfinite(sampleRate)) ? sampleRate : 44100.0;
    channels = juce::jlimit(1, kMaxChannels, numChannels);
    snapToTargets();
    clearState();
    prepared = true;
    recomputeCoeffs();
    neutralBypassed = isNeutralState(curBassDb, curMidDb, curTrebleDb,
                                     curLowCutHz, curHighCutHz);
    neutralIdentitySamples = 0;
    snapRequested.store(false, std::memory_order_relaxed);
}

void ToneEq::reset() noexcept
{
    clearState();
    neutralBypassed = isNeutralState(curBassDb, curMidDb, curTrebleDb,
                                     curLowCutHz, curHighCutHz);
    neutralIdentitySamples = 0;
}

void ToneEq::setParams(float bassDb, float midDb, float trebleDb, float filter,
                       bool snap) noexcept
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

void ToneEq::setFilterTarget(float filter, bool snap) noexcept
{
    float lowCutHz = kLowCutOffHz;
    float highCutHz = kHighCutOffHz;
    filterToCorners(filter, lowCutHz, highCutHz);
    targetLowCutHz.store(lowCutHz, std::memory_order_relaxed);
    targetHighCutHz.store(highCutHz, std::memory_order_relaxed);
    if (snap) snapRequested.store(true, std::memory_order_release);
}

void ToneEq::process(juce::AudioBuffer<float>& buffer, int startSample,
                     int numSamples) noexcept
{
    if (! prepared || numSamples <= 0) return;

    if (snapRequested.exchange(false, std::memory_order_acquire))
    {
        snapToTargets();
        recomputeCoeffs();
        neutralBypassed = isNeutralState(curBassDb, curMidDb, curTrebleDb,
                                         curLowCutHz, curHighCutHz);
        neutralIdentitySamples = 0;
        if (neutralBypassed) clearState();
    }

    const float bassTarget   = targetBassDb.load(std::memory_order_relaxed);
    const float midTarget    = targetMidDb.load(std::memory_order_relaxed);
    const float trebleTarget = targetTrebleDb.load(std::memory_order_relaxed);
    const float lowCutTarget  = targetLowCutHz.load(std::memory_order_relaxed);
    const float highCutTarget = targetHighCutHz.load(std::memory_order_relaxed);
    const float alpha = dsp::blockAlpha(numSamples, sr, kSmoothTauSeconds);
    bool moved = false;
    moved |= smoothToward(curBassDb,   bassTarget,   alpha);
    moved |= smoothToward(curMidDb,    midTarget,    alpha);
    moved |= smoothToward(curTrebleDb, trebleTarget, alpha);
    moved |= smoothToward(curLowCutHz,  lowCutTarget,  alpha);
    moved |= smoothToward(curHighCutHz, highCutTarget, alpha);
    if (moved) recomputeCoeffs();

    const bool currentNeutral = isNeutralState(curBassDb, curMidDb, curTrebleDb,
                                               curLowCutHz, curHighCutHz);
    const bool targetNeutral  = isNeutralState(bassTarget, midTarget, trebleTarget,
                                               lowCutTarget, highCutTarget);
    if (neutralBypassed)
    {
        if (currentNeutral && targetNeutral) return;
        neutralBypassed = false;
        neutralIdentitySamples = 0;
    }

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

    if (currentNeutral && targetNeutral)
    {
        neutralIdentitySamples += juce::jmin(numSamples, 2);
        if (neutralIdentitySamples >= 2)
        {
            clearState();
            neutralBypassed = true;
            neutralIdentitySamples = 0;
        }
    }
    else
    {
        neutralIdentitySamples = 0;
    }
}

// ── Biquad ────────────────────────────────────────────────────────────────────

void ToneEq::Biquad::setNormalized(double nb0, double nb1, double nb2, double a0,
                                    double na1, double na2) noexcept
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

// ── Private helpers ───────────────────────────────────────────────────────────

bool ToneEq::isNeutralState(float bassDb, float midDb, float trebleDb,
                             float lowCutHz, float highCutHz) noexcept
{
    return std::abs(bassDb) < kDbEpsilon
        && std::abs(midDb) < kDbEpsilon
        && std::abs(trebleDb) < kDbEpsilon
        && lowCutHz <= kLowCutIdentityHz
        && highCutHz >= kHighCutIdentityHz;
}

// Maps the bipolar Filter control to the corner-frequency pair the biquads
// consume. Only one side is ever engaged; the other parks at its off
// sentinel so the unused stage resolves to identity in `recomputeCoeffs`.
void ToneEq::filterToCorners(float filter, float& lowCutHz, float& highCutHz) noexcept
{
    const float f = std::isfinite(filter) ? juce::jlimit(-1.0F, 1.0F, filter) : 0.0F;
    if (f > kFilterEpsilon)
    {
        lowCutHz  = kHpfMinHz * std::pow(kHpfMaxHz / kHpfMinHz, f);
        highCutHz = kHighCutOffHz;
    }
    else if (f < -kFilterEpsilon)
    {
        highCutHz = kLpfMaxHz * std::pow(kLpfMinHz / kLpfMaxHz, -f);
        lowCutHz  = kLowCutOffHz;
    }
    else
    {
        lowCutHz  = kLowCutOffHz;
        highCutHz = kHighCutOffHz;
    }
}

bool ToneEq::smoothToward(float& cur, float target, float alpha) noexcept
{
    return dsp::smoothToward<float, true>(cur, target, alpha, 1.0e-4F);
}

void ToneEq::snapToTargets() noexcept
{
    curBassDb   = targetBassDb.load(std::memory_order_relaxed);
    curMidDb    = targetMidDb.load(std::memory_order_relaxed);
    curTrebleDb = targetTrebleDb.load(std::memory_order_relaxed);
    curLowCutHz  = targetLowCutHz.load(std::memory_order_relaxed);
    curHighCutHz = targetHighCutHz.load(std::memory_order_relaxed);
}

void ToneEq::clearState() noexcept
{
    bass.clear();
    mid.clear();
    treble.clear();
    lowCut1.clear();
    lowCut2.clear();
    highCut1.clear();
    highCut2.clear();
}

void ToneEq::recomputeCoeffs() noexcept
{
    designLowShelf(bass,   kBassHz,   curBassDb);
    designPeak    (mid,    kMidHz,    curMidDb);
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

// ── Biquad coefficient designers ─────────────────────────────────────────────

void ToneEq::designPeak(Biquad& f, double freq, float gainDb) noexcept
{
    if (std::abs(gainDb) < kDbEpsilon) { f.setIdentity(); return; }
    const double w0    = omega(freq);
    const double cw    = std::cos(w0);
    const double sw    = std::sin(w0);
    const double A     = std::pow(10.0, gainDb / 40.0);
    const double alpha = sw / (2.0 * kMidQ);

    f.setNormalized(1.0 + alpha * A, -2.0 * cw, 1.0 - alpha * A,
                    1.0 + alpha / A, -2.0 * cw, 1.0 - alpha / A);
}

void ToneEq::designLowShelf(Biquad& f, double freq, float gainDb) noexcept
{
    if (std::abs(gainDb) < kDbEpsilon) { f.setIdentity(); return; }
    const double w0    = omega(freq);
    const double cw    = std::cos(w0);
    const double sw    = std::sin(w0);
    const double A     = std::pow(10.0, gainDb / 40.0);
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

void ToneEq::designHighShelf(Biquad& f, double freq, float gainDb) noexcept
{
    if (std::abs(gainDb) < kDbEpsilon) { f.setIdentity(); return; }
    const double w0    = omega(freq);
    const double cw    = std::cos(w0);
    const double sw    = std::sin(w0);
    const double A     = std::pow(10.0, gainDb / 40.0);
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

void ToneEq::designHighPass(Biquad& f, double freq, double q) noexcept
{
    const double w0       = omega(freq);
    const double cw       = std::cos(w0);
    const double sw       = std::sin(w0);
    const double alpha    = sw / (2.0 * q);
    const double onePlusCw = 1.0 + cw;

    // High-pass needs (1 + cos w0); the low-pass numerator would invert Low Cut.
    f.setNormalized(onePlusCw / 2.0, -onePlusCw, onePlusCw / 2.0,
                    1.0 + alpha, -2.0 * cw, 1.0 - alpha);
}

void ToneEq::designLowPass(Biquad& f, double freq, double q) noexcept
{
    const double w0        = omega(freq);
    const double cw        = std::cos(w0);
    const double sw        = std::sin(w0);
    const double alpha     = sw / (2.0 * q);
    const double oneMinusCw = 1.0 - cw;

    // Low-pass mirrors the high-pass numerator for High Cut.
    f.setNormalized(oneMinusCw / 2.0, oneMinusCw, oneMinusCw / 2.0,
                    1.0 + alpha, -2.0 * cw, 1.0 - alpha);
}

double ToneEq::omega(double freq) const noexcept
{
    // Keep the corner safely below Nyquist.
    const double f = juce::jlimit(1.0, sr * 0.49, freq);
    return 2.0 * juce::MathConstants<double>::pi * f / sr;
}

} // namespace silverdaw
