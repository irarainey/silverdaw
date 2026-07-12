#pragma once

#include <atomic>
#include <cmath>
#include <memory>
#include <vector>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

// Rubber Band licence note lives in `backend/CMakeLists.txt`; include path is published by `rubberband_local`.
#include <rubberband/RubberBandStretcher.h>

namespace silverdaw
{

// Shared warp-mode mapping keeps live, export, and preview Rubber Band options aligned.
inline RubberBand::RubberBandStretcher::Options parseWarpMode(const juce::String& mode)
{
    using O = RubberBand::RubberBandStretcher;
    if (mode == "complex") return O::OptionEngineFiner;
    if (mode == "tonal")
        return O::OptionEngineFaster | O::OptionTransientsSmooth | O::OptionWindowLong;
    return O::OptionEngineFaster | O::OptionTransientsCrisp;
}

// Lock-free audio-thread wrapper around one `RubberBandStretcher`.
// Message-thread setters publish atomically; `process` must not allocate or block.
// Public `tempoRatio` is project/source, but Rubber Band receives its inverse.
class WarpProcessor
{
  public:
    static constexpr int kMaxChannels = 8;

    static bool supportsChannelCount(int channelCount) noexcept
    {
        return channelCount > 0 && channelCount <= kMaxChannels;
    }

    WarpProcessor(int numChannels, double sampleRate, RubberBand::RubberBandStretcher::Options modeOptions);
    ~WarpProcessor();

    WarpProcessor(const WarpProcessor&) = delete;
    WarpProcessor& operator=(const WarpProcessor&) = delete;

    /** Message-thread atomic publish; `tempoRatio = projectBpm/sourceBpm`. */
    void setTempoRatio(double tempoRatio) noexcept
    {
        const double clamped = juce::jlimit(0.25, 4.0, tempoRatio);
        pendingTempoRatio.store(clamped, std::memory_order_release);
    }

    /** Message-thread atomic publish. */
    void setPitchScale(double pitchScale) noexcept
    {
        const double clamped = juce::jlimit(0.25, 4.0, pitchScale);
        pendingPitchScale.store(clamped, std::memory_order_release);
    }

    /** Flushes stretcher history on the next audio block after a seek. */
    void requestReset() noexcept
    {
        resetPending.store(true, std::memory_order_release);
    }

    /** Pre-allocates source-feed scratch so `process()` stays RT-safe. */
    void prepareToPlay(int maxBlockSamples);

    /** Owns the source cursor so callers do not need to track Rubber Band's time ratio. */
    int process(float* const* output, int numOutputSamples,
                const std::function<void(float* const* dest, juce::int64 sourceSamplePos, int numSamples)>& readSource);

    /** Requests an audio-thread reset at the new absolute source position. */
    void seekSource(juce::int64 sourceSamplePos) noexcept
    {
        pendingSourceSeek.store(sourceSamplePos, std::memory_order_release);
        seekPending.store(true, std::memory_order_release);
    }

    bool isActive() const noexcept;

    static juce::int64 timelineSamplesForSourceSamples(juce::int64 sourceSamples, double tempoRatio) noexcept
    {
        if (sourceSamples <= 0 || tempoRatio <= 0.0) return sourceSamples;
        return static_cast<juce::int64>(std::ceil(static_cast<double>(sourceSamples) / tempoRatio));
    }

    /** Audio-thread-safe getter for seek mapping between timeline and source offsets. */
    double getTempoRatio() const noexcept
    {
        return pendingTempoRatio.load(std::memory_order_acquire);
    }

    /** Keeps Rubber Band input planes aligned with source-file channels. */
    int getNumChannels() const noexcept
    {
        return numChannels;
    }

  private:
    static constexpr int kProcessFeedSamples = 1024;

    void applyPendingParams() noexcept;
    void doReset();

    const int numChannels;
    const double sampleRate;
    std::unique_ptr<RubberBand::RubberBandStretcher> stretcher;

    // Message-thread → audio-thread params.
    std::atomic<double> pendingTempoRatio{1.0};
    std::atomic<double> pendingPitchScale{1.0};
    std::atomic<bool> resetPending{true};
    std::atomic<bool> seekPending{false};
    std::atomic<juce::int64> pendingSourceSeek{0};

    // Audio-thread mirror avoids redundant Rubber Band parameter calls.
    double appliedTempoRatio{1.0};
    double appliedPitchScale{1.0};

    // Audio-thread source cursor.
    juce::int64 nextSourceSample{0};
    double logicalSourceSample{0.0};
    int outputDelayToDiscard{0};

    // Pre-allocated callback scratch for the largest block Rubber Band can demand.
    int allocatedBlockSamples{0};
    std::vector<std::vector<float>> sourceScratch;
    std::vector<float*> sourceScratchPtrs;
    std::vector<std::vector<float>> discardScratch;
    std::vector<float*> discardScratchPtrs;
    // Pre-allocated output pointers avoid per-block allocation.
    std::vector<float*> outputScratchPtrs;
};

} // namespace silverdaw
