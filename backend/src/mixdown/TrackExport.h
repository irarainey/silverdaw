#pragma once

#include "MixdownEngine.h"

namespace silverdaw
{

struct TrackExportResult
{
    std::optional<MixdownFailureCode> failure;
    juce::String message;
    juce::File folder;
};

using TrackExportProgress = std::function<void(double, const char*, int, int, const juce::String&)>;

TrackExportResult renderTrackBatch(MixdownSnapshot snapshot, const juce::File& exportDir,
                                   MixdownOptions options, bool includeEffects,
                                   const TrackExportProgress& progress, std::atomic<bool>& cancel);

} // namespace silverdaw
