#include "RoformerPerformance.h"

#include "Log.h"

namespace silverdaw
{

void logRoformerPerformance(const juce::String& jobId, const juce::String& model,
                            const RoformerPerformance& performance)
{
    if (jobId.isEmpty()) return;

    silverdaw::log::info(
        "stem-perf",
        "roformer-profile job=" + jobId + " model=" + model +
            " chunks=" + juce::String(performance.chunks) +
            " setupMs=" + juce::String(performance.setupMs, 1) +
            " hostPrepareMs=" + juce::String(performance.hostPrepareMs, 1) +
            " inferenceMs=" + juce::String(performance.inferenceMs, 1) +
            " synthesisMs=" + juce::String(performance.synthesisMs, 1) +
            " overlapAddMs=" + juce::String(performance.overlapAddMs, 1) +
            " finaliseMs=" + juce::String(performance.finaliseMs, 1));
}

} // namespace silverdaw
