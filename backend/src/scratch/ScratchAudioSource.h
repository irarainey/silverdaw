#pragma once

#include "VinylScratchProcessor.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <atomic>
#include <cstdint>
#include <memory>

namespace silverdaw::scratch
{

struct PatternReplaySnapshot;

class ScratchAudioSource final : public juce::AudioSource
{
  public:
    struct Snapshot
    {
        std::int64_t positionUs = 0;
        std::int64_t durationUs = 0;
        double platterTurns = 0.0;
        double playbackRate = 0.0;
        bool playing = false;
        bool touched = false;
    };

    ScratchAudioSource();

    ScratchAudioSource(std::shared_ptr<const juce::AudioBuffer<float>> preparedAudio,
                       double preparedSampleRate);

    void prepareToPlay(int samplesPerBlockExpected, double outputSampleRate) override;
    void releaseResources() override;
    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override;

    // Attach prepared audio and mark the source active.  Message-thread only.
    // Quiesces any in-flight callback before mutating internal state.
    void activate(std::shared_ptr<const juce::AudioBuffer<float>> preparedAudio,
                  double preparedSampleRate);

    // Mark inactive and silence the output.  Message-thread only.
    // Does NOT release the audio buffer while a callback may be in-flight;
    // the buffer is released on the next activate or destructor.
    void deactivate() noexcept;

    bool isActive() const noexcept { return active.load(std::memory_order_acquire); }

    void setPlaying(bool shouldPlay) noexcept;
    void setTouched(bool isTouched) noexcept;
    void setManualRate(double semanticRate, double holdSeconds = 0.05) noexcept;
    void setGain(float gain) noexcept;
    void seekUs(std::int64_t positionUs) noexcept;
    void beginPatternReplay(const PatternReplaySnapshot* snapshot) noexcept;
    void endPatternReplay() noexcept;
    bool consumeEndReached() noexcept;
    bool isAtForwardBoundary() const noexcept;

    // Draft/pattern replay progress for UI playheads.  True while a replay
    // snapshot is driving the source; the normalized position runs 0→1 across
    // the replayed (cropped) pattern window.
    bool isPatternReplaying() const noexcept
    {
        return replaySnapshot.load(std::memory_order_acquire) != nullptr;
    }
    double replayPositionNormalized() const noexcept
    {
        return replayNormalized.load(std::memory_order_acquire);
    }

    Snapshot snapshot() const noexcept;

  private:
    // Waits for any in-flight audio callback to finish.  Must be called from
    // the message/control thread, NEVER from the audio callback.
    void waitForCallbackQuiescence() const noexcept;

    std::shared_ptr<const juce::AudioBuffer<float>> audio;
    double sourceSampleRate = 44100.0;
    double outputSampleRate = 44100.0;
    double sourceSamplesPerOutputSample = 1.0;
    VinylScratchProcessor processor;

    std::atomic<bool> active{false};
    // In-flight counter: incremented at callback entry, decremented at exit.
    // activate/deactivate set active=false then spin until this reaches zero.
    std::atomic<int> callbackInFlight{0};
    std::atomic<bool> motorPlaying{false};
    std::atomic<bool> platterTouched{false};
    std::atomic<double> manualSemanticRate{0.0};
    std::atomic<std::int64_t> manualRateUntilOutputSample{0};
    std::atomic<float> targetGain{1.0F};
    std::atomic<std::int64_t> outputSampleCounter{0};
    std::atomic<std::int64_t> pendingSeekSourceSample{0};
    std::atomic<std::uint64_t> seekGeneration{0};
    std::atomic<bool> sourceEndReached{false};
    std::atomic<const PatternReplaySnapshot*> replaySnapshot{nullptr};
    std::atomic<double> replayNormalized{0.0};

    std::uint64_t appliedSeekGeneration = 0;
    std::int64_t replayOutputSamples = 0;
    std::atomic<double> publishedSourcePosition{0.0};
    std::atomic<double> publishedSemanticRate{0.0};
};

} // namespace silverdaw::scratch
