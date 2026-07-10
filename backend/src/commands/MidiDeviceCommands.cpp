#include "MidiDeviceCommands.h"

#include "BridgeServer.h"
#include "Log.h"
#include "midi/MidiControllerMapping.h"

#include <juce_audio_devices/juce_audio_devices.h>

#include <array>
#include <atomic>
#include <memory>
#include <optional>
#include <vector>

namespace silverdaw
{
namespace
{
constexpr int relativeControlCount = 5;

struct QueuedMidiMessage
{
    juce::int64 timestampMs = 0;
    int statusByte = 0;
    int data1 = -1;
    int data2 = -1;
};

std::unique_ptr<juce::MidiOutput> openMatchingMidiOutput(const juce::String& inputName)
{
    const auto outputs = juce::MidiOutput::getAvailableDevices();
    for (const auto& output : outputs)
    {
        if (output.name.equalsIgnoreCase(inputName))
            return juce::MidiOutput::openDevice(output.identifier);
    }

    std::optional<juce::MidiDeviceInfo> candidate;
    for (const auto& output : outputs)
    {
        if (output.name.containsIgnoreCase(inputName) || inputName.containsIgnoreCase(output.name))
        {
            if (candidate.has_value()) return nullptr;
            candidate = output;
        }
    }
    return candidate.has_value() ? juce::MidiOutput::openDevice(candidate->identifier) : nullptr;
}

template <std::size_t Size>
void sendControllerMessages(
    juce::MidiOutput* output,
    const std::array<MidiControllerOutputMessage, Size>& messages)
{
    if (output == nullptr) return;
    for (const auto& message : messages)
    {
        if (message.statusByte == 0) continue;
        output->sendMessageNow(
            juce::MidiMessage(message.statusByte, message.data1, message.data2));
    }
}

class ActiveMidiInput final : public juce::MidiInputCallback
{
public:
    ActiveMidiInput(juce::String deviceName, juce::String deviceIdentifier)
        : name(std::move(deviceName)),
          identifier(std::move(deviceIdentifier)),
          hasControllerMapping(supportsMidiControllerMapping(name)),
          controllerMapper(name)
    {
    }

    ~ActiveMidiInput() override
    {
        sendControllerMessages(output.get(), controllerMapper.selectedTrackMeterMessages(0, 0));
        sendControllerMessages(output.get(), controllerMapper.transportPlayMessages(false));
        sendControllerMessages(output.get(), controllerMapper.cueLightMessages(false));
        sendControllerMessages(
            output.get(), controllerMapper.deckSelectionLightMessages(false, false));
        sendControllerMessages(output.get(), controllerMapper.hotCueLightMessages(0));
    }

    void handleIncomingMidiMessage(juce::MidiInput*, const juce::MidiMessage& message) override
    {
        const auto* raw = message.getRawData();
        const auto size = message.getRawDataSize();
        const auto timestamp = juce::Time::currentTimeMillis();
        lastActivityMs.store(timestamp, std::memory_order_relaxed);

        int start1 = 0;
        int size1 = 0;
        int start2 = 0;
        int size2 = 0;
        fifo.prepareToWrite(1, start1, size1, start2, size2);
        if (size1 == 0)
        {
            droppedMessageCount.fetch_add(1, std::memory_order_relaxed);
            return;
        }

        queue[static_cast<size_t>(start1)] = {
            timestamp,
            size > 0 ? static_cast<unsigned char>(raw[0]) : 0,
            size > 1 ? static_cast<unsigned char>(raw[1]) : -1,
            size > 2 ? static_cast<unsigned char>(raw[2]) : -1};
        fifo.finishedWrite(1);
    }

    bool pop(QueuedMidiMessage& message)
    {
        int start1 = 0;
        int size1 = 0;
        int start2 = 0;
        int size2 = 0;
        fifo.prepareToRead(1, start1, size1, start2, size2);
        if (size1 == 0) return false;
        message = queue[static_cast<size_t>(start1)];
        fifo.finishedRead(1);
        return true;
    }

    void sendDeckSelectionLights()
    {
        sendControllerMessages(
            output.get(), controllerMapper.deckSelectionLightMessages(
                              deckActivation.isEnabled(1), deckActivation.isEnabled(2)));
    }

