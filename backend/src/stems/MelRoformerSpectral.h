#pragma once

// Host-side spectral front/back-end for the Mel-Band RoFormer ("Kim Vocal 2" /
// SYHFT) vocal-separation ONNX core. The ONNX graph is the neural core only: it
// consumes a precomputed STFT and returns per-bin COMPLEX masks. Everything
// around it — framing, FFT, packing into the model's tensor layout, applying the
// masks, iFFT and overlap-add — runs here, faithfully reproducing the reference
// WebGPU host (popelenkow/musetric `packages/ai`) so the model sees exactly what
// it was exported for. Pure DSP (JUCE FFT only); no ONNX include, so it links
// into the tests and tools without the inference runtime.
//
// Contract (fixed by the export):
//   STFT:   n_fft 2048, hop 441, 44.1 kHz, periodic Hann, reflect ("centre")
//           padding by n_fft/2. One ~11 s chunk = hop*(frames-1) samples.
//   Tensor: [1, 2050, 1101, 2] = (batch, (n_fft/2+1)*channels, frames, complex),
//           packed bin index = 2*freq + channel.
//   Mask:   complex multiply of the model mask onto the STFT, then iSTFT with an
//           envelope (sum-of-window^2) normalisation.

#include <vector>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_dsp/juce_dsp.h>

namespace silverdaw
{

class MelRoformerSpectral
{
public:
    static constexpr int kFftOrder = 11;
    static constexpr int kNFft = 1 << kFftOrder; // 2048
    static constexpr int kHop = 441;
    static constexpr int kFrames = 1101;
    static constexpr int kChannels = 2;
    static constexpr int kPad = kNFft / 2;                  // 1024 (centre pad)
    static constexpr int kBins = kNFft / 2 + 1;             // 1025
    static constexpr int kPackedBins = kBins * kChannels;   // 2050
    static constexpr int kChunkSamples = kHop * (kFrames - 1); // 485100 (~11 s)
    // Float count of the model's input/output tensor [1, 2050, 1101, 2].
    static constexpr int kTensorFloats = kPackedBins * kFrames * 2;
    // Float count of one planar-stereo chunk [ch0 chunkSamples..., ch1 ...].
    static constexpr int kChunkFloats = kChannels * kChunkSamples;

    MelRoformerSpectral();

    // Frame + window + FFT + pack one planar-stereo chunk (`kChunkFloats` floats)
    // into the model input tensor `stftOut` (`kTensorFloats` floats).
    void analyze(const float* planarChunk, float* stftOut);

    // Apply the model's complex `masks` to `stft` (both `kTensorFloats`) and run
    // the inverse: iFFT + envelope-normalised overlap-add into the planar-stereo
    // `planarOut` (`kChunkFloats`). Passing an identity mask (1+0i) reconstructs
    // the input chunk (a STFT/iSTFT round-trip), which is how it is tested.
    void synthesize(const float* stft, const float* masks, float* planarOut);

private:
    juce::dsp::FFT fft;
    std::vector<float> hann;     // analysis/synthesis window, size kNFft
    std::vector<float> fftScratch; // 2*kNFft work buffer, reused per window
};

} // namespace silverdaw
