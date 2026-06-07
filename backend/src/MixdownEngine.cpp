#include "MixdownEngine.h"

#include "MixdownRender.h"

#include <utility>

#include <juce_core/juce_core.h>

namespace silverdaw
{

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

// Public entry point. Keeps the thin "flip the flags + post the job" concern
// here; the heavy render pipeline lives in MixdownRender.cpp::runMixdownJob.
void renderMixdownAsync(MixdownSnapshot snapshot,
                        MixdownOptions options,
                        juce::ThreadPool& pool,
                        BridgeServer& bridge,
                        std::atomic<bool>& cancelFlag,
                        std::atomic<bool>& busyFlag)
{
    busyFlag.store(true);
    cancelFlag.store(false);

    pool.addJob([snapshot = std::move(snapshot),
                 options = std::move(options),
                 &bridge,
                 &cancelFlag,
                 &busyFlag]() mutable
    {
        runMixdownJob(std::move(snapshot), std::move(options), bridge, cancelFlag, busyFlag);
    });
}

} // namespace silverdaw
