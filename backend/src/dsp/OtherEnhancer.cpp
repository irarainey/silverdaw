#include "OtherEnhancer.h"

#include "EnhancerDsp.h"

#include <algorithm>
#include <cmath>
#include <vector>

#include <juce_dsp/juce_dsp.h>

namespace silverdaw
{
namespace
{

using enhancer_dsp::applyHighPass;
using enhancer_dsp::kSilenceFloor;
using enhancer_dsp::percentile;
using enhancer_dsp::sanitiseInPlace;
using enhancer_dsp::softLimitInPlace;

// Per-strength tuning. The subsonic corner clears DC/rumble the residual
// collects from imperfect bass/drum/vocal estimates. `floorPercentile` picks the
// persistent low-level energy in each bin as the noise estimate; `overSub`
// nudges the threshold up; `maxReductionDb` caps how far any bin can be pulled
// down (kept small — this is shallow comfort cleanup, not separation repair).
struct StrengthParams
{
    double highPassHz;     // subsonic high-pass corner (DC/rumble only)
    double floorPercentile; // per-bin noise-floor percentile over active frames
    double overSub;        // threshold = floor * overSub
    double maxReductionDb; // maximum per-bin attenuation
};

StrengthParams paramsFor(OtherEnhanceStrength strength) noexcept
{
    switch (strength)
    {
        case OtherEnhanceStrength::Light:
            return {20.0, 0.08, 1.0, 3.0};
        case OtherEnhanceStrength::Strong:
            return {28.0, 0.15, 1.25, 6.0};
        case OtherEnhanceStrength::Medium:
        default:
            return {24.0, 0.10, 1.10, 5.0};
    }
}

// Above this multiple of the threshold a bin is passed at unity gain; the soft
// knee ramps from the attenuation floor (at/below threshold) up to unity by this
// point, so genuine content sitting a little above the floor is barely touched.
constexpr double kUnityRatio = 3.0;

// A bin's threshold is taken from a WIDE-window median of the per-bin floor (a
// broadband noise-floor estimate), not the bin's own persistent level. A steady
// tone occupies only a few bins, so it stands far above this broadband median and
// is preserved; flat noise bins sit near it and are attenuated. The window must
// be much wider than any tonal peak.
constexpr int kBroadbandMedianRadius = 24;

// Frames quieter than this fraction of the loudest frame's energy are excluded
// from the noise-floor statistics so leading/trailing near-silence doesn't drag
// the floor estimate down to zero.
constexpr double kActiveFrameEnergyFraction = 1.0e-5;

// If the predicted energy-weighted attenuation across the whole stem is below
// this, the STFT stage is skipped entirely: the change would be inaudible and
// not worth the reconstruction cost or artefact risk.
constexpr double kSelfBypassAttenDb = 0.3;

// Soft-knee spectral gain: unity at/above kUnityRatio×threshold, smoothly down to
// `floorGain` at/below the threshold. `ratio` is magnitude / threshold.
double softGate(double ratio, double floorGain) noexcept
{
    if (ratio >= kUnityRatio) return 1.0;
    if (ratio <= 1.0) return floorGain;
    const double frac = std::log(ratio) / std::log(kUnityRatio); // 0..1
    const double smooth = frac * frac * (3.0 - 2.0 * frac);      // smoothstep
    return floorGain + (1.0 - floorGain) * smooth;
}

// Self-contained STFT spectral-attenuation pass. Returns false (leaving `buffer`
// untouched beyond the high-pass already applied) when the stem is silent or the
// predicted change is inaudible.
bool applySpectralCleanup(juce::AudioBuffer<float>& buffer, double sampleRate,
                          const StrengthParams& params)
{
    const int numCh = buffer.getNumChannels();
    const int numSamples = buffer.getNumSamples();

    const int order = sampleRate <= 48000.0 ? 11 : 12; // 2048 @ <=48k, else 4096
    const int fftSize = 1 << order;
    const int hop = fftSize / 4; // 75% overlap
    const int numBins = fftSize / 2 + 1;
    if (numSamples < fftSize) return false; // too short for a single frame

    // Hann analysis/synthesis window.
    std::vector<float> window(static_cast<size_t>(fftSize));
    for (int n = 0; n < fftSize; ++n)
        window[static_cast<size_t>(n)] = 0.5F
            - 0.5F * std::cos(2.0F * juce::MathConstants<float>::pi * static_cast<float>(n)
                              / static_cast<float>(fftSize));

    // Pad front and back by one window so edge samples see full overlap.
    const int pad = fftSize;
    const int paddedLen = numSamples + 2 * pad;
    std::vector<std::vector<float>> padded(static_cast<size_t>(numCh),
                                           std::vector<float>(static_cast<size_t>(paddedLen), 0.0F));
    for (int ch = 0; ch < numCh; ++ch)
    {
        const float* src = buffer.getReadPointer(ch);
        std::copy(src, src + numSamples, padded[static_cast<size_t>(ch)].begin() + pad);
    }

    std::vector<int> frameStarts;
    for (int start = 0; start + fftSize <= paddedLen; start += hop)
        frameStarts.push_back(start);
    const int numFrames = static_cast<int>(frameStarts.size());
    if (numFrames == 0) return false;

    juce::dsp::FFT fft(order);
    std::vector<float> fftBuf(static_cast<size_t>(2 * fftSize));

    // Pass A: combined magnitude spectrogram (max over channels) + per-frame
    // energy, used for the noise-floor statistics.
    std::vector<float> mag(static_cast<size_t>(numFrames) * static_cast<size_t>(numBins), 0.0F);
    std::vector<double> frameEnergy(static_cast<size_t>(numFrames), 0.0);
    for (int f = 0; f < numFrames; ++f)
    {
        const int start = frameStarts[static_cast<size_t>(f)];
        for (int ch = 0; ch < numCh; ++ch)
        {
            std::fill(fftBuf.begin(), fftBuf.end(), 0.0F);
            const float* src = padded[static_cast<size_t>(ch)].data() + start;
            for (int n = 0; n < fftSize; ++n)
                fftBuf[static_cast<size_t>(n)] = src[n] * window[static_cast<size_t>(n)];
            fft.performRealOnlyForwardTransform(fftBuf.data());
            float* m = &mag[static_cast<size_t>(f) * static_cast<size_t>(numBins)];
            for (int k = 0; k < numBins; ++k)
            {
                const float re = fftBuf[static_cast<size_t>(2 * k)];
                const float im = fftBuf[static_cast<size_t>(2 * k + 1)];
                const float v = std::sqrt(re * re + im * im);
                m[k] = std::max(m[k], v); // linked: louder channel drives the mask
            }
        }
        const float* m = &mag[static_cast<size_t>(f) * static_cast<size_t>(numBins)];
        double e = 0.0;
        for (int k = 0; k < numBins; ++k)
            e += static_cast<double>(m[k]) * m[k];
        frameEnergy[static_cast<size_t>(f)] = e;
    }

    const double maxEnergy = *std::max_element(frameEnergy.begin(), frameEnergy.end());
    if (maxEnergy <= 0.0) return false;
    const double activeThresh = maxEnergy * kActiveFrameEnergyFraction;
    std::vector<int> activeFrames;
    for (int f = 0; f < numFrames; ++f)
        if (frameEnergy[static_cast<size_t>(f)] > activeThresh)
            activeFrames.push_back(f);
    if (activeFrames.empty()) return false;

    // Per-bin noise floor = low percentile over active frames.
    std::vector<double> floorMag(static_cast<size_t>(numBins), 0.0);
    {
        std::vector<float> column;
        column.reserve(activeFrames.size());
        for (int k = 0; k < numBins; ++k)
        {
            column.clear();
            for (int f : activeFrames)
                column.push_back(mag[static_cast<size_t>(f) * static_cast<size_t>(numBins)
                                     + static_cast<size_t>(k)]);
            floorMag[static_cast<size_t>(k)] = percentile(column, params.floorPercentile);
        }
    }

    // Broadband floor = wide-window median of the per-bin floor. A narrow tonal
    // peak can't lift this median, so a sustained tone stays far above its own
    // threshold and is preserved; only bins sitting near the broadband floor
    // (the residual's musical-noise/swirl) are attenuated.
    std::vector<double> broadbandFloor(static_cast<size_t>(numBins), 0.0);
    {
        std::vector<double> neigh;
        neigh.reserve(static_cast<size_t>(2 * kBroadbandMedianRadius + 1));
        for (int k = 0; k < numBins; ++k)
        {
            neigh.clear();
            for (int j = k - kBroadbandMedianRadius; j <= k + kBroadbandMedianRadius; ++j)
                if (j >= 0 && j < numBins)
                    neigh.push_back(floorMag[static_cast<size_t>(j)]);
            std::sort(neigh.begin(), neigh.end());
            broadbandFloor[static_cast<size_t>(k)] = neigh[neigh.size() / 2];
        }
    }

    const double floorGain = std::pow(10.0, -params.maxReductionDb / 20.0);

    // Per-frame, per-bin gain from the soft gate.
    std::vector<float> gain(static_cast<size_t>(numFrames) * static_cast<size_t>(numBins), 1.0F);
    for (int f = 0; f < numFrames; ++f)
    {
        const float* m = &mag[static_cast<size_t>(f) * static_cast<size_t>(numBins)];
        float* g = &gain[static_cast<size_t>(f) * static_cast<size_t>(numBins)];
        for (int k = 0; k < numBins; ++k)
        {
            const double thresh = broadbandFloor[static_cast<size_t>(k)] * params.overSub;
            const double ratio = thresh > 0.0 ? m[k] / thresh : kUnityRatio;
            g[k] = static_cast<float>(softGate(ratio, floorGain));
        }
    }

    // Temporal smoothing per bin: fast open (gain rising), slow close.
    const double fs = (sampleRate > 0.0 && std::isfinite(sampleRate)) ? sampleRate : 44100.0;
    const double openCoef = std::exp(-static_cast<double>(hop) / (0.020 * fs));
    const double closeCoef = std::exp(-static_cast<double>(hop) / (0.120 * fs));
    for (int k = 0; k < numBins; ++k)
    {
        double prev = gain[static_cast<size_t>(k)];
        for (int f = 1; f < numFrames; ++f)
        {
            const size_t idx = static_cast<size_t>(f) * static_cast<size_t>(numBins)
                               + static_cast<size_t>(k);
            const double target = gain[idx];
            const double coef = target > prev ? openCoef : closeCoef;
            prev = coef * prev + (1.0 - coef) * target;
            gain[idx] = static_cast<float>(prev);
        }
    }

    // Light 3-bin triangular frequency smoothing per frame.
    std::vector<float> rowCopy(static_cast<size_t>(numBins));
    for (int f = 0; f < numFrames; ++f)
    {
        float* g = &gain[static_cast<size_t>(f) * static_cast<size_t>(numBins)];
        std::copy(g, g + numBins, rowCopy.begin());
        for (int k = 1; k < numBins - 1; ++k)
            g[k] = 0.25F * rowCopy[static_cast<size_t>(k - 1)]
                   + 0.5F * rowCopy[static_cast<size_t>(k)]
                   + 0.25F * rowCopy[static_cast<size_t>(k + 1)];
    }

    // Self-bypass: predicted energy-weighted attenuation over active frames.
    double sumMag = 0.0, sumMagGain = 0.0;
    for (int f : activeFrames)
    {
        const float* m = &mag[static_cast<size_t>(f) * static_cast<size_t>(numBins)];
        const float* g = &gain[static_cast<size_t>(f) * static_cast<size_t>(numBins)];
        for (int k = 0; k < numBins; ++k)
        {
            sumMag += m[k];
            sumMagGain += static_cast<double>(m[k]) * g[k];
        }
    }
    if (sumMag <= 0.0) return false;
    const double avgAttenDb = -20.0 * std::log10(std::max(sumMagGain / sumMag, 1.0e-9));
    if (avgAttenDb < kSelfBypassAttenDb) return false;

    // Pass B: re-transform each channel, apply the shared gain mask, overlap-add
    // with explicit window-energy normalisation.
    std::vector<std::vector<float>> outAcc(static_cast<size_t>(numCh),
                                           std::vector<float>(static_cast<size_t>(paddedLen), 0.0F));
    std::vector<float> normAcc(static_cast<size_t>(paddedLen), 0.0F);
    bool normFilled = false;
    for (int ch = 0; ch < numCh; ++ch)
    {
        for (int f = 0; f < numFrames; ++f)
        {
            const int start = frameStarts[static_cast<size_t>(f)];
            std::fill(fftBuf.begin(), fftBuf.end(), 0.0F);
            const float* src = padded[static_cast<size_t>(ch)].data() + start;
            for (int n = 0; n < fftSize; ++n)
                fftBuf[static_cast<size_t>(n)] = src[n] * window[static_cast<size_t>(n)];
            fft.performRealOnlyForwardTransform(fftBuf.data());

            const float* g = &gain[static_cast<size_t>(f) * static_cast<size_t>(numBins)];
            // Scale positive bins and mirror to keep the spectrum Hermitian.
            for (int k = 0; k <= fftSize / 2; ++k)
            {
                const float gk = g[k];
                fftBuf[static_cast<size_t>(2 * k)] *= gk;
                fftBuf[static_cast<size_t>(2 * k + 1)] *= gk;
                if (k > 0 && k < fftSize / 2)
                {
                    const int mk = fftSize - k;
                    fftBuf[static_cast<size_t>(2 * mk)] *= gk;
                    fftBuf[static_cast<size_t>(2 * mk + 1)] *= gk;
                }
            }
            fft.performRealOnlyInverseTransform(fftBuf.data());

            float* acc = outAcc[static_cast<size_t>(ch)].data() + start;
            for (int n = 0; n < fftSize; ++n)
            {
                const float w = window[static_cast<size_t>(n)];
                acc[n] += fftBuf[static_cast<size_t>(n)] * w;
                if (! normFilled)
                    normAcc[static_cast<size_t>(start + n)] += w * w;
            }
        }
        normFilled = true; // window energy is channel-independent
    }

    for (int ch = 0; ch < numCh; ++ch)
    {
        float* dst = buffer.getWritePointer(ch);
        const float* acc = outAcc[static_cast<size_t>(ch)].data() + pad;
        const float* nrm = normAcc.data() + pad;
        for (int i = 0; i < numSamples; ++i)
        {
            const float w = nrm[i];
            float v = w > 1.0e-8F ? acc[i] / w : acc[i];
            if (! std::isfinite(v)) v = 0.0F;
            dst[i] = v;
        }
    }
    return true;
}

// Mid/side stereo widener. The mid (mono sum) is preserved exactly while the side
// is scaled by a small, strength-scaled amount, opening up the residual's pads /
// FX / room without affecting the fundamental balance — and because the mid is
// untouched, the result stays mono-compatible when the stems are recombined. A
// no-op on mono buffers and naturally a no-op where the channels are already
// identical (the side is zero). `widthAmount` is the extra side gain (0 = dry).
void applyStereoWidener(juce::AudioBuffer<float>& buffer, double widthAmount) noexcept
{
    if (! (widthAmount > 0.0)) return;
    if (buffer.getNumChannels() < 2) return;

    const float sideGain = static_cast<float>(1.0 + widthAmount);
    const int numSamples = buffer.getNumSamples();
    float* left = buffer.getWritePointer(0);
    float* right = buffer.getWritePointer(1);
    for (int i = 0; i < numSamples; ++i)
    {
        const float mid = 0.5F * (left[i] + right[i]);
        const float side = 0.5F * (left[i] - right[i]) * sideGain;
        left[i] = mid + side;
        right[i] = mid - side;
    }
}

// Strength-scaled side gain for the widener. Conservative so the image opens up
// without hollowing the centre or causing phase issues on summation.
double stereoWidthFor(OtherEnhanceStrength strength) noexcept
{
    switch (strength)
    {
        case OtherEnhanceStrength::Light: return 0.10;
        case OtherEnhanceStrength::Strong: return 0.30;
        case OtherEnhanceStrength::Medium:
        default: return 0.20;
    }
}

// Soft-knee peak safety is shared via enhancer_dsp::softLimitInPlace.

} // namespace

OtherEnhanceStrength otherEnhanceStrengthFromString(const juce::String& text) noexcept
{
    const auto t = text.trim().toLowerCase();
    if (t == "light") return OtherEnhanceStrength::Light;
    if (t == "strong") return OtherEnhanceStrength::Strong;
    return OtherEnhanceStrength::Medium;
}

const char* otherEnhanceStrengthToString(OtherEnhanceStrength strength) noexcept
{
    switch (strength)
    {
        case OtherEnhanceStrength::Light: return "light";
        case OtherEnhanceStrength::Strong: return "strong";
        case OtherEnhanceStrength::Medium:
        default: return "medium";
    }
}

void OtherEnhancer::process(juce::AudioBuffer<float>& buffer, double sampleRate,
                            const OtherEnhanceOptions& options)
{
    if (! options.enabled) return;
    if (buffer.getNumChannels() <= 0 || buffer.getNumSamples() <= 0) return;
    if (! (sampleRate > 0.0) || ! std::isfinite(sampleRate)) return;

    const juce::ScopedNoDenormals noDenormals;
    StrengthParams params = paramsFor(options.strength);
    double stereoWidth = stereoWidthFor(options.strength);
    // A residual from the clean RoFormer hybrid carries less subtraction swirl:
    // cap the spectral reduction lower and halve the widening so the catch-all
    // stem keeps its natural balance.
    if (options.cleanModel)
    {
        params.maxReductionDb *= 0.5;
        stereoWidth *= 0.5;
    }

    sanitiseInPlace(buffer);
    if (buffer.getMagnitude(0, buffer.getNumSamples()) <= kSilenceFloor) return;

    applyHighPass(buffer, sampleRate, params.highPassHz);
    applySpectralCleanup(buffer, sampleRate, params);

    // Enhancement: open up the stereo image (mid preserved, so it stays
    // mono-compatible), with a soft limiter so the widened side can never
    // hard-clip. No-op on mono and on silence.
    applyStereoWidener(buffer, stereoWidth);
    softLimitInPlace(buffer);
}

} // namespace silverdaw
