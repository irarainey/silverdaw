#pragma once

// Shared factory for a freshly-prepared WarpProcessor with optional tempo and
// pitch pre-applied. Used by the per-clip rebuild path (AudioEngine clip-edit)
// and the preview-voice rebuild path (AudioEnginePreview.cpp) so they cannot
// drift in how they translate (mode, semitones, cents, tempoRatio) into a
// constructed processor.

#include "WarpProcessor.h"

#include <cmath>
#include <memory>
#include <optional>

#include <juce_core/juce_core.h>

namespace silverdaw
{

inline std::unique_ptr<WarpProcessor> makeWarpProcessor(
    int channels, double sampleRate, int blockSize,
    const juce::String& mode,
    std::optional<double> tempoRatio,
    std::optional<double> semitones,
    std::optional<double> cents)
{
    // Use the canonical helper from WarpProcessor.h so live, mixdown
    // and preview never drift in how they map mode strings to flags.
    const auto options = parseWarpMode(mode);
    auto wp = std::make_unique<WarpProcessor>(juce::jmax(1, channels),
                                              sampleRate > 0 ? sampleRate : 44100.0,
                                              options);
    wp->prepareToPlay(juce::jmax(64, blockSize));
    if (tempoRatio.has_value() && *tempoRatio > 0.0) wp->setTempoRatio(*tempoRatio);
    if (semitones.has_value() || cents.has_value())
    {
        const double s = semitones.value_or(0.0);
        const double c = cents.value_or(0.0);
        wp->setPitchScale(std::pow(2.0, (s + c / 100.0) / 12.0));
    }
    return wp;
}

} // namespace silverdaw
