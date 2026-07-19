#pragma once

#include "ProjectStateTypes.h"

#include <memory>
#include <vector>

#include <juce_core/juce_core.h>

namespace silverdaw
{

struct BeatRepeatRegionSamples
{
    juce::int64 startSample{0};
    juce::int64 endSample{0};
    int divisionSamples{0};
};

struct BeatRepeatSnapshot
{
    std::vector<BeatRepeatRegionSamples> regions;
};

std::unique_ptr<BeatRepeatSnapshot> makeBeatRepeatSnapshot(
    const std::vector<BeatRepeatRegion>& regions, double sampleRate, double bpm);

} // namespace silverdaw
