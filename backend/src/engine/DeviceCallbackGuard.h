#pragma once

#include <atomic>

#include <juce_audio_devices/juce_audio_devices.h>

namespace silverdaw
{

// Wraps the output callback so device start/stop/error transitions are observable.
// JUCE's device thread exits on a stream error, so without this an engine whose
// callback has died still reports a running transport and never recovers.
class DeviceCallbackGuard : public juce::AudioIODeviceCallback
{
  public:
    explicit DeviceCallbackGuard(juce::AudioIODeviceCallback& innerCallback) noexcept
        : inner(innerCallback)
    {
    }

    void audioDeviceAboutToStart(juce::AudioIODevice* device) override;
    void audioDeviceStopped() override;
    void audioDeviceError(const juce::String& errorMessage) override;

    // Real-time block callback: pure forwarding, no added work.
    void audioDeviceIOCallbackWithContext(const float* const* inputChannelData,
                                          int numInputChannels,
                                          float* const* outputChannelData,
                                          int numOutputChannels,
                                          int numSamples,
                                          const juce::AudioIODeviceCallbackContext& context) override
    {
        inner.audioDeviceIOCallbackWithContext(inputChannelData, numInputChannels, outputChannelData,
                                               numOutputChannels, numSamples, context);
    }

    bool isDeviceRunning() const noexcept { return running.load(std::memory_order_relaxed); }

  private:
    juce::AudioIODeviceCallback& inner;
    // Written from the device thread, read by the message-thread watchdog.
    std::atomic<bool> running{false};
};

} // namespace silverdaw
