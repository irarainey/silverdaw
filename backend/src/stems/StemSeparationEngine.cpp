#include "StemSeparationEngine.h"

#include <exception>
#include <utility>

#include "Log.h"
#include "StemBroadcast.h"

namespace silverdaw
{

const char* stemFailureCodeToString(StemFailureCode code) noexcept
{
    switch (code)
    {
        case StemFailureCode::Cancelled: return "cancelled";
        case StemFailureCode::Model:     return "model";
        case StemFailureCode::Decode:    return "decode";
        case StemFailureCode::Inference: return "inference";
        case StemFailureCode::Io:        return "io";
        case StemFailureCode::Invalid:   return "invalid";
    }
    return "invalid";
}

void runStemSeparationJob(StemSeparationRequest request,
                          StemSeparator& separator,
                          BridgeServer& bridge,
                          std::atomic<bool>& cancelFlag,
                          std::atomic<bool>& busyFlag)
{
    const auto jobId = request.jobId;
    const auto clipId = request.clipId;
    const auto sourceName = request.sourceName;

    const StemProgressFn onProgress =
        [&bridge, &jobId, &clipId](const char* stage, double percent, const char* detail)
    {
        stem_bridge::broadcastProgress(bridge, jobId, clipId, stage, percent,
                                       detail != nullptr ? juce::String(detail) : juce::String());
    };
    const StemReadyFn onStemReady =
        [&bridge, &jobId, &clipId, &sourceName](const char* stem, const juce::File& file)
    {
        stem_bridge::broadcastPartial(bridge, jobId, clipId, sourceName, juce::String(stem), file);
    };
    const StemCancelFn shouldCancel = [&cancelFlag]() { return cancelFlag.load(); };

    try
    {
        auto result = separator.separate(request, onProgress, onStemReady, shouldCancel);
        stem_bridge::broadcastReady(bridge, jobId, clipId, sourceName, result.stems);
        silverdaw::log::info("stems",
                             "STEM_READY job=" + jobId + " clip=" + clipId +
                                 " stems=" + juce::String((int) result.stems.size()));
    }
    catch (const StemSeparationError& e)
    {
        stem_bridge::broadcastFailed(bridge, jobId, clipId, e.code, juce::String(e.what()));
        silverdaw::log::warn("stems",
                             "STEM_FAILED job=" + jobId + " code=" +
                                 juce::String(stemFailureCodeToString(e.code)) + " error=" + e.what());
    }
    catch (const std::exception& e)
    {
        stem_bridge::broadcastFailed(bridge, jobId, clipId, StemFailureCode::Inference,
                                     juce::String(e.what()));
        silverdaw::log::error("stems", "STEM_FAILED job=" + jobId + " unexpected error=" + e.what());
    }

    busyFlag.store(false);
}

void runStemSeparationAsync(StemSeparationRequest request,
                            StemSeparator& separator,
                            juce::ThreadPool& pool,
                            BridgeServer& bridge,
                            std::atomic<bool>& cancelFlag,
                            std::atomic<bool>& busyFlag)
{
    busyFlag.store(true);
    cancelFlag.store(false);

    pool.addJob([request = std::move(request), &separator, &bridge, &cancelFlag, &busyFlag]() mutable
    {
        runStemSeparationJob(std::move(request), separator, bridge, cancelFlag, busyFlag);
    });
}

} // namespace silverdaw
