#include "MidiDeviceCommands.h"

#include "BridgeServer.h"
#include "Log.h"

#include <juce_audio_devices/juce_audio_devices.h>

#include <atomic>
#include <memory>
#include <vector>

namespace silverdaw
{
namespace
{
class ActiveMidiInput final : public juce::MidiInputCallback
{
public:
    explicit ActiveMidiInput(juce::String deviceIdentifier)
        : identifier(std::move(deviceIdentifier))
    {
    }

    void handleIncomingMidiMessage(juce::MidiInput*, const juce::MidiMessage& message) override
    {
        const auto* raw = message.getRawData();
        const auto size = message.getRawDataSize();
        lastActivityMs.store(juce::Time::currentTimeMillis(), std::memory_order_relaxed);
        statusByte.store(size > 0 ? static_cast<unsigned char>(raw[0]) : 0, std::memory_order_relaxed);
        data1.store(size > 1 ? static_cast<unsigned char>(raw[1]) : -1, std::memory_order_relaxed);
        data2.store(size > 2 ? static_cast<unsigned char>(raw[2]) : -1, std::memory_order_relaxed);
    }

    juce::String identifier;
    std::atomic<juce::int64> lastActivityMs{0};
    std::atomic<int> statusByte{0};
    std::atomic<int> data1{-1};
    std::atomic<int> data2{-1};
    juce::int64 lastReportedActivityMs = 0;
    std::unique_ptr<juce::MidiInput> input;
};

class MidiInputMonitor final : private juce::Timer
{
public:
    juce::var buildEnvelope() const
    {
        auto* obj = new juce::DynamicObject();
        juce::Array<juce::var> inputs;
        for (const auto& device : juce::MidiInput::getAvailableDevices())
        {
            auto* inputObj = new juce::DynamicObject();
            inputObj->setProperty("name", device.name);
            inputObj->setProperty("identifier", device.identifier);
            inputObj->setProperty("connected", true);

            const auto* active = findActive(device.identifier);
            inputObj->setProperty("enabled", active != nullptr && active->input != nullptr);
            juce::var lastActivity;
            if (active != nullptr)
            {
                const auto activity = active->lastActivityMs.load(std::memory_order_relaxed);
                if (activity > 0)
                    lastActivity = static_cast<double>(activity);
            }
            inputObj->setProperty("lastActivityMs", lastActivity);
            inputs.add(juce::var(inputObj));
        }
        obj->setProperty("inputs", juce::var(inputs));
        return juce::var(obj);
    }

    void setEnabledInputs(const juce::StringArray& identifiers, BridgeServer& targetBridge)
    {
        bridge = &targetBridge;
        activeInputs.clear();

        for (const auto& device : juce::MidiInput::getAvailableDevices())
        {
            if (!identifiers.contains(device.identifier)) continue;

            auto active = std::make_unique<ActiveMidiInput>(device.identifier);
            active->input = juce::MidiInput::openDevice(device.identifier, active.get());
            if (active->input != nullptr)
            {
                active->input->start();
                activeInputs.push_back(std::move(active));
            }
            else
            {
                silverdaw::log::warn("midi", "could not open MIDI input " + device.name);
            }
        }

        if (!activeInputs.empty()) startTimerHz(4);
        else stopTimer();
    }

    void setBridge(BridgeServer& targetBridge)
    {
        bridge = &targetBridge;
    }

private:
    const ActiveMidiInput* findActive(const juce::String& identifier) const
    {
        for (const auto& active : activeInputs)
            if (active->identifier == identifier) return active.get();
        return nullptr;
    }

    void timerCallback() override
    {
        bool activityChanged = false;
        for (const auto& active : activeInputs)
        {
            const auto activity = active->lastActivityMs.load(std::memory_order_relaxed);
            if (activity != active->lastReportedActivityMs)
            {
                active->lastReportedActivityMs = activity;
                auto* message = new juce::DynamicObject();
                message->setProperty("deviceIdentifier", active->identifier);
                message->setProperty("timestampMs", static_cast<double>(activity));
                message->setProperty("statusByte", active->statusByte.load(std::memory_order_relaxed));
                const auto data1 = active->data1.load(std::memory_order_relaxed);
                const auto data2 = active->data2.load(std::memory_order_relaxed);
                if (data1 >= 0) message->setProperty("data1", data1);
                else message->setProperty("data1", juce::var());
                if (data2 >= 0) message->setProperty("data2", data2);
                else message->setProperty("data2", juce::var());
                if (bridge != nullptr) bridge->broadcast("MIDI_MESSAGE", juce::var(message));
                activityChanged = true;
            }
        }
        if (activityChanged && bridge != nullptr)
            bridge->broadcast("MIDI_DEVICES_LIST", buildEnvelope());
    }

    BridgeServer* bridge = nullptr;
    std::vector<std::unique_ptr<ActiveMidiInput>> activeInputs;
};

MidiInputMonitor& midiInputMonitor()
{
    static MidiInputMonitor instance;
    return instance;
}
} // namespace

juce::var buildMidiDevicesListEnvelope()
{
    return midiInputMonitor().buildEnvelope();
}

void handleMidiDevicesRequest(silverdaw::BridgeServer& bridge)
{
    midiInputMonitor().setBridge(bridge);
    const auto envelope = buildMidiDevicesListEnvelope();
    silverdaw::log::info("midi",
                         "enumerated " +
                             juce::String(envelope["inputs"].getArray()->size()) +
                             " MIDI input device(s)");
    bridge.broadcast("MIDI_DEVICES_LIST", envelope);
}

void handleMidiInputsSet(const juce::var& payload, silverdaw::BridgeServer& bridge)
{
    juce::StringArray identifiers;
    const auto values = payload.getProperty("identifiers", juce::var());
    if (!values.isArray())
    {
        silverdaw::log::warn("midi", "MIDI_INPUTS_SET missing identifiers array");
        return;
    }
    for (const auto& value : *values.getArray())
    {
        if (value.isString() && value.toString().isNotEmpty())
            identifiers.addIfNotAlreadyThere(value.toString());
    }

    midiInputMonitor().setEnabledInputs(identifiers, bridge);
    bridge.broadcast("MIDI_DEVICES_LIST", buildMidiDevicesListEnvelope());
}

} // namespace silverdaw
