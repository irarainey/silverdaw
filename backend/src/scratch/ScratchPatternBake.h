#pragma once

// Offline (non-real-time) render of a recorded scratch pattern over its prepared
// source audio into a plain audio buffer. Used to "bake" a saved scratch into an
// ordinary WAV sample so a placed timeline clip behaves like any other sample.
//
// Fidelity: the bake drives a private ScratchAudioSource through the SAME DSP
// path as live pattern replay (VinylScratchProcessor + evaluator), so the frozen
// audio matches what the performer heard. It runs on a worker/message thread over
// an immutable source buffer and never touches the audio callback or shared
// engine state.

#include "ScratchProtocol.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <memory>

namespace silverdaw::scratch
{

// Render `pattern` over `preparedSource` (the exact audio the scratch was
// performed over, at `sampleRate`) into a stereo buffer whose length matches the
// pattern's cropped duration. Returns an empty buffer when the pattern has no
// usable keyframes or the source is missing.
juce::AudioBuffer<float> bakePatternToBuffer(
    const Pattern& pattern,
    std::shared_ptr<const juce::AudioBuffer<float>> preparedSource,
    double sampleRate);

} // namespace silverdaw::scratch
