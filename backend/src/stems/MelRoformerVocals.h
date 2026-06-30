#pragma once

// Mel-Band RoFormer ("Kim Vocal 2" / SYHFT) vocal separator. Wraps the ONNX
// neural core with the host-side STFT/iSTFT engine (MelRoformerSpectral) and the
// track-level chunk driver (8 s step / ~11 s window, Hamming overlap-add, peak
// normalisation) that the model was exported for. Produces an isolated VOCAL
// stem at the SAME level as the input mixture, so the hybrid separator can keep
// `other = mix - (vocals + drums + bass)` mixture-consistent.
//
// Compiled only when SILVERDAW_ENABLE_STEM_SEPARATION is on (it needs ONNX
// Runtime); the hybrid path falls back to the htdemucs vocal specialist when a
// RoFormer model is not configured, so this is purely an opt-in quality upgrade.

#include <functional>
#include <memory>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

namespace silverdaw
{

class MelRoformerVocals
{
public:
    MelRoformerVocals();
    ~MelRoformerVocals();

    MelRoformerVocals(const MelRoformerVocals&) = delete;
    MelRoformerVocals& operator=(const MelRoformerVocals&) = delete;

    // Separate the vocal stem from a stereo, 44.1 kHz mixture. `onProgress` is
    // called with a monotonic 0..1 fraction; `shouldCancel` is polled at chunk
    // boundaries and, when true, throws StemSeparationError{Cancelled}. Returns a
    // stereo buffer of the same length as `mixture`, at the mixture's level.
    juce::AudioBuffer<float> separate(const juce::File& modelFile,
                                      const juce::AudioBuffer<float>& mixture, bool useGpu,
                                      double overlap, const std::function<void(double)>& onProgress,
                                      const std::function<bool()>& shouldCancel);

private:
    struct Impl;
    std::unique_ptr<Impl> impl;
};

} // namespace silverdaw
