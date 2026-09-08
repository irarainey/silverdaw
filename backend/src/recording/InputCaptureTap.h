#pragma once

#include "InputMonitorSource.h"
#include "engine/ClockRateEstimator.h"

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>

#include <atomic>

namespace silverdaw::recording
{

/**
 * The capture-side real-time callback (ADR 0006, ADR 0030). This runs on a
 * second real-time thread owned by a device the engine does not own, so it must
 * not touch engine state: it only publishes atomics and hands blocks to a
 * juce::AudioFormatWriter::ThreadedWriter, which does its file I/O on its own
 * background thread.
 *
 * No allocation, locking, logging or file I/O happens here.
 */
class InputCaptureTap final : public juce::AudioIODeviceCallback
{
  public:
    /** Selected source: one channel, or one adjacent pair. Published as a packed
     *  value so the audio thread reads both halves without tearing. */
    void setChannelSelection(int firstChannel, int channelCount) noexcept;

    /** Installs the writer to receive captured blocks, or nullptr to stop
     *  writing. The caller must not destroy a writer until waitForQuiescence()
     *  has confirmed the audio thread cannot still be inside write(). */
    void setWriter(juce::AudioFormatWriter::ThreadedWriter* writer) noexcept;

    /** Where monitored audio goes, or nullptr for none. The sink decides whether
     *  it is actually audible; the tap only ever hands it blocks. Must outlive
     *  the capture device — the engine's monitor source does. */
    void setMonitorSink(InputMonitorSource* sink) noexcept
    {
        monitorSink.store(sink, std::memory_order_release);
    }

    /** Hard length cap in samples; zero means no cap. */
    void setMaxSamples(juce::int64 samples) noexcept { maxSamples.store(samples); }

    /** Linear gain applied to the captured signal before it is written and
     *  metered, so the meter shows what lands in the file. */
    void setGain(float linearGain) noexcept
    {
        gain.store(juce::jlimit(0.0F, 16.0F, linearGain), std::memory_order_relaxed);
    }

    /** Blocks the *calling* thread (never the audio thread) until two capture
     *  callbacks have completed, so a detached writer can be destroyed. */
    void waitForQuiescence(int timeoutMs = 1000) noexcept;

    void resetCaptureStats() noexcept;

    void consumePeaks(float& outL, float& outR) noexcept;

    juce::int64 getCapturedSamples() const noexcept { return capturedSamples.load(); }
    juce::int64 getDroppedSamples() const noexcept { return droppedSamples.load(); }
    bool hasHitLengthCap() const noexcept { return hitLengthCap.load(); }
    bool hasSeenAnySignal() const noexcept { return sawSignal.load(); }
    bool wasDeviceStopped() const noexcept { return deviceStopped.load(); }
    juce::String getDeviceError() const { return deviceError; }

    /** High-resolution tick stamp of the first captured block. The head trim is measured
     *  against it, so it marks where the take's audio begins in wall-clock terms. */
    juce::int64 getFirstBlockTicks() const noexcept { return firstBlockTicks.load(); }

    /** High-resolution tick stamp of the most recent capture callback, whether or not it
     *  carried usable audio. Zero until the device has delivered one.
     *
     *  This is the only reliable evidence that an input has gone away. A USB device
     *  unplugged mid-take was measured to stop calling back **without** JUCE ever invoking
     *  `audioDeviceStopped` or `audioDeviceError`, so `wasDeviceStopped` stays false and
     *  nothing else reports the loss (ADR 0030, Amendment 22). */
    juce::int64 getLastBlockTicks() const noexcept { return lastBlockTicks.load(); }

    /** The input device's measured frame rate, fitted over every written block. Reset with
     *  the capture stats, so it describes this take only. */
    const ClockRateEstimator& inputRateEstimator() const noexcept { return inputRate; }

    void audioDeviceIOCallbackWithContext(const float* const* inputChannelData, int numInputChannels,
                                          float* const* outputChannelData, int numOutputChannels,
                                          int numSamples,
                                          const juce::AudioIODeviceCallbackContext& context) override;
    void audioDeviceAboutToStart(juce::AudioIODevice* device) override;
    void audioDeviceStopped() override;
    void audioDeviceError(const juce::String& message) override;

  private:
    static void atomicMaxFloat(std::atomic<float>& target, float value) noexcept;

    std::atomic<juce::AudioFormatWriter::ThreadedWriter*> activeWriter{nullptr};
    std::atomic<InputMonitorSource*> monitorSink{nullptr};
    // Packed as (firstChannel << 8) | channelCount so one atomic read gives a
    // consistent pair.
    std::atomic<int> channelSelection{1};
    std::atomic<juce::int64> maxSamples{0};
    std::atomic<float> gain{1.0F};
    // Scratch space for the gain-applied copy, sized when the device starts so the
    // capture callback never allocates. Unity gain writes the device's own buffers
    // and never touches this.
    juce::AudioBuffer<float> gainBuffer;
    const float* gainChannels[2]{nullptr, nullptr};

    std::atomic<juce::int64> capturedSamples{0};
    std::atomic<juce::int64> droppedSamples{0};
    std::atomic<juce::int64> firstBlockTicks{0};
    std::atomic<juce::int64> lastBlockTicks{0};
    ClockRateEstimator inputRate;
    std::atomic<juce::int64> callbackTicks{0};
    std::atomic<bool> hitLengthCap{false};
    std::atomic<bool> sawSignal{false};
    std::atomic<bool> deviceStopped{false};
    std::atomic<float> peakL{0.0F};
    std::atomic<float> peakR{0.0F};
    juce::String deviceError;
};

} // namespace silverdaw::recording
