#include "BsRoformerSpectral.h"

#include <algorithm>
#include <cmath>

namespace silverdaw
{
namespace
{

// Reflect ("centre") padding, matching numpy/torch `pad_mode='reflect'`: mirror
// without repeating the edge sample.
inline int reflectIndex(int index, int samples) noexcept
{
    if (index < 0) return -index;
    if (index >= samples) return 2 * samples - 2 - index;
    return index;
}

} // namespace

BsRoformerSpectral::BsRoformerSpectral()
    : fft(kFftOrder), hann(static_cast<size_t>(kNFft)),
      fftScratch(static_cast<size_t>(2 * kNFft), 0.0f)
{
    // Periodic Hann (divisor n_fft, not n_fft-1) — matches torch.hann_window.
    for (int n = 0; n < kNFft; ++n)
        hann[static_cast<size_t>(n)] =
            0.5f - 0.5f * std::cos(2.0f * juce::MathConstants<float>::pi * static_cast<float>(n) /
                                   static_cast<float>(kNFft));
}

void BsRoformerSpectral::analyze(const float* planarChunk, float* specReal, float* specImag)
{
    for (int channel = 0; channel < kChannels; ++channel)
    {
        const float* src = planarChunk + static_cast<size_t>(channel) * kChunkSamples;
        for (int frame = 0; frame < kFrames; ++frame)
        {
            std::fill(fftScratch.begin(), fftScratch.end(), 0.0f);
            for (int n = 0; n < kNFft; ++n)
            {
                const int sample = reflectIndex(frame * kHop + n - kPad, kChunkSamples);
                fftScratch[static_cast<size_t>(n)] = src[sample] * hann[static_cast<size_t>(n)];
            }
            fft.performRealOnlyForwardTransform(fftScratch.data());

            // Layout [channel, freq, frame] within a [1, 2, 1025, T] tensor.
            for (int freq = 0; freq < kBins; ++freq)
            {
                const size_t dst = (static_cast<size_t>(channel) * kBins + freq) * kFrames + frame;
                specReal[dst] = fftScratch[static_cast<size_t>(2 * freq)];
                specImag[dst] = fftScratch[static_cast<size_t>(2 * freq + 1)];
            }
        }
    }
}

void BsRoformerSpectral::synthesizeStem(const float* stemReal, const float* stemImag,
                                        float* planarOut)
{
    std::vector<float> frameTime(static_cast<size_t>(kNFft));

    for (int channel = 0; channel < kChannels; ++channel)
    {
        float* out = planarOut + static_cast<size_t>(channel) * kChunkSamples;
        std::vector<float> acc(static_cast<size_t>(kChunkSamples), 0.0f);
        std::vector<float> env(static_cast<size_t>(kChunkSamples), 0.0f);

        for (int frame = 0; frame < kFrames; ++frame)
        {
            std::fill(fftScratch.begin(), fftScratch.end(), 0.0f);
            for (int freq = 0; freq < kBins; ++freq)
            {
                const size_t off =
                    (static_cast<size_t>(channel) * kBins + freq) * kFrames + frame;
                float outRe = stemReal[off];
                float outIm = stemImag[off];
                if (freq == 0 || freq == kNFft / 2) outIm = 0.0f; // DC + Nyquist are real
                fftScratch[static_cast<size_t>(2 * freq)] = outRe;
                fftScratch[static_cast<size_t>(2 * freq + 1)] = outIm;
            }
            for (int k = kNFft / 2 + 1; k < kNFft; ++k)
            {
                const int mirror = kNFft - k;
                fftScratch[static_cast<size_t>(2 * k)] = fftScratch[static_cast<size_t>(2 * mirror)];
                fftScratch[static_cast<size_t>(2 * k + 1)] =
                    -fftScratch[static_cast<size_t>(2 * mirror + 1)];
            }

            fft.performRealOnlyInverseTransform(fftScratch.data()); // normalised by 1/N

            for (int n = 0; n < kNFft; ++n)
                frameTime[static_cast<size_t>(n)] = fftScratch[static_cast<size_t>(n)];

            const int base = frame * kHop - kPad;
            for (int n = 0; n < kNFft; ++n)
            {
                const int sample = base + n;
                if (sample < 0 || sample >= kChunkSamples) continue;
                const float w = hann[static_cast<size_t>(n)];
                acc[static_cast<size_t>(sample)] += frameTime[static_cast<size_t>(n)] * w;
                env[static_cast<size_t>(sample)] += w * w;
            }
        }

        for (int i = 0; i < kChunkSamples; ++i)
        {
            const float e = env[static_cast<size_t>(i)];
            out[i] = e > 1.0e-8f ? acc[static_cast<size_t>(i)] / e : 0.0f;
        }
    }
}

} // namespace silverdaw