    static constexpr int queueCapacity = 512;
    juce::String name;
    juce::String identifier;
    bool hasControllerMapping = false;
    MidiControllerMapper controllerMapper;
    MidiDeckActivationState deckActivation;
    bool cuePressed[2]{false, false};
    std::atomic<juce::int64> lastActivityMs{0};
    std::atomic<int> droppedMessageCount{0};
    std::array<QueuedMidiMessage, queueCapacity> queue{};
    juce::AbstractFifo fifo{queueCapacity};
    juce::int64 lastMonitorBroadcastMs = 0;
    std::unique_ptr<juce::MidiInput> input;
    std::unique_ptr<juce::MidiOutput> output;
    int lastMeterValue = -1;
    int lastPlayingValue = -1;
    int lastCueValue = -1;
    int lastHotCueCount = -1;
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
            inputObj->setProperty("controllerProfile",
                                  supportsMidiControllerMapping(device.name)
                                      ? juce::var("MIDI deck")
                                      : juce::var());

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
            if (!supportsMidiControllerMapping(device.name))
            {
                silverdaw::log::warn("midi", "ignoring unsupported MIDI input enable request: " +
                                              device.name);
                continue;
            }

            auto active = std::make_unique<ActiveMidiInput>(device.name, device.identifier);
            active->input = juce::MidiInput::openDevice(device.identifier, active.get());
            if (active->input != nullptr)
            {
                if (supportsMidiControllerOutput(active->name))
                    active->output = openMatchingMidiOutput(active->name);
                active->sendDeckSelectionLights();
                active->input->start();
                activeInputs.push_back(std::move(active));
            }
            else
            {
                silverdaw::log::warn("midi", "could not open MIDI input " + device.name);
            }
        }

        if (!activeInputs.empty()) startTimerHz(60);
        else stopTimer();
    }

    void setBridge(BridgeServer& targetBridge)
    {
        bridge = &targetBridge;
    }

    void setDeckSelection(const juce::String& identifier, bool deck1Enabled, bool deck2Enabled)
    {
        for (const auto& active : activeInputs)
        {
            if (active->identifier != identifier) continue;
            active->deckActivation.setEnabled(1, deck1Enabled);
            active->deckActivation.setEnabled(2, deck2Enabled);
            active->cuePressed[0] = false;
            active->cuePressed[1] = false;
            active->sendDeckSelectionLights();
            broadcastDeckSelection(*active);
            return;
        }
        silverdaw::log::warn("midi", "deck selection target is not an enabled input: " +
                                          identifier);
    }

    void sendSelectedTrackMeter(float peakL, float peakR, bool playing)
    {
        for (const auto& active : activeInputs)
        {
            const auto messages = active->controllerMapper.selectedTrackMeterMessages(
                playing ? peakL : 0.0F, playing ? peakR : 0.0F);
            const auto value = messages[0].data2;
            if (active->output == nullptr || active->lastMeterValue == value) continue;
            active->lastMeterValue = value;
            sendControllerMessages(active->output.get(), messages);
        }
    }

    void sendTransportPlaying(bool playing)
    {
        const auto value = playing ? 1 : 0;
        for (const auto& active : activeInputs)
        {
            if (active->output == nullptr || active->lastPlayingValue == value) continue;
            active->lastPlayingValue = value;
            sendControllerMessages(
                active->output.get(), active->controllerMapper.transportPlayMessages(playing));
        }
    }

