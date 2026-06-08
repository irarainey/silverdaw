#pragma once

// libsamplerate may leave input unconsumed; preserve leftovers to avoid render drift.

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

// Block size bounds warp work and keeps cancellation responsive.
constexpr int kBlockFrames = 4096;
constexpr int kOutputChannels = 2;
constexpr int kFinalResampleHeadroom = 16;

// Offline wrapper preserves mono duplication and literal gain parity.
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
            info.buffer->applyGain(info.startSample, info.numSamples, gain);
        }
    }

private:
    juce::AudioSource* inner;
    float gain;
    int sourceChannels;
};

struct OfflineClip
{
    juce::String id;
    juce::String trackId;
    float trackGain{1.0F};
    double sourceRate{0.0};
    int sourceChannels{1};
    juce::int64 timelineEndFrames{0};
    juce::int64 tailFrames{0};
    bool retired{false};

    std::unique_ptr<juce::AudioFormatReaderSource> readerSource;
    std::unique_ptr<WarpProcessor> warp;
    std::unique_ptr<OffsetSource> offsetSource;
    std::unique_ptr<EnvelopeSnapshot> envelopeSnapshot;
    std::unique_ptr<EdgeFadeSnapshot> edgeFadeSnapshot;
    std::unique_ptr<juce::AudioTransportSource> transport;
    // Member order preserves JUCE source lifetimes during teardown.
    std::unique_ptr<ClipSummingSource> summingSource;
};

std::unique_ptr<OfflineClip> buildOfflineClip(const MixdownSnapshot::ClipSnapshot& clip,
                                              const juce::String& trackId,
                                              float trackGain,
                                              int projectSampleRate,
                                              juce::AudioFormatManager& formatManager,
                                              juce::String& outError);

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
            return write(interleaved, inputFrames);
        }
        const double ratio = static_cast<double>(dstRate_) / static_cast<double>(srcRate_);
        int consumed = 0;
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

            if (consumed >= inputFrames
                && (!endOfInput || d.output_frames_gen == 0))
            {
                break;
            }
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
