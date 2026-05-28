#pragma once

#include <atomic>
#include <cmath>
#include <memory>
#include <vector>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

// Rubber Band: see `backend/CMakeLists.txt` for the FetchContent + GPL
// licence note. Header is exposed via `rubberband_local`'s PUBLIC
// include path so the consumer sees it as `<rubberband/...>`.
#include <rubberband/RubberBandStretcher.h>

namespace silverdaw
{

/**
 * Translate a renderer-side warp mode label into Rubber Band engine
 * flags. Shared between AudioEngine (live), MixdownEngine (offline)
 * and Main.cpp's preview path so the three never drift.
 *
 *   "complex" → R3 / Finer (highest quality, highest CPU)
 *   "tonal"   → R2 / Faster + TransientsSmooth + WindowLong (suits pads/vox)
 *   anything else (default "rhythmic") → R2 / Faster + TransientsCrisp
 */
inline RubberBand::RubberBandStretcher::Options parseWarpMode(const juce::String& mode)
{
    using O = RubberBand::RubberBandStretcher;
    if (mode == "complex") return O::OptionEngineFiner;
    if (mode == "tonal")
        return O::OptionEngineFaster | O::OptionTransientsSmooth | O::OptionWindowLong;
    return O::OptionEngineFaster | O::OptionTransientsCrisp;
}

/**
 * Lock-free warp processor wrapping a single `RubberBandStretcher`.
 *
 * Lifetime + thread model:
 *   - Created on the message thread when the renderer first enables warp
 *     on a clip (CLIP_SET_WARP with `warpEnabled=true`). Held by the
 *     owning `OffsetSource` via `std::unique_ptr`.
 *   - `prepareToPlay()` and the destructor MAY allocate / free internal
 *     scratch buffers; both run on the message thread (engine prepare
 *     pass + clip removal respectively).
 *   - `process()` runs on the audio thread. It never allocates and never
 *     blocks: the only synchronisation with the message thread is via
 *     `std::atomic` publishers that the audio thread reads at the start
 *     of every block.
 *
 * Ratio convention follows the renderer-side `tempoRatio` (= projectBpm
 * / sourceBpm). Rubber Band's `setTimeRatio()` is the inverse — output
 * length / input length — so we hand it `1.0 / tempoRatio` internally
 * and keep the public API consistent with the rest of Silverdaw's warp
 * model. Pitch scale is `2^((semitones + cents/100) / 12)` and goes
 * straight into `setPitchScale()`.
 */
class WarpProcessor
{
  public:
    WarpProcessor(int numChannels, double sampleRate, RubberBand::RubberBandStretcher::Options modeOptions);
    ~WarpProcessor();

    WarpProcessor(const WarpProcessor&) = delete;
    WarpProcessor& operator=(const WarpProcessor&) = delete;

    /** Message-thread setter — atomic publish. The next `process()`
     *  call consumes the new ratio. `tempoRatio = projectBpm/sourceBpm`. */
    void setTempoRatio(double tempoRatio) noexcept
    {
        const double clamped = juce::jlimit(0.25, 4.0, tempoRatio);
        pendingTempoRatio.store(clamped, std::memory_order_release);
    }

    /** Message-thread setter — atomic publish. */
    void setPitchScale(double pitchScale) noexcept
    {
        const double clamped = juce::jlimit(0.25, 4.0, pitchScale);
        pendingPitchScale.store(clamped, std::memory_order_release);
    }

    /** Ask the audio thread to flush the stretcher's history at the
     *  start of the next block. Used after a transport seek so we don't
     *  pull stale samples out of the stretcher's internal buffer. */
    void requestReset() noexcept
    {
        resetPending.store(true, std::memory_order_release);
    }

    /** Pre-allocate the source-feed scratch buffer so `process()` never
     *  allocates on the audio thread. Idempotent. */
    void prepareToPlay(int maxBlockSamples);

