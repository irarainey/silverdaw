#pragma once


#include "MixdownEngine.h"  // MixdownSnapshot, MixdownOptions, BridgeServer fwd
#include "LoudnessAnalyzer.h"

namespace silverdaw
{

struct OfflineFileResult
{
    std::optional<MixdownFailureCode> failure;
    juce::String message;
    double durationMs{};
    std::optional<LoudnessAnalyzer::Result> loudness;
    bool limitedByTruePeak{};
    double appliedGainDb{};
    int64_t postGainClips{};
    double postGainPeak{};
};

OfflineFileResult renderOfflineFile(const MixdownSnapshot& snapshot, MixdownOptions options,
                                    const RenderProgress& progress, std::atomic<bool>& cancelFlag);

void runMixdownJob(const MixdownSnapshot& snapshot, MixdownOptions options, BridgeServer& bridge,
                   std::atomic<bool>& cancelFlag, std::atomic<bool>& busyFlag);

} // namespace silverdaw
