#pragma once

#include <atomic>
#include <future>
#include <functional>
#include <memory>
#include <optional>

#include "BsRoformerRhythm.h"
#include "StemSeparator.h"

namespace silverdaw
{

struct StemRhythmOverlapCallbacks
{
    std::function<void(double)> onProgress;
    std::function<void(bool)> onModelLoadState;
    StemCancelFn shouldCancel;
};

class PendingStemVocalCleanup
{
public:
    PendingStemVocalCleanup(StemCancelFn shouldCancel, StemReadyFn onReady);

    void start(std::function<StemResultFile(const StemCancelFn&)> task);
    bool hasPending() const noexcept;
    void publishIfReady(bool wait);
    StemCancelFn cancellation() const;
    void abort() noexcept;

private:
    StemCancelFn externalCancel;
    StemReadyFn publish;
    std::shared_ptr<std::atomic<bool>> aborted;
    std::optional<std::future<StemResultFile>> future;
};

BsRoformerRhythmStems runStemRhythmWithVocalOverlap(
    BsRoformerRhythm& separator, const juce::File& modelFile,
    const juce::AudioBuffer<float>& mixture, bool useGpu, double overlap,
    const juce::String& performanceJobId,
    PendingStemVocalCleanup& vocalCleanup,
    const StemRhythmOverlapCallbacks& callbacks);

} // namespace silverdaw