    /**
     * Pull `numOutputSamples` of stretched audio into `output`,
     * sourcing input via the caller-supplied `readSource` callback.
     *
     * The callback is invoked one or more times with chunks of source
     * samples that the stretcher demands. Each call's `sourceSamplePos`
     * is an absolute position (samples since the start of the source
     * file); the callback must place exactly `numSamples` per channel
     * into the supplied per-channel pointer array.
     *
     * The processor owns the source cursor — call `seekSource()` to
     * move it (which also resets the stretcher) and `process()`
     * advances it internally as input is consumed. This keeps the
     * caller from having to know the time-stretch ratio.
     *
     * Returns the number of output samples actually produced — equal
     * to `numOutputSamples` once steady-state, possibly less while
     * the stretcher is priming after a reset.
     */
    int process(float* const* output, int numOutputSamples,
                const std::function<void(float* const* dest, juce::int64 sourceSamplePos, int numSamples)>& readSource);

    /** Move the source cursor to the given absolute sample position
     *  and force a stretcher reset on the next `process()`. Cheap;
     *  the actual reset work happens on the audio thread. */
    void seekSource(juce::int64 sourceSamplePos) noexcept
    {
        pendingSourceSeek.store(sourceSamplePos, std::memory_order_release);
        seekPending.store(true, std::memory_order_release);
    }

    /** Cheap "is the engine currently doing meaningful work" test for
     *  the engine's bypass path. */
    bool isActive() const noexcept;

    static juce::int64 timelineSamplesForSourceSamples(juce::int64 sourceSamples, double tempoRatio) noexcept
    {
        if (sourceSamples <= 0 || tempoRatio <= 0.0) return sourceSamples;
        return static_cast<juce::int64>(std::ceil(static_cast<double>(sourceSamples) / tempoRatio));
    }

    /** Audio-thread-safe getter for the currently-published tempo
     *  ratio. Used by `OffsetSource` to convert a timeline-position
     *  offset into a source-position offset when seeking the source
     *  cursor after a master-clock seek. */
    double getTempoRatio() const noexcept
    {
        return pendingTempoRatio.load(std::memory_order_acquire);
    }

    /** Number of audio channels this processor was constructed with.
     *  Always equals the source-file channel count. Required by
     *  `OffsetSource::pullThroughWarp` so the source-read callback
     *  feeds Rubber Band the correct number of input channels and
     *  the caller maps `numChannels` output planes correctly into
     *  the destination buffer (mono→stereo duplicate, surround drop
     *  to stereo, etc.). */
    int getNumChannels() const noexcept
    {
        return numChannels;
    }

  private:
    void applyPendingParams() noexcept;
    void doReset();

    const int numChannels;
    const double sampleRate;
    std::unique_ptr<RubberBand::RubberBandStretcher> stretcher;

    // Message-thread → audio-thread params. Read atomically at the
    // start of every `process()` call.
    std::atomic<double> pendingTempoRatio{1.0};
    std::atomic<double> pendingPitchScale{1.0};
    std::atomic<bool> resetPending{true};
    std::atomic<bool> seekPending{false};
    std::atomic<juce::int64> pendingSourceSeek{0};

    // Mirror of the most-recently-applied values so we can skip the
    // expensive `setTimeRatio` / `setPitchScale` calls when nothing
    // changed. Audio-thread state only.
    double appliedTempoRatio{1.0};
    double appliedPitchScale{1.0};

    // Cursor into the source — tracks where the next source read should
    // start so the caller doesn't have to. Audio-thread state only.
    juce::int64 nextSourceSample{0};
    int outputDelayToDiscard{0};

    // Pre-allocated scratch for the source-read callback. Channel-
    // interleaved pointers are computed on the fly; the underlying
    // storage is one contiguous block per channel sized to the largest
    // block the stretcher might demand in one `process()` call.
    int allocatedBlockSamples{0};
    std::vector<std::vector<float>> sourceScratch;
    std::vector<float*> sourceScratchPtrs;
    std::vector<std::vector<float>> discardScratch;
    std::vector<float*> discardScratchPtrs;
    // Pre-allocated output-pointer scratch so `process()` doesn't have
    // to `new` a `std::vector` per audio block — that would be a
    // realtime safety violation. Sized once in the constructor (length
    // = `numChannels`); reused on every block.
    std::vector<float*> outputScratchPtrs;
};

} // namespace silverdaw
