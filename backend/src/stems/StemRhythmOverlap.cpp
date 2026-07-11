#include "StemRhythmOverlap.h"

#include <chrono>
#include <mutex>
#include <utility>
#include <vector>

namespace silverdaw
{
namespace
{
struct RhythmProgressEvent
{
    enum class Type
    {
        Separation,
        ModelLoad
    };

    Type type;
    double fraction = 0.0;
    bool loading = false;
};

struct RhythmProgressQueue
{
    std::mutex mutex;
    std::vector<RhythmProgressEvent> events;
};
} // namespace

PendingStemVocalCleanup::PendingStemVocalCleanup(
    StemCancelFn shouldCancel, StemReadyFn onReady)
    : externalCancel(std::move(shouldCancel)), publish(std::move(onReady)),
      aborted(std::make_shared<std::atomic<bool>>(false))
{
}

void PendingStemVocalCleanup::start(
    std::function<StemResultFile(const StemCancelFn&)> task)
{
    auto cancel = cancellation();
    future.emplace(std::async(
        std::launch::async,
        [task = std::move(task), cancel = std::move(cancel)]() mutable
        {
            return task(cancel);
        }));
}

bool PendingStemVocalCleanup::hasPending() const noexcept
{
    return future.has_value();
}

void PendingStemVocalCleanup::publishIfReady(bool wait)
{
    if (! future) return;
    if (! wait &&
        future->wait_for(std::chrono::milliseconds(0)) != std::future_status::ready)
        return;

    auto resultFile = future->get();
    future.reset();
    publish(resultFile);
}

StemCancelFn PendingStemVocalCleanup::cancellation() const
{
    return [external = externalCancel, aborted = aborted]
    {
        return (external && external()) || aborted->load();
    };
}

void PendingStemVocalCleanup::abort() noexcept
{
    aborted->store(true);
}

BsRoformerRhythmStems runStemRhythmWithVocalOverlap(
    BsRoformerRhythm& separator, const juce::File& modelFile,
    const juce::AudioBuffer<float>& mixture, bool useGpu, double overlap,
    const juce::String& performanceJobId,
    PendingStemVocalCleanup& vocalCleanup,
    const StemRhythmOverlapCallbacks& callbacks)
{
    const auto runRhythm = [&](const std::function<void(double)>& onProgress,
                               const std::function<void(bool)>& onModelLoadState)
    {
        return separator.separate(modelFile, mixture, useGpu, overlap, onProgress,
                                  callbacks.shouldCancel, onModelLoadState,
                                  performanceJobId);
    };

    if (! vocalCleanup.hasPending())
        return runRhythm(callbacks.onProgress, callbacks.onModelLoadState);

    const auto progressQueue = std::make_shared<RhythmProgressQueue>();
    auto rhythmFuture = std::async(
        std::launch::async,
        [&, progressQueue]
        {
            return runRhythm(
                [progressQueue](double fraction)
                {
                    const std::scoped_lock lock(progressQueue->mutex);
                    progressQueue->events.push_back(
                        {RhythmProgressEvent::Type::Separation, fraction, false});
                },
                [progressQueue](bool loading)
                {
                    const std::scoped_lock lock(progressQueue->mutex);
                    progressQueue->events.push_back(
                        {RhythmProgressEvent::Type::ModelLoad, 0.0, loading});
                });
        });

    const auto drainProgress = [&]
    {
        std::vector<RhythmProgressEvent> ready;
        {
            const std::scoped_lock lock(progressQueue->mutex);
            ready.swap(progressQueue->events);
        }
        for (const auto& event : ready)
        {
            if (event.type == RhythmProgressEvent::Type::Separation)
                callbacks.onProgress(event.fraction);
            else
                callbacks.onModelLoadState(event.loading);
        }
    };

    try
    {
        while (rhythmFuture.wait_for(std::chrono::milliseconds(25)) !=
               std::future_status::ready)
        {
            drainProgress();
            vocalCleanup.publishIfReady(false);
        }
        drainProgress();
        auto result = rhythmFuture.get();
        vocalCleanup.publishIfReady(true);
        return result;
    }
    catch (...)
    {
        vocalCleanup.abort();
        throw;
    }
}

} // namespace silverdaw
