#pragma once

#include "MixdownEngine.h"

namespace silverdaw::mixdown_export
{
juce::Result encodeMp3(const juce::File& lame, const juce::File& pcm, const juce::File& output,
                       const MixdownOptions& options, int64_t frames, const std::atomic<bool>& cancel);
}
