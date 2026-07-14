#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <atomic>
#include <cstdint>
#include <memory>

namespace silverdaw::scratch
{

// Fixed-topology monitor source for the Scratch Editor's backing bed
// (ADR 0021, Amendment 1).  It plays a pre-rendered linear stereo buffer
// forward at nominal speed, following the scratch session's linear clock — it
// never varispeeds, reverses, or holds, and is summed at a constant monitor
// gain independent of the crossfader.  When forward playback reaches the end of
// the prepared window it stops and latches an end-reached flag the controller
// consumes to bound the session.
//
// activate/deactivate run on the message thread and quiesce any in-flight
// callback before mutating non-atomic state; the audio callback is lock-free.
class BackingMonitorSource final : public juce::AudioSource
{
  public:
    BackingMonitorSource();

    void prepareToPlay(int samplesPerBlockExpected, double outputSampleRate) override;
    void releaseResources() override;
    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override;

    // Attach a prepared backing buffer and mark the source active.  The buffer
    // is not released while a callback may be in-flight; it is replaced on the
    // next activate or on destruction.  Message-thread only.
    void activate(std::shared_ptr<const juce::AudioBuffer<float>> preparedAudio,
                  double preparedSampleRate);

    // Mark inactive and silence the output.  Message-thread only.
    void deactivate() noexcept;

    bool isActive() const noexcept { return active.load(std::memory_order_acquire); }

    void setPlaying(bool shouldPlay) noexcept;
    void setGain(float gain) noexcept;
    void seekUs(std::int64_t positionUs) noexcept;
    bool consumeEndReached() noexcept;

    std::int64_t positionUs() const noexcept;
    std::int64_t durationUs() const noexcept;
    bool isPlaying() const noexcept { return playing.load(std::memory_order_acquire); }

    // True once forward playback has reached (or been seeked to) the end of the
    // prepared window. Message/control thread only.
    bool isAtForwardBoundary() const noexcept;

  private:
    void waitForCallbackQuiescence() const noexcept;
    std::int64_t sourceSampleForUs(std::int64_t us) const noexcept;

    std::shared_ptr<const juce::AudioBuffer<float>> audio;
    double sourceSampleRate = 44100.0;
    double outputSampleRate = 44100.0;
    double sourceSamplesPerOutputSample = 1.0;

    // Callback-only fractional read cursor in source samples.
    double playPosition = 0.0;

    std::atomic<bool> active{false};
    std::atomic<int> callbackInFlight{0};
    std::atomic<bool> playing{false};
    std::atomic<float> gain{1.0F};
    std::atomic<bool> endReached{false};
    std::atomic<std::int64_t> pendingSeekSourceSample{0};
    std::atomic<std::uint64_t> seekGeneration{0};
    std::atomic<double> publishedPosition{0.0};

    std::uint64_t appliedSeekGeneration = 0;
};

} // namespace silverdaw::scratch
