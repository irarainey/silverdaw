#include "StemSeparationEngine.h"

#include <exception>
#include <new>
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

    // Release the single-slot busy flag on EVERY exit path — even if broadcasting or
    // logging a failure throws — so a stem failure can never wedge the engine into a
    // permanent "a separation is already in progress" state.
    struct BusyReset
    {
        std::atomic<bool>& flag;
        ~BusyReset() { flag.store(false); }
    } busyReset{busyFlag};

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
        // Cancellation is a normal user action, not a failure — log it quietly. Every other
        // failure is logged at ERROR so it reaches stderr → the always-on diagnostics log,
        // making it visible even when the user hasn't enabled verbose logging.
        if (e.code == StemFailureCode::Cancelled)
            silverdaw::log::info("stems", "STEM cancelled job=" + jobId);
        else
            silverdaw::log::error("stems",
                                  "STEM_FAILED job=" + jobId + " code=" +
                                      juce::String(stemFailureCodeToString(e.code)) + " error=" + e.what());
    }
    catch (const std::bad_alloc&)
    {
        // Out of memory — by far the most likely cause of an intermittent failure on a
        // long song / low-RAM machine. Give the user an actionable message instead of a
        // raw "bad allocation", and log it distinctly so support can spot the pattern.
        const juce::String msg =
            "Ran out of memory during stem separation. Try a shorter clip, the Fast quality "
            "preset, or separating fewer stems at once.";
        stem_bridge::broadcastFailed(bridge, jobId, clipId, StemFailureCode::Inference, msg);
        silverdaw::log::error("stems", "STEM_FAILED job=" + jobId + " out-of-memory (bad_alloc)");
    }
    catch (const std::exception& e)
    {
        stem_bridge::broadcastFailed(bridge, jobId, clipId, StemFailureCode::Inference,
                                     juce::String(e.what()));
        silverdaw::log::error("stems", "STEM_FAILED job=" + jobId + " unexpected error=" + e.what());
    }
    catch (...)
    {
        // A non-std throw would otherwise escape the worker and terminate the whole
        // backend process (a far worse outcome than a clean failure toast).
        stem_bridge::broadcastFailed(bridge, jobId, clipId, StemFailureCode::Inference,
                                     "Unknown fatal error during stem separation.");
        silverdaw::log::error("stems", "STEM_FAILED job=" + jobId + " unknown non-standard exception");
    }
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
