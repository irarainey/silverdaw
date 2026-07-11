#include "StemProgressCoalescer.h"

namespace silverdaw
{

bool StemProgressCoalescer::shouldEmit(const char* stage, double percent, const char* detail)
{
    return shouldEmitAt(stage, percent, detail, Clock::now());
}

bool StemProgressCoalescer::shouldEmitAt(const char* stage, double percent, const char* detail,
                                         Clock::time_point now)
{
    const juce::String nextStage = stage != nullptr ? stage : "";
    const juce::String nextDetail = detail != nullptr ? detail : "";
    const bool contextChanged = nextStage != lastStage || nextDetail != lastDetail;
    const bool intervalElapsed = hasEmitted && now - lastEmission >= kMinimumInterval;
    const bool terminal = percent >= 100.0;

    if (hasEmitted && ! contextChanged && ! intervalElapsed && ! terminal)
        return false;

    hasEmitted = true;
    lastEmission = now;
    lastStage = nextStage;
    lastDetail = nextDetail;
    return true;
}

} // namespace silverdaw
