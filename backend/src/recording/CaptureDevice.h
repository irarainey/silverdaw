#pragma once

#include <juce_audio_devices/juce_audio_devices.h>

#include <memory>
#include <vector>

namespace silverdaw::recording
{

struct CaptureInputListing
{
    juce::String typeName;
    juce::StringArray devices;
};

/** Enumeration only: no device is opened, so this cannot reintroduce the
 *  capture-open stall that AudioEngine::openDefaultOutputOnly avoids. */
std::vector<CaptureInputListing> enumerateCaptureInputs();

enum class CaptureOpenResult
{
    ok,
    noDevice,
    openFailed
};

/**
 * A standalone input-only device, deliberately outside the engine's
 * AudioDeviceManager (ADR 0030). Capture and playback are assumed to be
 * different devices, possibly on different driver types, so opening or closing
 * this never reconfigures playback.
 *
 * Message thread only, apart from the callback the device drives.
 */
class CaptureDevice
{
  public:
    CaptureDevice();
    ~CaptureDevice();

    CaptureDevice(const CaptureDevice&) = delete;
    CaptureDevice& operator=(const CaptureDevice&) = delete;

    /** Opens `deviceName`, or the first available input when it is empty.
     *  `typeName` likewise narrows the driver type when given. */
    CaptureOpenResult open(const juce::String& typeName, const juce::String& deviceName,
                           juce::String& error);
    void close();

    void start(juce::AudioIODeviceCallback& callback);
    void stop();

    bool isOpen() const noexcept { return device != nullptr; }

    juce::String getTypeName() const;
    juce::String getDeviceName() const;
    juce::StringArray getInputChannelNames() const;
    int getInputChannelCount() const;
    double getSampleRate() const;
    int getBufferSize() const;
    double getInputLatencyMs() const;

  private:
    // Borrowed purely as a device-type factory; it is never initialised, so no
    // device is ever opened through it.
    juce::AudioDeviceManager typeFactory;
    std::unique_ptr<juce::AudioIODevice> device;
    bool started = false;
};

} // namespace silverdaw::recording
