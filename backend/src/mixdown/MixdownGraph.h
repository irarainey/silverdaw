#pragma once

// Offline source-graph domain for the mixdown render: the per-clip JUCE source
// chain (ClipSummingSource / OfflineClip / buildOfflineClip) and the streaming
// libsamplerate sink (FinalResampler). Mirrors the live engine topology so the
// exported file is produced by the same code path as playback.

#include "AudioEngine.h"   // OffsetSource
#include "EdgeFadeSnapshot.h"
#include "EnvelopeSnapshot.h"
#include "MixdownEngine.h"  // MixdownSnapshot
#include "MixdownTiming.h"
#include "WarpProcessor.h"

#include <memory>
#include <vector>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>

#include <samplerate.h>

namespace silverdaw::mixdown_graph
{

// Block size bounds WarpProcessor's internal 64-iteration safety cap and
// matches the live engine's typical block sizes for tight cancellation.
constexpr int kBlockFrames = 4096;
constexpr int kOutputChannels = 2;
// Output capacity headroom for libsamplerate's final pass (largest expected
// upsample ratio is ~1.09×, e.g. 44.1 → 48 kHz).
constexpr int kFinalResampleHeadroom = 16;

/**
 * Audio-source adapter wrapping a single offline clip's
 * `AudioTransportSource` for attachment to `BusGraph::TrackRuntime`.
 * Replaces the inline `mixClipBlock` summing path used pre-1d so
 * the offline render walks the same `BusGraph → TrackRuntime →
 * TrackChain` pipeline the live engine uses.
 *
 * Two operations are baked in (post the inner transport pull):
 *
 * 1. **Mono-to-stereo duplication.** Mono sources have transports
 *    configured with `numChannels=1`, so they only write channel 0.
 *    The pre-1d `mixClipBlock` duplicated ch0 → ch1 explicitly; we
 *    do the same here for parity. Stereo and multichannel sources
 *    leave both channels untouched.
 * 2. **Constant `trackGain` multiplication.** A simple `applyGain`
 *    matching pre-1d's `mixL[i] += l[i] * g` loop bit-for-bit.
 *    Deliberately bypasses `AudioTransportSource::setGain`, which
 *    applies a per-block linear ramp from `lastGain` to `gain` —
 *    that ramp would change pre/post-1d mixdown samples at the
 *    first block. (Live still uses the smoothed transport gain;
 *    the live/mixdown divergence on block 0 of a clip predates
 *    this refactor.)
 *
 * Non-owning pointer to inner; the owning `unique_ptr` lives on
 * `OfflineClip::transport` and is declared so it outlives this
 * wrapper.
 */
class ClipSummingSource final : public juce::AudioSource
{
public:
    ClipSummingSource(juce::AudioSource* innerSource,
                      float gainScalar,
                      int sourceChannelCount) noexcept
        : inner(innerSource), gain(gainScalar), sourceChannels(sourceChannelCount)
    {
    }

    void prepareToPlay(int samplesPerBlockExpected, double sampleRate) override
    {
        if (inner != nullptr) inner->prepareToPlay(samplesPerBlockExpected, sampleRate);
    }

