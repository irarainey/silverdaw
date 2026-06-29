#include "VocalDebleeder.h"

#include <algorithm>
#include <cmath>
#include <vector>

#include <juce_dsp/juce_dsp.h>

namespace silverdaw
{
namespace
{

constexpr int kFftOrder = 11;            // 2048-point FFT
constexpr int kFftSize = 1 << kFftOrder; // 2048
constexpr int kHop = kFftSize / 4;       // 75% overlap (Hann is COLA at N/4)
constexpr float kEps = 1.0e-12f;

// Per-strength Wiener parameters. `beta` weights the instrumental's power in the
// mask denominator (higher = more aggressive bleed removal); `gMin` is the gain
// floor (the most a bin can be cut) so the de-bleed stays soft and artefact-free.
struct DebleedParams
{
    float beta;
    float gMin; // linear gain floor: 0.5 ≈ -6 dB, 0.3 ≈ -10 dB, 0.15 ≈ -16 dB
};

DebleedParams paramsFor(VocalEnhanceStrength strength) noexcept
{
    switch (strength)
    {
        case VocalEnhanceStrength::Light: return {1.0f, 0.50f};
        case VocalEnhanceStrength::Strong: return {4.0f, 0.15f};
        case VocalEnhanceStrength::Medium:
        default: return {2.0f, 0.30f};
    }
}

bool finiteBuffer(const juce::AudioBuffer<float>& b) noexcept
{
    for (int ch = 0; ch < b.getNumChannels(); ++ch)
    {
        const float* d = b.getReadPointer(ch);
        for (int i = 0; i < b.getNumSamples(); ++i)
            if (!std::isfinite(d[i])) return false;
    }
    return true;
}

} // namespace

void VocalDebleeder::process(juce::AudioBuffer<float>& vocal,
                             const juce::AudioBuffer<float>& instrumental, double sampleRate,
                             VocalEnhanceStrength strength)
{
    juce::ignoreUnused(sampleRate);
    const int channels = vocal.getNumChannels();
    const int frames = vocal.getNumSamples();
    if (channels <= 0 || frames < kFftSize) return; // too short to STFT meaningfully
    if (instrumental.getNumChannels() < channels || instrumental.getNumSamples() < frames) return;
    if (!finiteBuffer(vocal) || !finiteBuffer(instrumental)) return;

    const auto params = paramsFor(strength);

    juce::dsp::FFT fft(kFftOrder);

    // Periodic Hann analysis/synthesis window. Used on both ends, so the COLA
    // normalisation is the running sum of window^2 at each output sample.
    std::vector<float> win(static_cast<size_t>(kFftSize));
    for (int n = 0; n < kFftSize; ++n)
        win[static_cast<size_t>(n)] =
            0.5f * (1.0f - std::cos(2.0f * juce::MathConstants<float>::pi * static_cast<float>(n) /
                                    static_cast<float>(kFftSize)));

    // Reused scratch: JUCE real-only transforms pack the spectrum into a 2*N
    // buffer (N interleaved complex bins). A real-valued gain applied to every
    // complex bin preserves conjugate symmetry, so the inverse stays real.
    std::vector<float> vbuf(static_cast<size_t>(2 * kFftSize), 0.0f);
    std::vector<float> ibuf(static_cast<size_t>(2 * kFftSize), 0.0f);
    std::vector<float> outAccum(static_cast<size_t>(frames), 0.0f);
    std::vector<float> normAccum(static_cast<size_t>(frames), 0.0f);

    for (int ch = 0; ch < channels; ++ch)
    {
        std::fill(outAccum.begin(), outAccum.end(), 0.0f);
        std::fill(normAccum.begin(), normAccum.end(), 0.0f);
        const float* vIn = vocal.getReadPointer(ch);
        const float* iIn = instrumental.getReadPointer(ch);

        for (int start = 0; start + kFftSize <= frames; start += kHop)
        {
            // Windowed analysis frames (real in the first N, zero-padded complex).
            std::fill(vbuf.begin(), vbuf.end(), 0.0f);
            std::fill(ibuf.begin(), ibuf.end(), 0.0f);
            for (int n = 0; n < kFftSize; ++n)
            {
                const float w = win[static_cast<size_t>(n)];
                vbuf[static_cast<size_t>(n)] = vIn[start + n] * w;
                ibuf[static_cast<size_t>(n)] = iIn[start + n] * w;
            }

            fft.performRealOnlyForwardTransform(vbuf.data());
            fft.performRealOnlyForwardTransform(ibuf.data());

            // Conservative Wiener soft mask per complex bin: g = |V|^2 /
            // (|V|^2 + beta*|I|^2), floored at gMin. Bins the instrumental
            // dominates are attenuated; bins the vocal owns pass through.
            for (int bin = 0; bin < kFftSize; ++bin)
            {
                const size_t re = static_cast<size_t>(2 * bin);
                const size_t im = re + 1;
                const float pv = vbuf[re] * vbuf[re] + vbuf[im] * vbuf[im];
                const float pi = ibuf[re] * ibuf[re] + ibuf[im] * ibuf[im];
                float g = pv / (pv + params.beta * pi + kEps);
                if (g < params.gMin) g = params.gMin;
                vbuf[re] *= g;
                vbuf[im] *= g;
            }

            fft.performRealOnlyInverseTransform(vbuf.data());

            // Weighted overlap-add with the synthesis window; accumulate window^2
            // for the COLA normalisation applied once at the end.
            for (int n = 0; n < kFftSize; ++n)
            {
                const float w = win[static_cast<size_t>(n)];
                const size_t pos = static_cast<size_t>(start + n);
                outAccum[pos] += vbuf[static_cast<size_t>(n)] * w;
                normAccum[pos] += w * w;
            }
        }

        // Normalise the overlap-add; leave any uncovered tail (the final < hop
        // samples) untouched as the original vocal so nothing is dropped.
        float* vOut = vocal.getWritePointer(ch);
        for (int i = 0; i < frames; ++i)
        {
            const float norm = normAccum[static_cast<size_t>(i)];
            if (norm > kEps) vOut[i] = outAccum[static_cast<size_t>(i)] / norm;
        }
    }
}

} // namespace silverdaw
