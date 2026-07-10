#pragma once

#include <array>
#include <optional>

#include <juce_core/juce_core.h>

namespace silverdaw
{

enum class PioneerDeckControl
{
    playPause,
    previousMarker,
    nextMarker,
    deckToggle,
    shift,
    syncModifier,
    jogScratch,
    jogPitchBend,
    jogSearch,
    jogTouch,
    wheelPitchBend,
    wheelSearch,
    browseTracks,
    browsePress,
    timelineZoom,
    markerJump,
    markerToggle,
    trackGain,
    toneBass,
    toneMid,
    toneTreble,
    filter,
    masterVolume,
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
    int pad = 0;
};

struct PioneerDeckOutputMessage
{
    int statusByte = 0;
    int data1 = 0;
    int data2 = 0;
};

class PioneerDeckActivationState
{
public:
    bool toggle(int deck) noexcept;
    void setEnabled(int deck, bool active) noexcept;
    bool isEnabled(int deck) const noexcept;
    bool allows(const PioneerDeckControlEvent& event) const noexcept;

private:
    bool enabled[2]{true, true};
};

bool supportsPioneerTwoDeckMapping(const juce::String& deviceName);
bool supportsPioneerChannelMeterOutput(const juce::String& deviceName);
const char* pioneerDeckControlName(PioneerDeckControl control) noexcept;
const char* pioneerDeckControlKindName(PioneerDeckControlKind kind) noexcept;
std::array<PioneerDeckOutputMessage, 2> pioneerSelectedTrackMeterMessages(float peakL,
                                                                         float peakR) noexcept;
std::array<PioneerDeckOutputMessage, 2> pioneerTransportPlayMessages(bool playing) noexcept;
std::array<PioneerDeckOutputMessage, 2> pioneerCueLightMessages(bool active) noexcept;
std::array<PioneerDeckOutputMessage, 2> pioneerDeckSelectionLightMessages(
    bool deck1Active, bool deck2Active) noexcept;
std::array<PioneerDeckOutputMessage, 16> pioneerHotCueLightMessages(int markerCount) noexcept;

class PioneerDeckMapper
{
public:
    explicit PioneerDeckMapper(const juce::String& deviceName);

    std::optional<PioneerDeckControlEvent> mapMessage(int statusByte, int data1, int data2);

private:
    bool shiftPressed[2]{false, false};
    std::array<std::array<int, 32>, 16> highResolutionMsb{};
    std::array<std::array<bool, 32>, 16> highResolutionMsbPending{};
    bool standardMixerControls = true;
    bool standardFilterControls = true;
    bool standardHotCuePads = true;
    bool masterLevelController08 = true;
    int syncPrimaryNote = 0x58;
};

} // namespace silverdaw
