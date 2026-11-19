#include "MixdownEngine.h"

#include "MixdownRender.h"

#include <cmath>
#include <utility>

#include <juce_core/juce_core.h>

namespace silverdaw
{

std::optional<juce::Range<int64_t>> MixdownOptions::exactOutputWindow() const
{
    if (outputFrameRange || !alignTrackLength) return outputFrameRange;
    return juce::Range<int64_t>{0, static_cast<int64_t>(std::ceil(lengthMs * outputSampleRate / 1000.0))
                                   + std::llround(tailSeconds * outputSampleRate)};
}

const char* mixdownFailureCodeToString(MixdownFailureCode code) noexcept
{
    switch (code)
    {
        case MixdownFailureCode::Cancelled: return "cancelled";
        case MixdownFailureCode::Io:        return "io";
        case MixdownFailureCode::Decode:    return "decode";
        case MixdownFailureCode::Encode:    return "encode";
        case MixdownFailureCode::Invalid:   return "invalid";
    }
    return "invalid";
}

void renderMixdownAsync(MixdownSnapshot snapshot,
                        MixdownOptions options,
                        juce::ThreadPool& pool,
                        BridgeServer& bridge,
                        std::atomic<bool>& cancelFlag,
                        std::atomic<bool>& busyFlag)
{
    busyFlag.store(true);
    cancelFlag.store(false);

    pool.addJob([snapshot = std::move(snapshot), options = std::move(options), &bridge, &cancelFlag,
                 &busyFlag]() mutable { runMixdownJob(snapshot, std::move(options), bridge, cancelFlag, busyFlag); });
}

} // namespace silverdaw
