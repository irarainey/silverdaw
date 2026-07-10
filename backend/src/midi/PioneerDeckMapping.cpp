#include "PioneerDeckMapping.h"

#include <array>
#include <cmath>

namespace silverdaw
{
namespace
{
constexpr std::array<const char*, 19> supportedModels{
    "DDJ-1000", "DDJ-800", "DDJ-FLX10", "DDJ-RB",  "DDJ-RR", "DDJ-RX", "DDJ-RZ",
    "DDJ-RZX",  "DDJ-SB",  "DDJ-SB2",   "DDJ-SB3", "DDJ-SR", "DDJ-SR2", "DDJ-SX",
    "DDJ-SX2",  "DDJ-SX3", "DDJ-SZ",    "DDJ-WEGO4", "DDJ-ERGO"};

bool containsModelName(const juce::String& deviceName, const juce::String& model)
{
    auto start = deviceName.indexOf(model);
    while (start >= 0)
    {
        const auto beforeIsBoundary =
            start == 0 || !juce::CharacterFunctions::isLetterOrDigit(deviceName[start - 1]);
        const auto after = start + model.length();
        const auto afterIsBoundary =
            after == deviceName.length() ||
            !juce::CharacterFunctions::isLetterOrDigit(deviceName[after]);
        if (beforeIsBoundary && afterIsBoundary) return true;
        start = deviceName.indexOf(start + 1, model);
    }
    return false;
}

int relativeDelta(int value) noexcept
{
    return value - 64;
}

std::optional<PioneerDeckControlEvent> buttonEvent(PioneerDeckControl control, int deck, bool pressed)
{
    return PioneerDeckControlEvent{control, PioneerDeckControlKind::button, deck, pressed ? 1.0 : 0.0};
}

std::optional<PioneerDeckControlEvent> relativeEvent(PioneerDeckControl control,
                                                      int value,
                                                      int direction = 1)
{
    const auto delta = relativeDelta(value) * direction;
    if (delta == 0) return std::nullopt;
    return PioneerDeckControlEvent{
        control, PioneerDeckControlKind::relative, 0, static_cast<double>(delta)};
}
} // namespace

bool supportsPioneerTwoDeckMapping(const juce::String& deviceName)
{
    const auto upperName = deviceName.toUpperCase();
    for (const auto* model : supportedModels)
        if (containsModelName(upperName, model)) return true;
    return false;
}

bool supportsPioneerChannelMeterOutput(const juce::String& deviceName)
{
    const auto upperName = deviceName.toUpperCase();
    return supportsPioneerTwoDeckMapping(deviceName) &&
           !containsModelName(upperName, "DDJ-SZ") &&
           !containsModelName(upperName, "DDJ-WEGO4") &&
           !containsModelName(upperName, "DDJ-ERGO");
}

const char* pioneerDeckControlName(PioneerDeckControl control) noexcept
{
    switch (control)
    {
        case PioneerDeckControl::playPause: return "playPause";
        case PioneerDeckControl::previousMarker: return "previousMarker";
        case PioneerDeckControl::nextMarker: return "nextMarker";
        case PioneerDeckControl::deckToggle: return "deckToggle";
        case PioneerDeckControl::shift: return "shift";
        case PioneerDeckControl::syncModifier: return "syncModifier";
        case PioneerDeckControl::jogScratch: return "jogScratch";
        case PioneerDeckControl::jogPitchBend: return "jogPitchBend";
        case PioneerDeckControl::jogSearch: return "jogSearch";
        case PioneerDeckControl::jogTouch: return "jogTouch";
        case PioneerDeckControl::wheelPitchBend: return "wheelPitchBend";
        case PioneerDeckControl::wheelSearch: return "wheelSearch";
        case PioneerDeckControl::browseTracks: return "browseTracks";
        case PioneerDeckControl::browsePress: return "browsePress";
        case PioneerDeckControl::timelineZoom: return "timelineZoom";
        case PioneerDeckControl::markerJump: return "markerJump";
        case PioneerDeckControl::markerToggle: return "markerToggle";
        case PioneerDeckControl::trackGain: return "trackGain";
        case PioneerDeckControl::toneBass: return "toneBass";
        case PioneerDeckControl::toneMid: return "toneMid";
        case PioneerDeckControl::toneTreble: return "toneTreble";
        case PioneerDeckControl::filter: return "filter";
        case PioneerDeckControl::masterVolume: return "masterVolume";
        case PioneerDeckControl::crossfader: return "crossfader";
    }
    return "";
}

bool PioneerDeckActivationState::toggle(int deck) noexcept
{
    if (deck < 1 || deck > 2) return false;
    auto& active = enabled[deck - 1];
    active = !active;
    return active;
}

void PioneerDeckActivationState::setEnabled(int deck, bool active) noexcept
{
    if (deck >= 1 && deck <= 2) enabled[deck - 1] = active;
}

bool PioneerDeckActivationState::isEnabled(int deck) const noexcept
{
    return deck >= 1 && deck <= 2 && enabled[deck - 1];
}

bool PioneerDeckActivationState::allows(const PioneerDeckControlEvent& event) const noexcept
{
    if (event.control == PioneerDeckControl::deckToggle) return true;
    if (event.deck == 0) return enabled[0] || enabled[1];
    return isEnabled(event.deck);
}

const char* pioneerDeckControlKindName(PioneerDeckControlKind kind) noexcept
{
    switch (kind)
    {
        case PioneerDeckControlKind::button: return "button";
        case PioneerDeckControlKind::relative: return "relative";
        case PioneerDeckControlKind::absolute: return "absolute";
    }
    return "";
}

std::array<PioneerDeckOutputMessage, 2> pioneerSelectedTrackMeterMessages(float peakL,
                                                                         float peakR) noexcept
{
    const auto peak = juce::jlimit(0.0F, 1.0F, juce::jmax(peakL, peakR));
    const auto db = peak > 0.0F ? 20.0F * std::log10(peak) : -60.0F;
    const auto normalized = juce::jlimit(0.0F, 1.0F, (db + 60.0F) / 60.0F);
    const auto value = juce::roundToInt(normalized * 127.0F);
    return {{{0xB0, 0x02, value}, {0xB1, 0x02, value}}};
}

std::array<PioneerDeckOutputMessage, 2> pioneerTransportPlayMessages(bool playing) noexcept
{
    const auto value = playing ? 0x7F : 0x00;
    return {{{0x90, 0x0B, value}, {0x91, 0x0B, value}}};
}

std::array<PioneerDeckOutputMessage, 2> pioneerCueLightMessages(bool active) noexcept
{
    const auto value = active ? 0x7F : 0x00;
    return {{{0x90, 0x0C, value}, {0x91, 0x0C, value}}};
}

std::array<PioneerDeckOutputMessage, 2> pioneerDeckSelectionLightMessages(
    bool deck1Active, bool deck2Active) noexcept
{
    return {{{0x90, 0x54, deck1Active ? 0x7F : 0x00},
             {0x91, 0x54, deck2Active ? 0x7F : 0x00}}};
}

std::array<PioneerDeckOutputMessage, 16> pioneerHotCueLightMessages(int markerCount) noexcept
{
    std::array<PioneerDeckOutputMessage, 16> messages{};
    const auto activeCount = juce::jlimit(0, 8, markerCount);
    for (int pad = 0; pad < 8; ++pad)
    {
        const auto value = pad < activeCount ? 0x7F : 0x00;
        messages[static_cast<std::size_t>(pad)] = {0x97, pad, value};
        messages[static_cast<std::size_t>(pad + 8)] = {0x98, pad, value};
    }
    return messages;
}

PioneerDeckMapper::PioneerDeckMapper(const juce::String& deviceName)
{
    const auto upperName = deviceName.toUpperCase();
    const auto isCompactLegacy =
        containsModelName(upperName, "DDJ-WEGO4") || containsModelName(upperName, "DDJ-ERGO");
    standardMixerControls = !isCompactLegacy;
    standardFilterControls = standardMixerControls && !containsModelName(upperName, "DDJ-SZ");
    standardHotCuePads = !isCompactLegacy;
    if (containsModelName(upperName, "DDJ-SX3")) syncPrimaryNote = 0x5d;
    // CC 0x08 on channel 6 is master level only on these verified models.
    masterLevelController08 = containsModelName(upperName, "DDJ-RB") ||
                              containsModelName(upperName, "DDJ-RZ") ||
                              containsModelName(upperName, "DDJ-RZX") ||
                              containsModelName(upperName, "DDJ-SZ") ||
                              containsModelName(upperName, "DDJ-SR2");
}

std::optional<PioneerDeckControlEvent> PioneerDeckMapper::mapMessage(int statusByte, int data1, int data2)
{
    if (data1 < 0 || data2 < 0) return std::nullopt;

    const auto messageType = statusByte & 0xf0;
    const auto channel = statusByte & 0x0f;

    if ((messageType == 0x80 || messageType == 0x90) && channel == 6 &&
        (data1 == 0x41 || data1 == 0x42))
    {
        const auto pressed = messageType == 0x90 && data2 > 0;
        return buttonEvent(PioneerDeckControl::browsePress, 0, pressed);
    }

    if ((messageType == 0x80 || messageType == 0x90) && channel <= 1)
    {
        const auto deck = channel + 1;
        const auto pressed = messageType == 0x90 && data2 > 0;
        if (data1 == 0x3f)
        {
            shiftPressed[channel] = pressed;
            return buttonEvent(PioneerDeckControl::shift, deck, pressed);
        }
        if (data1 == syncPrimaryNote || data1 == 0x5c)
            return buttonEvent(PioneerDeckControl::syncModifier, deck, pressed);
        if (data1 == 0x36 || data1 == 0x67)
            return buttonEvent(PioneerDeckControl::jogTouch, deck, pressed);
        if (data1 == 0x0b)
            return buttonEvent(PioneerDeckControl::playPause, deck, pressed);
        if (data1 == 0x48)
            return buttonEvent(PioneerDeckControl::nextMarker, deck, pressed);
        if (data1 == 0x0c)
            return buttonEvent(shiftPressed[channel] ? PioneerDeckControl::nextMarker
                                                     : PioneerDeckControl::previousMarker,
                               deck, pressed);
        if (data1 == 0x54)
            return buttonEvent(PioneerDeckControl::deckToggle, deck, pressed);
        return std::nullopt;
    }

    const auto isMappedPadChannel = channel == 7 || channel == 8;
    if ((messageType == 0x80 || messageType == 0x90) && isMappedPadChannel &&
        standardHotCuePads)
    {
        const auto pressed = messageType == 0x90 && data2 > 0;
        if (!pressed) return std::nullopt;
        if (data1 >= 0x00 && data1 <= 0x07)
            return PioneerDeckControlEvent{PioneerDeckControl::markerJump,
                                           PioneerDeckControlKind::button,
                                           channel == 7 ? 1 : 2, 1.0,
                                           data1 + 1};
        if (data1 >= 0x08 && data1 <= 0x0f)
            return PioneerDeckControlEvent{PioneerDeckControl::markerToggle,
                                           PioneerDeckControlKind::button,
                                           channel == 7 ? 1 : 2, 1.0,
                                           data1 - 0x07};
        if (data1 >= 0x40 && data1 <= 0x47)
            return PioneerDeckControlEvent{PioneerDeckControl::markerJump,
                                           PioneerDeckControlKind::button, 2, 1.0,
                                           data1 - 0x3f};
        if (data1 >= 0x48 && data1 <= 0x4f)
            return PioneerDeckControlEvent{PioneerDeckControl::markerToggle,
                                           PioneerDeckControlKind::button, 2, 1.0,
                                           data1 - 0x47};
        return std::nullopt;
    }

    if (messageType != 0xb0) return std::nullopt;

    if (channel == 6 && data1 == 0x40)
        return relativeEvent(PioneerDeckControl::browseTracks, data2, -1);
    // Common-family Shift+Browse uses a separate centred-relative CC.
    if (channel == 6 && data1 == 0x64)
        return relativeEvent(PioneerDeckControl::timelineZoom, data2);

    auto baseController = data1;
    if (baseController >= 0x20) baseController -= 0x20;

    PioneerDeckControl absoluteControl{};
    auto absoluteDeck = 0;
    auto isHighResolutionControl = false;
    if (channel <= 1 && standardMixerControls)
    {
        absoluteDeck = channel + 1;
        switch (baseController)
        {
            case 0x13: absoluteControl = PioneerDeckControl::trackGain; break;
            case 0x07: absoluteControl = PioneerDeckControl::toneTreble; break;
            case 0x0b: absoluteControl = PioneerDeckControl::toneMid; break;
            case 0x0f: absoluteControl = PioneerDeckControl::toneBass; break;
            default: break;
        }
        isHighResolutionControl =
            baseController == 0x13 || baseController == 0x07 || baseController == 0x0b ||
            baseController == 0x0f;
    }
    else if (channel == 6)
    {
        if (baseController == 0x1f)
        {
            absoluteControl = PioneerDeckControl::crossfader;
            isHighResolutionControl = true;
        }
        else if (baseController == 0x08 && masterLevelController08)
        {
            absoluteControl = PioneerDeckControl::masterVolume;
            isHighResolutionControl = true;
        }
        else if (standardFilterControls && (baseController == 0x17 || baseController == 0x18))
        {
            absoluteControl = PioneerDeckControl::filter;
            absoluteDeck = baseController == 0x17 ? 1 : 2;
            isHighResolutionControl = true;
        }
    }

    if (isHighResolutionControl)
    {
        const auto channelIndex = static_cast<std::size_t>(channel);
        const auto controllerIndex = static_cast<std::size_t>(baseController);
        if (data1 == baseController)
        {
            highResolutionMsb[channelIndex][controllerIndex] = data2;
            highResolutionMsbPending[channelIndex][controllerIndex] = true;
            return std::nullopt;
        }
        if (!highResolutionMsbPending[channelIndex][controllerIndex]) return std::nullopt;

        highResolutionMsbPending[channelIndex][controllerIndex] = false;
        const auto combined = (highResolutionMsb[channelIndex][controllerIndex] << 7) | data2;
        return PioneerDeckControlEvent{absoluteControl, PioneerDeckControlKind::absolute,
                                       absoluteDeck, static_cast<double>(combined) / 16383.0};
    }

    if (channel > 1) return std::nullopt;
    const auto delta = relativeDelta(data2);
    if (delta == 0) return std::nullopt;

    PioneerDeckControl control;
    switch (data1)
    {
        case 0x22: control = PioneerDeckControl::jogScratch; break;
        case 0x23: control = PioneerDeckControl::jogPitchBend; break;
        case 0x1f: control = PioneerDeckControl::jogSearch; break;
        case 0x21: control = PioneerDeckControl::wheelPitchBend; break;
        case 0x26: control = PioneerDeckControl::wheelSearch; break;
        default: return std::nullopt;
    }

    return PioneerDeckControlEvent{control, PioneerDeckControlKind::relative, channel + 1,
                                   static_cast<double>(delta)};
}

} // namespace silverdaw