    void releaseResources() override
    {
        if (inner != nullptr) inner->releaseResources();
    }

    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override
    {
        if (inner != nullptr) inner->getNextAudioBlock(info);
        if (info.buffer == nullptr || info.numSamples <= 0) return;

        if (sourceChannels < 2 && info.buffer->getNumChannels() >= 2)
        {
            info.buffer->copyFrom(1, info.startSample,
                                  *info.buffer, 0, info.startSample,
                                  info.numSamples);
        }
        if (! juce::approximatelyEqual(gain, 1.0F))
        {
            info.buffer->applyGain(info.startSample, info.numSamples, gain);
        }
        else if (gain != 1.0F)
        {
            // Defensive parity path. `approximatelyEqual` treats
            // values within a small epsilon of 1.0 as equal and
            // would skip the multiply — but the pre-1d
            // `mixClipBlock` performed a literal `* g` for every
            // non-exact-unity gain. A snapshot gain of e.g.
            // 0.99999994f would diverge by a few LSBs across the
            // entire clip if we relied on the approximate check
            // alone, breaking the §7.9.6 sample-parity gate.
            info.buffer->applyGain(info.startSample, info.numSamples, gain);
        }
    }

private:
    juce::AudioSource* inner;
    float gain;
    int sourceChannels;
};

/**
 * Per-clip offline source chain. Owns the exact same JUCE graph nodes the
 * live engine uses, just driven from this worker thread instead of the audio
 * thread. `pull()` fills a stereo buffer at projectRate; the resampling +
 * warp + timeline-windowing all happen inside the wrapped JUCE chain.
 *
 * The chain holds a non-owning pointer to WarpProcessor (mirroring live —
 * OffsetSource doesn't own it), so the unique_ptr for the warp processor
 * must outlive the offsetSource. Destruction order in the struct (members
 * are destroyed in reverse declaration order) is chosen so the transport
 * tears down first, then the offsetSource, then the warp processor, then
 * the reader source — matching the live engine's teardown order.
 */
struct OfflineClip
{
    juce::String id;
    /** UI track id this clip belongs to. Used by step 1d to group
     *  clips into the canonical `BusGraph::TrackRuntime` for the
     *  offline render — one runtime per UI track, summing every
     *  clip on it through the same `TrackChain` the live engine
     *  uses. */
    juce::String trackId;
    float trackGain{1.0F};
    double sourceRate{0.0};
    int sourceChannels{1};
    /** Timeline frames at projectRate at which this clip is finished — once
     *  the master cursor passes this we stop pulling from this clip. */
    juce::int64 timelineEndFrames{0};
    /** Trailing tail length (in projectRate frames) the clip's processor
     *  chain needs to be pumped AFTER `timelineEndFrames` to fully drain
     *  late-arriving output samples (reverb decay, EQ smear, etc.). 0
     *  today — the warp processor's own start-delay is pre-discarded
     *  inside `WarpProcessor::doReset`, so warp adds no trailing tail.
     *  Scaffolding for the upcoming per-clip FX layer: when reverb is
     *  added, its decay tail (e.g. 4 s at projectRate) will land here
     *  and both `totalProjectFrames` and the retirement check below
     *  will automatically respect it. */
    juce::int64 tailFrames{0};
    /** Set true once the timeline cursor has cleared timelineEndFrames AND
     *  any internal tail has been drained. Retired clips are skipped in the
     *  pump loop and their chain is left in place until the engine tears
     *  down — keeping it alive is cheap (handles, no audio work). */
    bool retired{false};

    // Declared in chain order; destroyed in reverse — see comment above.
    std::unique_ptr<juce::AudioFormatReaderSource> readerSource;
    std::unique_ptr<WarpProcessor> warp;
    std::unique_ptr<OffsetSource> offsetSource;
    /** Owns the volume-envelope snapshot for the offline render. The
     *  `OffsetSource` holds a non-owning pointer; rendering is single-
     *  threaded so no retire discipline is needed here — the snapshot
     *  simply outlives the clip's source chain. */
    std::unique_ptr<EnvelopeSnapshot> envelopeSnapshot;
    /** Owns the transition edge-fade snapshot for the offline render
     *  (§12.1). Non-owning pointer held by the `OffsetSource`; single-
     *  threaded render means no retire discipline is needed. */
    std::unique_ptr<EdgeFadeSnapshot> edgeFadeSnapshot;
    std::unique_ptr<juce::AudioTransportSource> transport;
    /** Wraps `transport` for attachment to `BusGraph::TrackRuntime`
     *  (Phase 5 step 1d). Declared LAST so it destructs FIRST — the
     *  wrapper holds a raw pointer to `transport` and must die
     *  before the transport it points at. */
    std::unique_ptr<ClipSummingSource> summingSource;
};

/**
 * Build one OfflineClip from the snapshot entry. Returns nullptr on failure
 * (the caller decides how to surface that). `formatManager` must outlive the
 * returned clip.
 */
std::unique_ptr<OfflineClip> buildOfflineClip(const MixdownSnapshot::ClipSnapshot& clip,
                                              const juce::String& trackId,
                                              float trackGain,
                                              int projectSampleRate,
                                              juce::AudioFormatManager& formatManager,
                                              juce::String& outError);

/**
 * Streaming libsamplerate sink used for the final projectRate→outputRate pass.
 * Maintains the input cursor across calls and properly handles the case where
 * `src_process` consumes fewer input frames than supplied (a real streaming
 * bug in the old implementation — leftover frames were silently dropped,
 * causing compounding drift in long renders).
 *
 * Use:
 *   FinalResampler r(srcRate, dstRate);
 *   for each block: r.push(mixInterleaved, frames, isLast, writeCallback);
 *   r.flush(writeCallback); // after last push with isLast=true
 *
 * `writeCallback(const float* interleaved, int frames)` is invoked for every
 * batch of output frames produced. Throws nothing; returns false if the
 * resampler had a hard error (callers should treat as fatal).
 */
class FinalResampler
{
public:
    FinalResampler(int srcRate, int dstRate) : srcRate_(srcRate), dstRate_(dstRate)
    {
        if (srcRate_ != dstRate_)
        {
            int err = 0;
            state_ = src_new(SRC_SINC_MEDIUM_QUALITY, kOutputChannels, &err);
            if (state_ == nullptr)
            {
                lastError_ = src_strerror(err);
            }
        }
    }
    ~FinalResampler() { if (state_) src_delete(state_); }

