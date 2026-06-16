#include "BassEnhancer.h"

#include <algorithm>
#include <cmath>
#include <vector>

namespace silverdaw
{
namespace
{

// Per-strength tuning. The subsonic corner clears DC/rumble only. The expander
// threshold sits `thresholdBelowDb` under a robust high-percentile "active bass
// level", so quiet inter-note bleed falls below it while notes stay above.
// `rangeDb` caps the attenuation so the expander can never fully gate a sustain
// tail; the slow `attackMs`/`releaseMs` and `holdMs` keep it from rippling at
// the low note's own period.
struct StrengthParams
{
    double highPassHz;       // subsonic high-pass corner (DC/rumble only)
    double thresholdBelowDb; // expander threshold, in dB below the active level
    double ratio;            // downward-expansion ratio (> 1)
    double rangeDb;          // maximum attenuation the expander may apply
    double attackMs;         // level-envelope attack (slow, LF-safe)
    double holdMs;           // hold before the gain starts releasing
    double releaseMs;        // release time as the gain closes into a gap
    double kneeDb;           // soft-knee width around the threshold
};

StrengthParams paramsFor(BassEnhanceStrength strength) noexcept
{
    switch (strength)
    {
        case BassEnhanceStrength::Light:
            return {20.0, 32.0, 1.2, 3.0, 20.0, 50.0, 300.0, 6.0};
        case BassEnhanceStrength::Strong:
            return {28.0, 40.0, 1.55, 9.0, 30.0, 100.0, 550.0, 10.0};
        case BassEnhanceStrength::Medium:
        default:
            return {24.0, 36.0, 1.35, 6.0, 25.0, 75.0, 400.0, 8.0};
    }
}

// Parallel-blend amount for the harmonic exciter (0 = dry). Scaled by strength and
// kept conservative so the added upper harmonics read as definition/translation,
// not as distortion of the fundamental.
double harmonicBlendFor(BassEnhanceStrength strength) noexcept
{
    switch (strength)
    {
        case BassEnhanceStrength::Light: return 0.10;
        case BassEnhanceStrength::Strong: return 0.22;
        case BassEnhanceStrength::Medium:
        default: return 0.16;
    }
}

// The exciter generates harmonics from content below this corner (the
// fundamental/low-mid band) and...
constexpr double kExciterSourceHz = 200.0;
// ...high-passes the generated harmonics above this corner so only UPPER harmonics
// are added in parallel — the fundamental and sub are never boosted.
constexpr double kExciterHarmonicHz = 120.0;
// Drive into the tanh nonlinearity. High enough that musical bass levels generate
// audible harmonics, low enough to stay musical.
constexpr double kExciterDrive = 4.0;

// The detector runs off a copy low-passed to this corner so high-frequency bleed
// (vocals, cymbals, guitar) cannot hold the expander open during a bass gap.
constexpr double kDetectorLowPassHz = 600.0;

// Window over which the level envelope is measured for the percentile statistics
// that anchor the threshold. ~50 ms is long enough to smooth a low bass note's
// waveform period (a 40 Hz note is 25 ms) into a stable level estimate.
constexpr double kEnvelopeWindowMs = 50.0;

// Below this level the stem is treated as silent and the expander is skipped: the
// threshold would be meaningless and we must never divide by (or log) zero.
constexpr float kSilenceFloor = 1.0e-6F;

// Note/quiet contrast guards (active p95 minus gap p20, in dB). Below the bypass
// floor the stem has effectively no gaps (sustained/continuous bass) and gating
// would only expose artefacts, so the expander is skipped. Between the floor and
// the full threshold the range is halved to stay gentle.
constexpr double kContrastBypassDb = 6.0;
constexpr double kContrastHalfRangeDb = 12.0;

// Direct Form I biquad in double precision. Offline use only, so it is a plain
// per-channel filter with no lock-free/atomic machinery. Coefficients are
// normalised on assignment.
struct Biquad
{
    double b0 = 1.0, b1 = 0.0, b2 = 0.0, a1 = 0.0, a2 = 0.0;
    double x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0;

