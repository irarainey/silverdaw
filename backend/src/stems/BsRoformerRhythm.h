#pragma once

// 4-stem BS-Roformer rhythm separator ("Rhythm Pack"). Wraps the ONNX neural
// core with the host-side STFT/iSTFT engine (BsRoformerSpectral) and a
// track-level chunk driver (~8 s window, 50% Hann overlap-add) that the model
// was exported for. Runs the model once and returns the DRUMS and BASS stems at
// the SAME level as the input mixture, so the hybrid separator can keep
// `other = mix - (vocals + drums + bass)` mixture-consistent. The model's own
// vocals/other outputs are discarded (vocals come from the dedicated vocal pack;
// other is the residual).
//
// Compiled only when SILVERDAW_ENABLE_STEM_SEPARATION is on (it needs ONNX
// Runtime); the hybrid path falls back to the htdemucs drums/bass specialists
// when a rhythm model is not configured, so this is purely an opt-in quality
// upgrade. Recoverable DirectML failures propagate to the hybrid separator,
// which owns the process-wide CPU fallback policy.

#include <functional>
#include <memory>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

namespace silverdaw
{

struct BsRoformerRhythmStems
{
    juce::AudioBuffer<float> drums;
    juce::AudioBuffer<float> bass;
};

class BsRoformerRhythm
{
public:
    BsRoformerRhythm();
    ~BsRoformerRhythm();

    BsRoformerRhythm(const BsRoformerRhythm&) = delete;
    BsRoformerRhythm& operator=(const BsRoformerRhythm&) = delete;

    // Separate drums + bass from a stereo, 44.1 kHz mixture. `onProgress` is
    // called with a monotonic 0..1 fraction; `shouldCancel` is polled at chunk
    // boundaries and, when true, throws StemSeparationError{Cancelled}. Returns
    // two stereo buffers of the same length as `mixture`, at the mixture's level.
    BsRoformerRhythmStems separate(const juce::File& modelFile,
                                   const juce::AudioBuffer<float>& mixture, bool useGpu,
                                   double overlap, const std::function<void(double)>& onProgress,
                                   const std::function<bool()>& shouldCancel,
                                   const std::function<void(bool)>& onModelLoadState = {});

private:
    struct Impl;
    std::unique_ptr<Impl> impl;
};

} // namespace silverdaw
