#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

struct RoformerPerformance
{
    int chunks = 0;
    double setupMs = 0.0;
    double hostPrepareMs = 0.0;
    double inferenceMs = 0.0;
    double synthesisMs = 0.0;
    double overlapAddMs = 0.0;
    double finaliseMs = 0.0;
};

void logRoformerPerformance(const juce::String& jobId, const juce::String& model,
                            const RoformerPerformance& performance);

} // namespace silverdaw