    inline double process(double x) noexcept
    {
        const double y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        return y;
    }
};

double biquadW0(double sampleRate, double freqHz, double& cw, double& alpha) noexcept
{
    const double fs = (sampleRate > 0.0 && std::isfinite(sampleRate)) ? sampleRate : 44100.0;
    const double freq = std::clamp(freqHz, 10.0, fs * 0.49);
    const double w0 = 2.0 * juce::MathConstants<double>::pi * freq / fs;
    cw = std::cos(w0);
    const double q = 1.0 / std::sqrt(2.0);
    alpha = std::sin(w0) / (2.0 * q);
    return w0;
}

// RBJ 2nd-order Butterworth high-pass (Q = 1/sqrt(2)).
Biquad designButterHighPass(double sampleRate, double freqHz) noexcept
{
    double cw = 0.0, alpha = 0.0;
    biquadW0(sampleRate, freqHz, cw, alpha);
    Biquad f;
    const double a0 = 1.0 + alpha;
    const double onePlusCw = 1.0 + cw;
    f.b0 = (onePlusCw / 2.0) / a0;
    f.b1 = (-onePlusCw) / a0;
    f.b2 = (onePlusCw / 2.0) / a0;
    f.a1 = (-2.0 * cw) / a0;
    f.a2 = (1.0 - alpha) / a0;
    return f;
}

// RBJ 2nd-order Butterworth low-pass (Q = 1/sqrt(2)), used for the detector only.
Biquad designButterLowPass(double sampleRate, double freqHz) noexcept
{
    double cw = 0.0, alpha = 0.0;
    biquadW0(sampleRate, freqHz, cw, alpha);
    Biquad f;
    const double a0 = 1.0 + alpha;
    const double oneMinusCw = 1.0 - cw;
    f.b0 = (oneMinusCw / 2.0) / a0;
    f.b1 = oneMinusCw / a0;
    f.b2 = (oneMinusCw / 2.0) / a0;
    f.a1 = (-2.0 * cw) / a0;
    f.a2 = (1.0 - alpha) / a0;
    return f;
}

// Replaces any non-finite sample with zero so a stray NaN/Inf from the model can
// never poison the filter state, the level statistics, or the output WAV.
void sanitiseInPlace(juce::AudioBuffer<float>& buffer) noexcept
{
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
    {
        float* data = buffer.getWritePointer(ch);
        for (int i = 0; i < buffer.getNumSamples(); ++i)
            if (! std::isfinite(data[i]))
                data[i] = 0.0F;
    }
}

void applyHighPass(juce::AudioBuffer<float>& buffer, double sampleRate, double freqHz) noexcept
{
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
    {
        Biquad f = designButterHighPass(sampleRate, freqHz);
        float* data = buffer.getWritePointer(ch);
        for (int i = 0; i < buffer.getNumSamples(); ++i)
            data[i] = static_cast<float>(f.process(static_cast<double>(data[i])));
    }
}

// Per-sample low-passed detector: the loudest channel of a ~600 Hz low-passed
// copy drives one shared gain so the stereo image is preserved and HF bleed is
// kept out of the detection path. Summing channels is avoided because phasey
// separated material can cancel.
std::vector<double> buildDetector(const juce::AudioBuffer<float>& buffer, double sampleRate) noexcept
{
    const int numCh = buffer.getNumChannels();
    const int numSamples = buffer.getNumSamples();
    std::vector<double> det(static_cast<size_t>(numSamples), 0.0);
    for (int ch = 0; ch < numCh; ++ch)
    {
        Biquad lp = designButterLowPass(sampleRate, kDetectorLowPassHz);
        const float* data = buffer.getReadPointer(ch);
        for (int i = 0; i < numSamples; ++i)
        {
            const double v = std::abs(lp.process(static_cast<double>(data[i])));
            det[static_cast<size_t>(i)] = std::max(det[static_cast<size_t>(i)], v);
        }
    }
    return det;
}

// One windowed RMS level per hop over the detector series, used to derive robust
// percentile statistics for the threshold.
std::vector<double> windowRms(const std::vector<double>& det, double sampleRate) noexcept
{
    const double fs = (sampleRate > 0.0 && std::isfinite(sampleRate)) ? sampleRate : 44100.0;
    const int win = std::max(1, static_cast<int>(kEnvelopeWindowMs * 0.001 * fs));
    const int n = static_cast<int>(det.size());

    std::vector<double> levels;
    levels.reserve(static_cast<size_t>(n / win) + 1);
    for (int start = 0; start < n; start += win)
    {
        const int end = std::min(start + win, n);
        double sum = 0.0;
        for (int i = start; i < end; ++i)
            sum += det[static_cast<size_t>(i)] * det[static_cast<size_t>(i)];
        levels.push_back(std::sqrt(sum / std::max(1, end - start)));
    }
    return levels;
}

// Linear value at a [0,1] percentile of a copy-sorted series (nearest-rank).
double percentile(std::vector<double> values, double p) noexcept
{
    if (values.empty()) return 0.0;
    std::sort(values.begin(), values.end());
    const double clamped = std::clamp(p, 0.0, 1.0);
    auto idx = static_cast<size_t>(clamped * static_cast<double>(values.size() - 1) + 0.5);
    return values[std::min(idx, values.size() - 1)];
}

// Soft-knee downward-expansion static curve. `over` is the detector level in dB
// relative to the threshold; returns the gain (dB, <= 0). The knee makes the
// transition continuous in value and slope so there are no audible steps.
double expansionGainDb(double overDb, double slope, double kneeDb, double rangeDb) noexcept
{
    const double halfKnee = kneeDb * 0.5;
    double gainDb;
    if (overDb >= halfKnee)
        gainDb = 0.0;
    else if (overDb <= -halfKnee)
        gainDb = slope * overDb;
    else
    {
        const double d = halfKnee - overDb; // 0..kneeDb across the knee
        gainDb = -slope * (d * d) / (2.0 * kneeDb);
    }
    return std::max(gainDb, -rangeDb);
}

// RMS-style downward expander. A mean-square envelope with slow asymmetric
// ballistics (attack / hold / slow release) tracks the low-passed detector,
// smoothing the note's own waveform period so the gain does not distort, then
// closes gently into the gaps. A single shared gain is applied to every channel.
void applyExpander(juce::AudioBuffer<float>& buffer, const std::vector<double>& det,
                   double sampleRate, double thresholdDb, const StrengthParams& params,
                   double rangeDb) noexcept
{
    const double fs = (sampleRate > 0.0 && std::isfinite(sampleRate)) ? sampleRate : 44100.0;
    const double slope = params.ratio - 1.0;
    const double aAtt = std::exp(-1.0 / (params.attackMs * 0.001 * fs));
    const double aRel = std::exp(-1.0 / (params.releaseMs * 0.001 * fs));
    const int holdSamples = std::max(0, static_cast<int>(params.holdMs * 0.001 * fs));

    const int numCh = buffer.getNumChannels();
    const int numSamples = buffer.getNumSamples();

    // Prime the envelope on the first sample so a stem that opens on a note does
    // not fade in late.
    double msEnv = det.empty() ? 0.0 : det[0] * det[0];
    int holdCounter = msEnv > 0.0 ? holdSamples : 0;

    for (int i = 0; i < numSamples; ++i)
    {
        const double sq = det[static_cast<size_t>(i)] * det[static_cast<size_t>(i)];
        if (sq >= msEnv)
        {
            msEnv = aAtt * msEnv + (1.0 - aAtt) * sq; // attack
            holdCounter = holdSamples;
        }
        else if (holdCounter > 0)
        {
            --holdCounter; // hold at the recent level
        }
        else
        {
            msEnv = aRel * msEnv + (1.0 - aRel) * sq; // slow release
        }

        const double levelDb = 10.0 * std::log10(msEnv + 1.0e-18);
        const float gain = static_cast<float>(
            std::pow(10.0, expansionGainDb(levelDb - thresholdDb, slope, params.kneeDb, rangeDb) / 20.0));

        for (int ch = 0; ch < numCh; ++ch)
            buffer.getWritePointer(ch)[i] *= gain;
    }
}

// Cleanup stage: builds the low-passed detector, anchors a robust threshold and
// gates inter-note bleed with the downward expander, self-bypassing on
// sustained/continuous bass. Implemented as a helper so its early returns skip
// only the cleanup, never the enhancement stage that follows.
void applyCleanupExpander(juce::AudioBuffer<float>& buffer, double sampleRate,
                          const StrengthParams& params) noexcept
{
    // Detector runs off a low-passed copy; the threshold is anchored to a robust
    // high percentile of its windowed RMS so a single loud note cannot skew it,
    // and the gap floor feeds the contrast guard below.
    const auto det = buildDetector(buffer, sampleRate);
    const auto levels = windowRms(det, sampleRate);
    const double activeLevel = percentile(levels, 0.95);
    if (activeLevel <= kSilenceFloor) return; // silent after the high-pass

    const double gapFloor = percentile(levels, 0.20);
    const double activeDb = 20.0 * std::log10(activeLevel + 1.0e-9);
    const double gapDb = 20.0 * std::log10(std::max(gapFloor, static_cast<double>(kSilenceFloor)));
    const double contrastDb = activeDb - gapDb;

    // Sustained/continuous bass with no real gaps: gating would only expose
    // separation artefacts, so bypass entirely (or stay extra gentle near the
    // boundary).
    if (contrastDb < kContrastBypassDb) return;
    const double rangeDb = contrastDb < kContrastHalfRangeDb ? params.rangeDb * 0.5 : params.rangeDb;

    const double thresholdDb = activeDb - params.thresholdBelowDb;
    applyExpander(buffer, det, sampleRate, thresholdDb, params, rangeDb);
}

// Harmonic exciter: adds upper harmonics so the bass keeps its definition and
// translates on small speakers that cannot reproduce the fundamental. Per channel,
// the low band (< ~200 Hz) is isolated, driven through a tanh nonlinearity to
// generate harmonics, then high-passed (> ~120 Hz) so only the UPPER harmonics
// survive — the fundamental and sub are never boosted. The generated harmonics are
// blended in parallel at a conservative, strength-scaled amount. Applied
// per-channel so the stereo image is preserved.
void applyHarmonicExciter(juce::AudioBuffer<float>& buffer, double sampleRate, double blend) noexcept
{
    if (! (blend > 0.0)) return;
    const int numCh = buffer.getNumChannels();
    const int numSamples = buffer.getNumSamples();

    for (int ch = 0; ch < numCh; ++ch)
    {
        Biquad sourceLp = designButterLowPass(sampleRate, kExciterSourceHz);
        Biquad harmonicHp = designButterHighPass(sampleRate, kExciterHarmonicHz);
        float* data = buffer.getWritePointer(ch);
        for (int i = 0; i < numSamples; ++i)
        {
            const double x = static_cast<double>(data[i]);
            const double low = sourceLp.process(x);
            const double shaped = std::tanh(kExciterDrive * low) / kExciterDrive;
            const double harmonics = harmonicHp.process(shaped);
            data[i] = static_cast<float>(x + blend * harmonics);
        }
    }
}

// Soft-knee peak safety. Samples below the knee pass through unchanged (so the
// fundamental and steady levels are untouched); only peaks pushed past the knee by
// the added harmonics are smoothly compressed toward the ceiling, avoiding
// hard-clip distortion without altering the rest of the signal.
void softLimitInPlace(juce::AudioBuffer<float>& buffer) noexcept
{
    constexpr float knee = 0.9F;
    constexpr float ceiling = 0.9999F;
    const float range = ceiling - knee;
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
    {
        float* data = buffer.getWritePointer(ch);
        for (int i = 0; i < buffer.getNumSamples(); ++i)
        {
            const float a = std::abs(data[i]);
            if (a <= knee) continue;
            const float comp = range * std::tanh((a - knee) / range);
            data[i] = std::copysign(knee + comp, data[i]);
        }
    }
}

} // namespace

BassEnhanceStrength bassEnhanceStrengthFromString(const juce::String& text) noexcept
{
    const auto t = text.trim().toLowerCase();
    if (t == "light") return BassEnhanceStrength::Light;
    if (t == "strong") return BassEnhanceStrength::Strong;
    return BassEnhanceStrength::Medium;
}

const char* bassEnhanceStrengthToString(BassEnhanceStrength strength) noexcept
{
    switch (strength)
    {
        case BassEnhanceStrength::Light: return "light";
        case BassEnhanceStrength::Strong: return "strong";
        case BassEnhanceStrength::Medium:
        default: return "medium";
    }
}

void BassEnhancer::process(juce::AudioBuffer<float>& buffer, double sampleRate,
                           const BassEnhanceOptions& options)
{
    if (! options.enabled) return;
    if (buffer.getNumChannels() <= 0 || buffer.getNumSamples() <= 0) return;
    if (! (sampleRate > 0.0) || ! std::isfinite(sampleRate)) return;

    const juce::ScopedNoDenormals noDenormals;
    const StrengthParams params = paramsFor(options.strength);

    sanitiseInPlace(buffer);
    applyHighPass(buffer, sampleRate, params.highPassHz);

    // Cleanup first (may self-bypass on sustained/continuous or silent material)...
    applyCleanupExpander(buffer, sampleRate, params);

    // ...then always add upper harmonics for definition, with a soft limiter so the
    // added energy can never hard-clip. Both are no-ops on silence.
    applyHarmonicExciter(buffer, sampleRate, harmonicBlendFor(options.strength));
    softLimitInPlace(buffer);
}

} // namespace silverdaw
