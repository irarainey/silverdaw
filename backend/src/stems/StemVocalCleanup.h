#pragma once

#include <functional>

#include <juce_audio_basics/juce_audio_basics.h>

#include "StemSeparator.h"

namespace silverdaw
{

using StemVocalCleanupProgressFn = std::function<void(double)>;

void processStemVocalCleanup(juce::AudioBuffer<float>& vocal,
                             const juce::AudioBuffer<float>& normalisedMixture,
                             float mixtureMean, float mixtureStandardDeviation,
                             const StemSeparationRequest& request, bool vocalFromRoformer,
                             const StemVocalCleanupProgressFn& onProgress,
                             const StemCancelFn& shouldCancel);

} // namespace silverdaw
