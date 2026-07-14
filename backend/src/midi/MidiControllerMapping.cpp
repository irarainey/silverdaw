#include "MidiControllerMapping.h"

#include "MidiControllerProfiles.h"

#include <algorithm>
#include <cmath>

namespace silverdaw
{
namespace
{
std::optional<MidiControllerEvent> buttonEvent(MidiControllerAction action,
                                                int deck,
                                                bool pressed)
{
    return MidiControllerEvent{
        action, MidiControllerValueKind::button, deck, pressed ? 1.0 : 0.0};
}

int deckForChannel(const MidiInputBinding& binding, int channel) noexcept
{
    const auto match = std::find(binding.channels.begin(), binding.channels.end(), channel);
    if (match == binding.channels.end()) return -1;
    return binding.decks[static_cast<std::size_t>(match - binding.channels.begin())];
}

MidiControllerOutputMessage outputMessage(const MidiOutputBinding* binding,
                                          std::size_t channelIndex,
                                          int data1,
                                          int value) noexcept
{
    if (binding == nullptr || channelIndex >= binding->channels.size()) return {};
    const auto mappedData1 = binding->data1Values.size() == binding->channels.size()
                                 ? binding->data1Values[channelIndex]
                                 : data1;
    return {binding->messageType | binding->channels[channelIndex], mappedData1, value};
}
} // namespace

bool supportsMidiControllerMapping(const juce::String& deviceName)
{
    return findMidiControllerProfile(deviceName) != nullptr;
}

bool supportsMidiControllerOutput(const juce::String& deviceName)
{
    const auto* profile = findMidiControllerProfile(deviceName);
    return profile != nullptr && !profile->outputs.empty();
}

std::optional<juce::String> midiControllerManufacturerName(const juce::String& deviceName)
{
    const auto* profile = findMidiControllerProfile(deviceName);
    if (profile == nullptr) return std::nullopt;

    const auto separator = profile->name.indexOfChar(' ');
    return profile->name.substring(0, separator < 0 ? profile->name.length() : separator);
}

const char* midiControllerActionName(MidiControllerAction action) noexcept
{
    switch (action)
    {
        case MidiControllerAction::playPause: return "playPause";
        case MidiControllerAction::previousMarker: return "previousMarker";
        case MidiControllerAction::nextMarker: return "nextMarker";
        case MidiControllerAction::deckToggle: return "deckToggle";
        case MidiControllerAction::shift: return "shift";
        case MidiControllerAction::syncModifier: return "syncModifier";
        case MidiControllerAction::jogScratch: return "jogScratch";
        case MidiControllerAction::jogPitchBend: return "jogPitchBend";
        case MidiControllerAction::jogSearch: return "jogSearch";
        case MidiControllerAction::jogTouch: return "jogTouch";
        case MidiControllerAction::wheelPitchBend: return "wheelPitchBend";
        case MidiControllerAction::wheelSearch: return "wheelSearch";
        case MidiControllerAction::browseTracks: return "browseTracks";
        case MidiControllerAction::browsePress: return "browsePress";
        case MidiControllerAction::timelineZoom: return "timelineZoom";
        case MidiControllerAction::markerJump: return "markerJump";
        case MidiControllerAction::markerToggle: return "markerToggle";
        case MidiControllerAction::trackGain: return "trackGain";
        case MidiControllerAction::toneBass: return "toneBass";
        case MidiControllerAction::toneMid: return "toneMid";
        case MidiControllerAction::toneTreble: return "toneTreble";
        case MidiControllerAction::filter: return "filter";
        case MidiControllerAction::masterVolume: return "masterVolume";
        case MidiControllerAction::crossfader: return "crossfader";
    }
    return "";
}

const char* midiControllerValueKindName(MidiControllerValueKind kind) noexcept
{
    switch (kind)
    {
        case MidiControllerValueKind::button: return "button";
        case MidiControllerValueKind::relative: return "relative";
        case MidiControllerValueKind::absolute: return "absolute";
    }
    return "";
}

bool MidiDeckActivationState::toggle(int deck) noexcept
{
    if (deck < 1 || deck > 2) return false;
    auto& active = enabled[deck - 1];
    active = !active;
    return active;
}

void MidiDeckActivationState::selectExclusive(int deck) noexcept
{
    if (deck < 1 || deck > 2) return;
    const auto index = static_cast<std::size_t>(deck - 1);
    enabled[index] = true;
    enabled[1 - index] = false;
}

void MidiDeckActivationState::setEnabled(int deck, bool active) noexcept
{
    if (deck >= 1 && deck <= 2) enabled[deck - 1] = active;
}

bool MidiDeckActivationState::isEnabled(int deck) const noexcept
{
    return deck >= 1 && deck <= 2 && enabled[deck - 1];
}

bool MidiDeckActivationState::allows(const MidiControllerEvent& event) const noexcept
{
    if (event.action == MidiControllerAction::deckToggle) return true;
    if (event.deck == 0) return enabled[0] || enabled[1];
    return isEnabled(event.deck);
}

MidiControllerMapper::MidiControllerMapper(const juce::String& deviceName)
    : profile(findMidiControllerProfile(deviceName))
{
}

std::optional<MidiControllerEvent> MidiControllerMapper::mapMessage(int statusByte,
                                                                    int data1,
                                                                    int data2)
{
    if (profile == nullptr || data1 < 0 || data1 > 127 || data2 < 0 || data2 > 127)
        return std::nullopt;

    const auto messageType = statusByte & 0xf0;
    const auto channel = statusByte & 0x0f;
    const auto shiftActive = [this](int deck)
    {
        if (deck == 0) return shiftPressed[0] || shiftPressed[1];
        return deck >= 1 && deck <= 2 && shiftPressed[deck - 1];
    };
    for (const auto& binding : profile->inputs)
    {
        const auto noteMessage = binding.messageType == 0x90 &&
                                 (messageType == 0x80 || messageType == 0x90);
        if (!noteMessage && messageType != binding.messageType) continue;
        const auto deck = deckForChannel(binding, channel);
        if (deck < 0) continue;

        const auto isDataRange =
            data1 >= binding.data1 && data1 < binding.data1 + binding.data1Count;
        const auto isAbsoluteLsb =
            (binding.encoding == MidiInputEncoding::absolute14 ||
             binding.encoding == MidiInputEncoding::absolute14Relative) &&
            data1 == binding.lsbData1;
        if (!isDataRange && !isAbsoluteLsb) continue;

        if (binding.encoding == MidiInputEncoding::button)
        {
            const auto pressed = messageType != 0x80 && data2 > 0;
            if (binding.action == MidiControllerAction::shift && deck >= 1 && deck <= 2)
                shiftPressed[deck - 1] = pressed;
            if (binding.action == MidiControllerAction::jogTouch && deck >= 1 && deck <= 2)
                jogTouched[deck - 1] = pressed;
            const auto shifted = shiftActive(deck) && binding.shiftedAction.has_value();
            return buttonEvent(shifted ? *binding.shiftedAction : binding.action, deck, pressed);
        }

        if (binding.encoding == MidiInputEncoding::padRange)
        {
            const auto pressed = messageType == 0x90 && data2 > 0;
            if (!pressed) return std::nullopt;
            const auto shifted = shiftActive(deck) && binding.shiftedAction.has_value();
            return MidiControllerEvent{
                shifted ? *binding.shiftedAction : binding.action,
                MidiControllerValueKind::button, deck, 1.0,
                data1 - binding.data1 + binding.padOffset};
        }

        if (binding.encoding == MidiInputEncoding::relative ||
            binding.encoding == MidiInputEncoding::relativeTwosComplement)
        {
            const auto rawDelta =
                binding.encoding == MidiInputEncoding::relativeTwosComplement
                    ? (data2 < 64 ? data2 : data2 - 128)
                    : data2 - binding.center;
            const auto delta = rawDelta * binding.direction;
            if (delta == 0) return std::nullopt;
            const auto shifted = shiftActive(deck) && binding.shiftedAction.has_value();
            const auto touched = deck >= 1 && deck <= 2 && jogTouched[deck - 1] &&
                                 binding.touchedAction.has_value();
            return MidiControllerEvent{
                shifted ? *binding.shiftedAction
                        : touched ? *binding.touchedAction : binding.action,
                MidiControllerValueKind::relative, deck, static_cast<double>(delta)};
        }

        if (binding.encoding == MidiInputEncoding::absolute7)
            return MidiControllerEvent{binding.action, MidiControllerValueKind::absolute, deck,
                                       static_cast<double>(data2) / 127.0};

        const auto channelIndex = static_cast<std::size_t>(channel);
        const auto controllerIndex = static_cast<std::size_t>(binding.data1);
        if (data1 == binding.data1)
        {
            highResolutionMsb[channelIndex][controllerIndex] = data2;
            highResolutionMsbPending[channelIndex][controllerIndex] = true;
            return std::nullopt;
        }
        if (!highResolutionMsbPending[channelIndex][controllerIndex]) return std::nullopt;
        highResolutionMsbPending[channelIndex][controllerIndex] = false;
        const auto combined =
            (highResolutionMsb[channelIndex][controllerIndex] << 7) | data2;
        if (binding.encoding == MidiInputEncoding::absolute14Relative)
        {
            const auto hadPrevious = previousAbsoluteValid[channelIndex][controllerIndex];
            const auto previous = previousAbsolute[channelIndex][controllerIndex];
            previousAbsolute[channelIndex][controllerIndex] = combined;
            previousAbsoluteValid[channelIndex][controllerIndex] = true;
            if (!hadPrevious) return std::nullopt;
            auto delta = combined - previous;
            if (delta > 8192) delta -= 16384;
            if (delta < -8192) delta += 16384;
            if (delta == 0) return std::nullopt;
            return MidiControllerEvent{binding.action, MidiControllerValueKind::relative, deck,
                                       static_cast<double>(delta)};
        }
        return MidiControllerEvent{binding.action, MidiControllerValueKind::absolute, deck,
                                   static_cast<double>(combined) / 16383.0};
    }
    return std::nullopt;
}

std::array<MidiControllerOutputMessage, 2> MidiControllerMapper::selectedTrackMeterMessages(
    float peakL, float peakR) const noexcept
{
    std::array<MidiControllerOutputMessage, 2> messages{};
    if (profile == nullptr) return messages;
    const auto* binding = findMidiOutputBinding(*profile, MidiOutputPurpose::channelMeter);
    const auto peak = juce::jlimit(0.0F, 1.0F, juce::jmax(peakL, peakR));
    const auto db = peak > 0.0F ? 20.0F * std::log10(peak) : -60.0F;
    const auto normalized = juce::jlimit(0.0F, 1.0F, (db + 60.0F) / 60.0F);
    const auto value = juce::roundToInt(normalized * 127.0F);
    for (std::size_t i = 0; i < messages.size(); ++i)
        messages[i] = outputMessage(binding, i, binding != nullptr ? binding->data1 : 0, value);
    return messages;
}

std::array<MidiControllerOutputMessage, 2> MidiControllerMapper::transportPlayMessages(
    bool playing) const noexcept
{
    std::array<MidiControllerOutputMessage, 2> messages{};
    if (profile == nullptr) return messages;
    const auto* binding = findMidiOutputBinding(*profile, MidiOutputPurpose::playLight);
    for (std::size_t i = 0; i < messages.size(); ++i)
        messages[i] = outputMessage(
            binding, i, binding != nullptr ? binding->data1 : 0,
            binding != nullptr ? (playing ? binding->onValue : binding->offValue) : 0);
    return messages;
}

std::array<MidiControllerOutputMessage, 2> MidiControllerMapper::cueLightMessages(
    bool active) const noexcept
{
    std::array<MidiControllerOutputMessage, 2> messages{};
    if (profile == nullptr) return messages;
    const auto* binding = findMidiOutputBinding(*profile, MidiOutputPurpose::cueLight);
    for (std::size_t i = 0; i < messages.size(); ++i)
        messages[i] = outputMessage(
            binding, i, binding != nullptr ? binding->data1 : 0,
            binding != nullptr ? (active ? binding->onValue : binding->offValue) : 0);
    return messages;
}

std::array<MidiControllerOutputMessage, 2> MidiControllerMapper::deckSelectionLightMessages(
    bool deck1Active, bool deck2Active) const noexcept
{
    std::array<MidiControllerOutputMessage, 2> messages{};
    if (profile == nullptr) return messages;
    const auto* binding =
        findMidiOutputBinding(*profile, MidiOutputPurpose::deckSelectionLight);
    messages[0] = outputMessage(
        binding, 0, binding != nullptr ? binding->data1 : 0,
        binding != nullptr ? (deck1Active ? binding->onValue : binding->offValue) : 0);
    messages[1] = outputMessage(
        binding, 1, binding != nullptr ? binding->data1 : 0,
        binding != nullptr ? (deck2Active ? binding->onValue : binding->offValue) : 0);
    return messages;
}

std::array<MidiControllerOutputMessage, 16> MidiControllerMapper::hotCueLightMessages(
    int markerCount) const noexcept
{
    std::array<MidiControllerOutputMessage, 16> messages{};
    if (profile == nullptr) return messages;
    const auto* binding = findMidiOutputBinding(*profile, MidiOutputPurpose::hotCueLights);
    const auto activeCount = juce::jlimit(0, 8, markerCount);
    for (std::size_t deck = 0; deck < 2; ++deck)
        for (int pad = 0; pad < 8; ++pad)
        {
            if (binding == nullptr || pad >= binding->count) continue;
            messages[deck * 8 + static_cast<std::size_t>(pad)] =
                outputMessage(binding, deck,
                              binding->data1Values.size() ==
                                      static_cast<std::size_t>(binding->count)
                                  ? binding->data1Values[static_cast<std::size_t>(pad)]
                                  : binding->data1 + pad,
                              pad < activeCount ? binding->onValue : binding->offValue);
        }
    return messages;
}

const std::vector<std::vector<juce::uint8>>& MidiControllerMapper::initMessages() const noexcept
{
    static const std::vector<std::vector<juce::uint8>> empty;
    return profile != nullptr ? profile->initMessages : empty;
}

int MidiControllerMapper::scratchTicksPerTurn() const noexcept
{
    if (profile == nullptr)
        return 512;
    return profile->scratchTicksPerTurn > 0 ? profile->scratchTicksPerTurn : 512;
}

} // namespace silverdaw
