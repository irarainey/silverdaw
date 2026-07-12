#pragma once

// Silverdaw tempoRatio is project/source; Rubber Band receives the inverse internally.

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
    const auto options = parseWarpMode(mode);
    const double s = semitones.value_or(0.0);
    const double c = cents.value_or(0.0);
    const double pitchScale = warpPitchScale(s, c);
    auto wp = std::make_unique<WarpProcessor>(juce::jmax(1, channels),
                                              sampleRate > 0 ? sampleRate : 44100.0,
                                              options, pitchScale);
    wp->prepareToPlay(juce::jmax(64, blockSize));
    if (tempoRatio.has_value() && *tempoRatio > 0.0) wp->setTempoRatio(*tempoRatio);
    return wp;
}

} // namespace silverdaw
