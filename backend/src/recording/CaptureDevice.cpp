#include "CaptureDevice.h"

#include "Log.h"

namespace silverdaw::recording
{
namespace
{
juce::AudioIODeviceType* findType(juce::AudioDeviceManager& manager, const juce::String& typeName)
{
    for (auto* type : manager.getAvailableDeviceTypes())
    {
        if (type == nullptr) continue;
        if (typeName.isEmpty() || type->getTypeName() == typeName) return type;
    }
    return nullptr;
}
} // namespace

CaptureDevice::CaptureDevice() = default;

CaptureDevice::~CaptureDevice()
{
    close();
}

std::vector<CaptureInputListing> enumerateCaptureInputs()
{
    juce::AudioDeviceManager manager;
    std::vector<CaptureInputListing> listings;
    for (auto* type : manager.getAvailableDeviceTypes())
    {
        if (type == nullptr) continue;
        type->scanForDevices();
        listings.push_back({type->getTypeName(), type->getDeviceNames(/*wantInputNames*/ true)});
    }
    return listings;
}

CaptureOpenResult CaptureDevice::open(const juce::String& typeName, const juce::String& deviceName,
                                      juce::String& error)
{
    close();

    // Try the exact request first, then relax it: a remembered device may have
    // been unplugged since it was chosen, and no input at all is a different
    // failure from the wrong input.
    const auto createFrom = [&](juce::AudioIODeviceType* type, const juce::String& wantedName) {
        if (type == nullptr || device != nullptr) return;
        type->scanForDevices();
        for (const auto& name : type->getDeviceNames(/*wantInputNames*/ true))
        {
            if (wantedName.isNotEmpty() && name != wantedName) continue;
            if (auto* candidate = type->createDevice(/*outputDeviceName*/ {}, name))
            {
                device.reset(candidate);
                return;
            }
        }
    };

    createFrom(findType(typeFactory, typeName), deviceName);
    for (auto* type : typeFactory.getAvailableDeviceTypes())
        createFrom(type, deviceName);
    for (auto* type : typeFactory.getAvailableDeviceTypes())
        createFrom(type, {});

    if (device == nullptr)
    {
        error = "No audio input device is available";
        return CaptureOpenResult::noDevice;
    }

    juce::BigInteger inputChannels;
    inputChannels.setRange(0, juce::jmax(1, device->getInputChannelNames().size()), true);
    const juce::BigInteger noOutputs;
    const auto rate = device->getCurrentSampleRate() > 0.0 ? device->getCurrentSampleRate() : 48000.0;
    error = device->open(inputChannels, noOutputs, rate, device->getDefaultBufferSize());
    if (error.isNotEmpty())
    {
        device.reset();
        return CaptureOpenResult::openFailed;
    }

    log::info("recording", "capture device open type=" + getTypeName() + " device=" + getDeviceName()
                               + " rate=" + juce::String(getSampleRate(), 1)
                               + " channels=" + juce::String(getInputChannelCount()));
    return CaptureOpenResult::ok;
}

void CaptureDevice::close()
{
    if (device == nullptr) return;
    stop();
    device->close();
    device.reset();
}

void CaptureDevice::start(juce::AudioIODeviceCallback& callback)
{
    if (device == nullptr || started) return;
    device->start(&callback);
    started = true;
}

void CaptureDevice::stop()
{
    if (device == nullptr || ! started) return;
    device->stop();
    started = false;
}

juce::String CaptureDevice::getTypeName() const
{
    return device != nullptr ? device->getTypeName() : juce::String();
}

juce::String CaptureDevice::getDeviceName() const
{
    return device != nullptr ? device->getName() : juce::String();
}

juce::StringArray CaptureDevice::getInputChannelNames() const
{
    return device != nullptr ? device->getInputChannelNames() : juce::StringArray();
}

int CaptureDevice::getInputChannelCount() const
{
    return device != nullptr ? device->getActiveInputChannels().countNumberOfSetBits() : 0;
}

double CaptureDevice::getSampleRate() const
{
    return device != nullptr ? device->getCurrentSampleRate() : 0.0;
}

int CaptureDevice::getBufferSize() const
{
    return device != nullptr ? device->getCurrentBufferSizeSamples() : 0;
}

double CaptureDevice::getInputLatencyMs() const
{
    if (device == nullptr) return 0.0;
    const auto rate = device->getCurrentSampleRate();
    if (rate <= 0.0) return 0.0;
    return 1000.0 * static_cast<double>(device->getInputLatencyInSamples()) / rate;
}

} // namespace silverdaw::recording