    void sendMarkerLights(bool cueActive, int markerCount)
    {
        const auto cueValue = cueActive ? 1 : 0;
        const auto clampedMarkerCount = juce::jlimit(0, 8, markerCount);
        for (const auto& active : activeInputs)
        {
            if (active->output == nullptr) continue;
            if (active->lastCueValue != cueValue)
            {
                active->lastCueValue = cueValue;
                sendControllerMessages(
                    active->output.get(), active->controllerMapper.cueLightMessages(cueActive));
            }
            if (active->lastHotCueCount != clampedMarkerCount)
            {
                active->lastHotCueCount = clampedMarkerCount;
                sendControllerMessages(
                    active->output.get(),
                    active->controllerMapper.hotCueLightMessages(clampedMarkerCount));
            }
        }
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
            std::array<std::array<double, relativeControlCount>, 2> relativeDeltas{};
            std::array<std::array<juce::int64, relativeControlCount>, 2> relativeTimestamps{};
            const auto dropped = active->droppedMessageCount.exchange(0, std::memory_order_relaxed);
            if (dropped > 0)
            {
                silverdaw::log::warn("midi", "dropped " + juce::String(dropped) +
                                                  " queued message(s) from " + active->name);
            }

            QueuedMidiMessage raw;
            QueuedMidiMessage latest;
            bool received = false;
            while (active->pop(raw))
            {
                latest = raw;
                received = true;
                if (active->hasControllerMapping)
                {
                    const auto mapped =
                        active->controllerMapper.mapMessage(raw.statusByte, raw.data1, raw.data2);
                    if (mapped.has_value())
                    {
                        if (mapped->action == MidiControllerAction::deckToggle)
                        {
                            if (mapped->deck < 1 || mapped->deck > 2)
                            {
                                silverdaw::log::warn(
                                    "midi", active->name +
                                                " produced an invalid deck-toggle index");
                                continue;
                            }
                            const auto deckIndex = static_cast<size_t>(mapped->deck - 1);
                            const auto pressed = mapped->value > 0.5;
                            if (!pressed)
                            {
                                active->cuePressed[deckIndex] = false;
                            }
                            else if (!active->cuePressed[deckIndex])
                            {
                                active->cuePressed[deckIndex] = true;
                                active->deckActivation.toggle(mapped->deck);
                                active->sendDeckSelectionLights();
                                broadcastDeckSelection(*active);
                                silverdaw::log::info(
                                    "midi",
                                    active->name + " deck " + juce::String(mapped->deck) +
                                        (active->deckActivation.isEnabled(mapped->deck)
                                             ? " enabled"
                                             : " disabled"));
                            }
                            continue;
                        }
                        if (!active->deckActivation.allows(*mapped)) continue;

                        const auto relativeIndex = relativeControlIndex(mapped->action);
                        if (mapped->kind == MidiControllerValueKind::relative &&
                            relativeIndex.has_value() && mapped->deck >= 1 && mapped->deck <= 2)
                        {
                            const auto deckIndex = static_cast<size_t>(mapped->deck - 1);
                            const auto controlIndex = static_cast<size_t>(*relativeIndex);
                            relativeDeltas[deckIndex][controlIndex] += mapped->value;
                            relativeTimestamps[deckIndex][controlIndex] = raw.timestampMs;
                        }
                        else
                        {
                            broadcastMappedControl(*active, raw.timestampMs, *mapped);
                        }
                    }
                }
            }
            broadcastRelativeControls(*active, relativeDeltas, relativeTimestamps);
            if (!received) continue;

            activityChanged = true;
            if (latest.timestampMs - active->lastMonitorBroadcastMs >= 250)
            {
                active->lastMonitorBroadcastMs = latest.timestampMs;
                broadcastMonitorMessage(*active, latest);
            }
        }

