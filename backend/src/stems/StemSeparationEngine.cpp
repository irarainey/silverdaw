#include "StemSeparationEngine.h"

#include <algorithm>
#include <chrono>
#include <exception>
#include <map>
#include <new>
#include <string>
#include <utility>

#include "Log.h"
#include "StemBroadcast.h"
#include "StemProgressCoalescer.h"

namespace silverdaw
{
namespace
{
class StemPerformanceTrace
{
  public:
    explicit StemPerformanceTrace(juce::String job) : jobId(std::move(job)) {}

    void recordProgress(const char* stage, const char* detail)
    {
        const auto now = Clock::now();
        const auto elapsed = elapsedMs(now);
        accountPhase(now);

        const juce::String stageText = stage != nullptr ? stage : "";
        const juce::String detailText = detail != nullptr ? detail : "";
        currentPhase = detailText.isNotEmpty() ? stageText + "/" + detailText : stageText;
        phaseStarted = now;

        ++progressMessages;
        const auto bucket = static_cast<int>(elapsed / kBurstWindowMs);
        if (bucket != currentBurstBucket)
        {
            currentBurstBucket = bucket;
            currentBurstCount = 0;
        }
        maxProgressBurst = std::max(maxProgressBurst, ++currentBurstCount);
    }

    void recordPartial(const char* stem)
    {
        ++partials;
        partialTimings.add((stem != nullptr ? juce::String(stem) : juce::String("unknown")) +
                           "@" + juce::String(elapsedMs(Clock::now()), 1));
    }

    void complete(const juce::String& outcome)
    {
        const auto now = Clock::now();
        accountPhase(now);

        juce::StringArray phases;
        for (const auto& [phase, duration] : phaseDurations)
            phases.add(juce::String(phase) + ":" + juce::String(duration, 1));

        silverdaw::log::info(
            "stem-perf",
            "summary job=" + jobId + " outcome=" + outcome +
                " totalMs=" + juce::String(elapsedMs(now), 1) +
                " progressMessages=" + juce::String(progressMessages) +
                " maxProgressPer100ms=" + juce::String(maxProgressBurst) +
                " partials=" + juce::String(partials) +
                " partialAtMs=" + partialTimings.joinIntoString(",") +
                " phaseMs=" + phases.joinIntoString(","));
    }

  private:
    using Clock = std::chrono::steady_clock;
    static constexpr double kBurstWindowMs = 100.0;

    double elapsedMs(Clock::time_point time) const
    {
        return std::chrono::duration<double, std::milli>(time - started).count();
    }

    void accountPhase(Clock::time_point now)
    {
        if (currentPhase.isNotEmpty())
        {
            const auto duration =
                std::chrono::duration<double, std::milli>(now - phaseStarted).count();
            phaseDurations[currentPhase.toStdString()] += duration;
        }
    }

    juce::String jobId;
    const Clock::time_point started = Clock::now();
    Clock::time_point phaseStarted = started;
    juce::String currentPhase;
    std::map<std::string, double> phaseDurations;
    juce::StringArray partialTimings;
    int progressMessages = 0;
    int partials = 0;
    int currentBurstBucket = -1;
    int currentBurstCount = 0;
    int maxProgressBurst = 0;
};
} // namespace

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
    StemPerformanceTrace performance(jobId);
    StemProgressCoalescer progressCoalescer;
    juce::String outcome{"unknown"};

    const StemProgressFn onProgress =
        [&bridge, &jobId, &clipId, &performance, &progressCoalescer](
            const char* stage, double percent, const char* detail)
    {
        if (! progressCoalescer.shouldEmit(stage, percent, detail))
            return;
        performance.recordProgress(stage, detail);
        stem_bridge::broadcastProgress(bridge, jobId, clipId, stage, percent,
                                       detail != nullptr ? juce::String(detail) : juce::String());
    };
    const StemReadyFn onStemReady =
        [&bridge, &jobId, &clipId, &sourceName, &performance](const StemResultFile& stem)
    {
        performance.recordPartial(stem.stem.toRawUTF8());
        stem_bridge::broadcastPartial(bridge, jobId, clipId, sourceName, stem);
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
    struct PerformanceCompletion
    {
        StemPerformanceTrace& performance;
        juce::String& outcome;
        ~PerformanceCompletion() { performance.complete(outcome); }
    } performanceCompletion{performance, outcome};

    try
    {
        auto result = separator.separate(request, onProgress, onStemReady, shouldCancel);
        stem_bridge::broadcastReady(bridge, jobId, clipId, sourceName, result.stems);
        outcome = "ready";
        silverdaw::log::info("stems",
                             "STEM_READY job=" + jobId + " clip=" + clipId +
                                 " stems=" + juce::String((int) result.stems.size()));
    }
    catch (const StemSeparationError& e)
    {
        outcome = stemFailureCodeToString(e.code);
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
        outcome = "out-of-memory";
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
        outcome = "unexpected";
        stem_bridge::broadcastFailed(bridge, jobId, clipId, StemFailureCode::Inference,
                                     juce::String(e.what()));
        silverdaw::log::error("stems", "STEM_FAILED job=" + jobId + " unexpected error=" + e.what());
    }
    catch (...)
    {
        outcome = "unknown-error";
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
