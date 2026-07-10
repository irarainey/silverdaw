#pragma once

#include <optional>

#include <juce_core/juce_core.h>

namespace silverdaw
{

enum class PioneerDeckControl
{
    playPause,
    previousMarker,
    nextMarker,
    shift,
    jogScratch,
    jogPitchBend,
    jogSearch,
    jogTouch,
    wheelPitchBend,
    wheelSearch,
    crossfader
};

enum class PioneerDeckControlKind
{
    button,
    relative,
    absolute
};

struct PioneerDeckControlEvent
{
    PioneerDeckControl control;
    PioneerDeckControlKind kind;
    int deck = 0;
    double value = 0.0;
};

bool supportsPioneerTwoDeckMapping(const juce::String& deviceName);
const char* pioneerDeckControlName(PioneerDeckControl control) noexcept;
const char* pioneerDeckControlKindName(PioneerDeckControlKind kind) noexcept;

class PioneerDeckMapper
{
public:
    std::optional<PioneerDeckControlEvent> mapMessage(int statusByte, int data1, int data2);

private:
    bool shiftPressed[2]{false, false};
    int crossfaderMsb = 0;
    int crossfaderLsb = 0;
    bool crossfaderMsbPending = false;
};

} // namespace silverdaw
