#include "DeviceCallbackGuard.h"

#include "Log.h"

namespace silverdaw
{

// These lifecycle callbacks arrive on the device thread, never inside the
// real-time block callback, so logging here is safe.
void DeviceCallbackGuard::audioDeviceAboutToStart(juce::AudioIODevice* device)
{
    running.store(true, std::memory_order_relaxed);
    inner.audioDeviceAboutToStart(device);
    if (device != nullptr)
    {
        silverdaw::log::info("audio", "device callback started: '" + device->getName() + "'");
    }
}

void DeviceCallbackGuard::audioDeviceStopped()
{
    running.store(false, std::memory_order_relaxed);
    inner.audioDeviceStopped();
    silverdaw::log::info("audio", "device callback stopped");
}

void DeviceCallbackGuard::audioDeviceError(const juce::String& errorMessage)
{
    running.store(false, std::memory_order_relaxed);
    inner.audioDeviceError(errorMessage);
    silverdaw::log::error("audio", "device error: " + errorMessage);
}

} // namespace silverdaw
