#pragma once

#include "MixdownEngine.h" // MixdownSnapshot

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

#include <functional>
#include <memory>

namespace silverdaw::scratch
{

struct PreparedBacking
{
    std::shared_ptr<const juce::AudioBuffer<float>> audio;
    double sampleRate = 0.0;
};

// Renders a linear stereo mixdown of the (already track-filtered) snapshot over
// the window [anchorMs, anchorMs + durationMs) into an in-memory buffer for the
// Scratch Editor backing bed (ADR 0021, Amendment 1).  Clips are positioned on
// the absolute timeline, so rendering starts at frame 0 and only the window is
// retained.  This is a monitor bed, not a mix: it applies per-clip processing
// and track/master gain but no track tone, sends, pan, or project FX.
bool prepareBackingToBuffer(const MixdownSnapshot& snapshot,
                            double anchorMs,
                            double durationMs,
                            PreparedBacking& result,
                            juce::String& error,
                            const std::function<bool()>& shouldCancel = {});

} // namespace silverdaw::scratch
