#include "PioneerDeckMapping.h"

#include <array>

namespace silverdaw
{
namespace
{
constexpr std::array<const char*, 16> supportedModels{
    "DDJ-1000", "DDJ-800", "DDJ-FLX10", "DDJ-RB",  "DDJ-RR", "DDJ-RX", "DDJ-RZ",
    "DDJ-RZX",  "DDJ-SB",  "DDJ-SB2",   "DDJ-SR",  "DDJ-SX", "DDJ-SX2", "DDJ-SZ",
    "DDJ-WEGO4", "DDJ-ERGO"};

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
} // namespace

bool supportsPioneerTwoDeckMapping(const juce::String& deviceName)
{
    const auto upperName = deviceName.toUpperCase();
    for (const auto* model : supportedModels)
        if (containsModelName(upperName, model)) return true;
    return false;
}

const char* pioneerDeckControlName(PioneerDeckControl control) noexcept
{
    switch (control)
    {
        case PioneerDeckControl::playPause: return "playPause";
        case PioneerDeckControl::previousMarker: return "previousMarker";
        case PioneerDeckControl::nextMarker: return "nextMarker";
        case PioneerDeckControl::shift: return "shift";
        case PioneerDeckControl::jogScratch: return "jogScratch";
        case PioneerDeckControl::jogPitchBend: return "jogPitchBend";
        case PioneerDeckControl::jogSearch: return "jogSearch";
        case PioneerDeckControl::jogTouch: return "jogTouch";
        case PioneerDeckControl::wheelPitchBend: return "wheelPitchBend";
        case PioneerDeckControl::wheelSearch: return "wheelSearch";
        case PioneerDeckControl::crossfader: return "crossfader";
    }
    return "";
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

std::optional<PioneerDeckControlEvent> PioneerDeckMapper::mapMessage(int statusByte, int data1, int data2)
{
    if (data1 < 0 || data2 < 0) return std::nullopt;

    const auto messageType = statusByte & 0xf0;
    const auto channel = statusByte & 0x0f;

    if ((messageType == 0x80 || messageType == 0x90) && channel <= 1)
    {
        const auto deck = channel + 1;
        const auto pressed = messageType == 0x90 && data2 > 0;
        if (data1 == 0x3f)
        {
            shiftPressed[channel] = pressed;
            return buttonEvent(PioneerDeckControl::shift, deck, pressed);
        }
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
        return std::nullopt;
    }

    if (messageType != 0xb0) return std::nullopt;

    if (channel == 6 && (data1 == 0x1f || data1 == 0x3f))
    {
        if (data1 == 0x1f)
        {
            crossfaderMsb = data2;
            crossfaderMsbPending = true;
            return std::nullopt;
        }
        if (!crossfaderMsbPending) return std::nullopt;
        crossfaderLsb = data2;
        crossfaderMsbPending = false;
        const auto combined = (crossfaderMsb << 7) | crossfaderLsb;
        return PioneerDeckControlEvent{PioneerDeckControl::crossfader,
                                       PioneerDeckControlKind::absolute, 0,
                                       static_cast<double>(combined) / 16383.0};
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