    bool ok() const { return srcRate_ == dstRate_ || state_ != nullptr; }
    const char* error() const { return lastError_; }
    bool active() const { return state_ != nullptr; }

    template <typename WriteFn>
    bool push(const float* interleaved, int inputFrames, bool endOfInput, WriteFn&& write)
    {
        if (state_ == nullptr)
        {
            // Pass-through — no resampling needed.
            return write(interleaved, inputFrames);
        }
        const double ratio = static_cast<double>(dstRate_) / static_cast<double>(srcRate_);
        int consumed = 0;
        // Loop until libsamplerate has consumed every input frame. Without
        // this loop, output-buffer pressure can leave input_frames_used <
        // input_frames and the leftover would be silently dropped — that
        // was a confirmed source of timeline drift in the previous
        // implementation.
        while (consumed < inputFrames || endOfInput)
        {
            const int remainingInput = inputFrames - consumed;
            const int outputCap =
                static_cast<int>(std::ceil(juce::jmax(remainingInput, 1) * ratio))
                + kFinalResampleHeadroom;
            scratch_.resize(static_cast<size_t>(outputCap) * 2);

            SRC_DATA d{};
            d.data_in = (remainingInput > 0)
                            ? interleaved + static_cast<std::ptrdiff_t>(consumed) * 2
                            : nullptr;
            d.input_frames = remainingInput;
            d.data_out = scratch_.data();
            d.output_frames = outputCap;
            d.end_of_input = endOfInput ? 1 : 0;
            d.src_ratio = ratio;

            const int err = src_process(state_, &d);
            if (err != 0)
            {
                lastError_ = src_strerror(err);
                return false;
            }
            consumed += static_cast<int>(d.input_frames_used);

            if (d.output_frames_gen > 0)
            {
                if (!write(scratch_.data(), static_cast<int>(d.output_frames_gen)))
                {
                    return false;
                }
            }

            // Termination: if we've consumed everything and either we're
            // not flushing, or we are flushing but libsamplerate produced
            // no further output, we're done with this call.
            if (consumed >= inputFrames
                && (!endOfInput || d.output_frames_gen == 0))
            {
                break;
            }
            // Guard against pathological loops: if no progress at all, bail
            // out rather than spin forever. Shouldn't happen with a
            // well-sized output buffer but worth keeping honest.
            if (d.input_frames_used == 0 && d.output_frames_gen == 0)
            {
                break;
            }
        }
        return true;
    }

private:
    int srcRate_{0};
    int dstRate_{0};
    SRC_STATE* state_{nullptr};
    std::vector<float> scratch_;
    const char* lastError_{nullptr};
};

} // namespace silverdaw::mixdown_graph
