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

inline double warpPitchScale(double semitones, double cents) noexcept
{
    return std::pow(2.0, (semitones + cents / 100.0) / 12.0);
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

    WarpProcessor(int numChannels, double sampleRate,
                  RubberBand::RubberBandStretcher::Options modeOptions,
                  double initialPitchScale = 1.0,
                  int maxProcessSamples = 1024);
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

    static RubberBand::RubberBandStretcher::Options realtimeOptionsFor(
        RubberBand::RubberBandStretcher::Options modeOptions,
        double initialPitchScale) noexcept;

    /** Audio-thread-safe getter for seek mapping between timeline and source offsets. */
    double getTempoRatio() const noexcept
    {
        return pendingTempoRatio.load(std::memory_order_acquire);
    }

    // Counts blocks `process` could not fill, each of which silence-fills and re-primes
    // the stretcher. The offline render pulls the same processor with no deadline, so a
    // count that is non-zero live and zero offline identifies read-ahead starvation
    // rather than a difference in Rubber Band's configuration.
    juce::uint32 getShortfallCount() const noexcept
    {
        return shortfallCount.load(std::memory_order_relaxed);
    }

    // Output samples produced per second of wall clock spent producing them, divided by the
    // sample rate: 1.0 is exactly real time. Live playback needs every warped clip sharing
    // the read-ahead thread to sustain well above 1.0 between them; the offline render has
    // no such floor, which is why the same processor can sound clean exported and not live.
    // Returns 0.0 before any measurable work.
    double getRealtimeFactor() const noexcept
    {
        const auto ticks = processTicks.load(std::memory_order_relaxed);
        const auto samples = processedOutputSamples.load(std::memory_order_relaxed);
        if (ticks <= 0 || samples <= 0 || sampleRate <= 0.0) return 0.0;
        const double seconds = static_cast<double>(ticks)
                             / static_cast<double>(juce::Time::getHighResolutionTicksPerSecond());
        if (seconds <= 0.0) return 0.0;
        return static_cast<double>(samples) / (seconds * sampleRate);
    }

    /** Keeps Rubber Band input planes aligned with source-file channels. */
    int getNumChannels() const noexcept
    {
        return numChannels;
    }

  private:
    void applyPendingParams() noexcept;
    void updateTransientsForPitch(double pitchScale) noexcept;
    void doReset();

    const int numChannels;
    const double sampleRate;
    const int processFeedSamples;
    std::unique_ptr<RubberBand::RubberBandStretcher> stretcher;

    // Message-thread → audio-thread params.
    std::atomic<double> pendingTempoRatio{1.0};
    std::atomic<double> pendingPitchScale{1.0};
    std::atomic<bool> resetPending{true};
    std::atomic<bool> seekPending{false};
    std::atomic<juce::int64> pendingSourceSeek{0};
    std::atomic<juce::uint32> shortfallCount{0};
    std::atomic<juce::int64> processedOutputSamples{0};
    std::atomic<juce::int64> processTicks{0};

    // Audio-thread mirror avoids redundant Rubber Band parameter calls.
    double appliedTempoRatio{1.0};
    double appliedPitchScale{1.0};
    bool canChangePitchOption = false;
    bool highConsistencyPitch = false;
    // True for an R2 mode whose transient handling is crisp, which is the only case where
    // the pitch-dependent transients choice applies.
    bool crispTransientsMode = false;
    bool transientsMixedForPitch = false;

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
