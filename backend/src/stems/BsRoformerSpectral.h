#pragma once

// Host-side spectral front/back-end for the 4-stem BS-Roformer ("Rhythm Pack")
// ONNX core. Unlike the vocal Mel-Band RoFormer (which returns complex masks the
// host multiplies), this graph applies the mask INSIDE the network and returns
// the already-masked per-stem spectrogram, split into separate real/imag
// tensors. The host only runs the STFT (to feed the graph) and the per-stem
// iSTFT (to reconstruct each source). Pure DSP (JUCE FFT only); no ONNX include,
// so it links into the tests/tools without the inference runtime.
//
// Contract (fixed by the export, tools/.../export_4stem.py):
//   STFT:   n_fft 2048, hop 441, 44.1 kHz, periodic Hann, reflect ("centre")
//           padding by n_fft/2. One ~8 s chunk = hop*(frames-1) samples.
//   Input:  spec_real / spec_imag, each [1, 2, 1025, T] = (batch, channel,
//           freq, frame).
//   Output: out_spec_real / out_spec_imag, each [1, 4, 2, 1025, T] =
//           (batch, stem, channel, freq, frame). Stem order: drums, bass,
//           other, vocals. DC bin is zeroed in-graph.

#include <vector>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_dsp/juce_dsp.h>

namespace silverdaw
{

class BsRoformerSpectral
{
public:
    static constexpr int kFftOrder = 11;
    static constexpr int kNFft = 1 << kFftOrder; // 2048
    static constexpr int kHop = 441;
    static constexpr int kFrames = 801;          // ~8 s window (DirectML VRAM-safe)
    static constexpr int kChannels = 2;
    static constexpr int kNumStems = 4;          // drums, bass, other, vocals
    static constexpr int kPad = kNFft / 2;                    // 1024 (centre pad)
    static constexpr int kBins = kNFft / 2 + 1;              // 1025
    static constexpr int kChunkSamples = kHop * (kFrames - 1); // 352800 (~8 s)
    // Float count of one input spectrogram tensor [1, 2, 1025, T].
    static constexpr int kSpecFloats = kChannels * kBins * kFrames;
    // Float count of one output tensor [1, 4, 2, 1025, T] (real or imag).
    static constexpr int kOutFloats = kNumStems * kSpecFloats;
    // Float count of one planar-stereo chunk [ch0 chunkSamples..., ch1 ...].
    static constexpr int kChunkFloats = kChannels * kChunkSamples;

    BsRoformerSpectral();

    // Frame + window + FFT one planar-stereo chunk (`kChunkFloats` floats) into
    // the model's split input tensors `specReal` / `specImag` (`kSpecFloats` each).
    void analyze(const float* planarChunk, float* specReal, float* specImag);

    // Inverse one stem's already-masked spectrogram (`stemReal` / `stemImag`,
    // each `kSpecFloats` floats laid out [channel, freq, frame]) into the
    // planar-stereo `planarOut` (`kChunkFloats`) via iFFT + envelope-normalised
    // overlap-add. `stemReal`/`stemImag` are slices of the model output for one
    // stem (offset by stem * kSpecFloats into the [1,4,2,1025,T] tensor).
    void synthesizeStem(const float* stemReal, const float* stemImag, float* planarOut);

private:
    juce::dsp::FFT fft;
    std::vector<float> hann;       // analysis/synthesis window, size kNFft
    std::vector<float> fftScratch; // 2*kNFft work buffer, reused per window
};

} // namespace silverdaw