        const auto now = juce::Time::currentTimeMillis();
        if (activityChanged && bridge != nullptr && now - lastDeviceListBroadcastMs >= 250)
        {
            lastDeviceListBroadcastMs = now;
            bridge->broadcast("MIDI_DEVICES_LIST", buildEnvelope());
        }
    }

    void broadcastMonitorMessage(const ActiveMidiInput& active, const QueuedMidiMessage& raw) const
    {
        if (bridge == nullptr) return;
        auto* message = new juce::DynamicObject();
        message->setProperty("deviceIdentifier", active.identifier);
        message->setProperty("timestampMs", static_cast<double>(raw.timestampMs));
        message->setProperty("statusByte", raw.statusByte);
        message->setProperty("data1", raw.data1 >= 0 ? juce::var(raw.data1) : juce::var());
        message->setProperty("data2", raw.data2 >= 0 ? juce::var(raw.data2) : juce::var());
        bridge->broadcast("MIDI_MESSAGE", juce::var(message));
    }

    void broadcastDeckSelection(const ActiveMidiInput& active) const
    {
        if (bridge == nullptr) return;
        auto* payload = new juce::DynamicObject();
        payload->setProperty("deviceIdentifier", active.identifier);
        payload->setProperty("deck1Enabled", active.deckActivation.isEnabled(1));
        payload->setProperty("deck2Enabled", active.deckActivation.isEnabled(2));
        bridge->broadcast("MIDI_DECK_SELECTION", juce::var(payload));
    }

    static std::optional<int> relativeControlIndex(MidiControllerAction action)
    {
        // Browse/zoom remain per-event so one encoder message always means one UI step.
        switch (action)
        {
            case MidiControllerAction::jogScratch: return 0;
            case MidiControllerAction::jogPitchBend: return 1;
            case MidiControllerAction::jogSearch: return 2;
            case MidiControllerAction::wheelPitchBend: return 3;
            case MidiControllerAction::wheelSearch: return 4;
            default: return std::nullopt;
        }
    }

    static MidiControllerAction relativeControlAt(int index)
    {
        constexpr std::array<MidiControllerAction, relativeControlCount> controls{
            MidiControllerAction::jogScratch, MidiControllerAction::jogPitchBend,
            MidiControllerAction::jogSearch, MidiControllerAction::wheelPitchBend,
            MidiControllerAction::wheelSearch};
        return controls[static_cast<size_t>(index)];
    }

    void broadcastRelativeControls(
        const ActiveMidiInput& active,
        const std::array<std::array<double, relativeControlCount>, 2>& deltas,
        const std::array<std::array<juce::int64, relativeControlCount>, 2>& timestamps) const
    {
        for (int deckIndex = 0; deckIndex < 2; ++deckIndex)
        {
            for (int controlIndex = 0; controlIndex < relativeControlCount; ++controlIndex)
            {
                const auto delta = deltas[static_cast<size_t>(deckIndex)]
                                         [static_cast<size_t>(controlIndex)];
                if (delta == 0.0 || !active.deckActivation.isEnabled(deckIndex + 1)) continue;
                const MidiControllerEvent event{
                    relativeControlAt(controlIndex), MidiControllerValueKind::relative,
                    deckIndex + 1, delta};
                broadcastMappedControl(
                    active,
                    timestamps[static_cast<size_t>(deckIndex)][static_cast<size_t>(controlIndex)],
                    event);
            }
        }
    }

    void broadcastMappedControl(const ActiveMidiInput& active, juce::int64 timestampMs,
                                const MidiControllerEvent& event) const
    {
        if (bridge == nullptr) return;
        auto* message = new juce::DynamicObject();
        message->setProperty("deviceIdentifier", active.identifier);
        message->setProperty("timestampMs", static_cast<double>(timestampMs));
        message->setProperty("kind", midiControllerValueKindName(event.kind));
        message->setProperty("control", midiControllerActionName(event.action));
        if (event.deck > 0) message->setProperty("deck", event.deck);
        else message->setProperty("deck", juce::var());
        if (event.pad > 0) message->setProperty("pad", event.pad);
        if (event.kind == MidiControllerValueKind::button)
            message->setProperty("pressed", event.value > 0.5);
        else
            message->setProperty("value", event.value);
        bridge->broadcast("MIDI_CONTROL", juce::var(message));
    }

    BridgeServer* bridge = nullptr;
    std::vector<std::unique_ptr<ActiveMidiInput>> activeInputs;
    juce::int64 lastDeviceListBroadcastMs = 0;
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

void handleMidiDeckSelectionSet(const juce::var& payload, silverdaw::BridgeServer& bridge)
{
    const auto identifier = payload.getProperty("deviceIdentifier", juce::var());
    const auto deck1Enabled = payload.getProperty("deck1Enabled", juce::var());
    const auto deck2Enabled = payload.getProperty("deck2Enabled", juce::var());
    if (!identifier.isString() || identifier.toString().isEmpty() ||
        !deck1Enabled.isBool() || !deck2Enabled.isBool())
    {
        silverdaw::log::warn("midi", "MIDI_DECK_SELECTION_SET has invalid payload");
        return;
    }
    midiInputMonitor().setBridge(bridge);
    midiInputMonitor().setDeckSelection(
        identifier.toString(), static_cast<bool>(deck1Enabled), static_cast<bool>(deck2Enabled));
}

void sendMidiSelectedTrackMeter(float peakL, float peakR, bool playing)
{
    midiInputMonitor().sendSelectedTrackMeter(peakL, peakR, playing);
}

void sendMidiTransportPlaying(bool playing)
{
    midiInputMonitor().sendTransportPlaying(playing);
}

void sendMidiMarkerLights(bool cueActive, int markerCount)
{
    midiInputMonitor().sendMarkerLights(cueActive, markerCount);
}

} // namespace silverdaw
