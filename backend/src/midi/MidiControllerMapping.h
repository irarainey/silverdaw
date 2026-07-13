#pragma once

#include <array>
#include <optional>

#include <juce_core/juce_core.h>

namespace silverdaw
{

struct MidiControllerProfile;

enum class MidiControllerAction
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

enum class MidiControllerValueKind
{
    button,
    relative,
    absolute
};

struct MidiControllerEvent
{
    MidiControllerAction action;
    MidiControllerValueKind kind;
    int deck = 0;
    double value = 0.0;
    int pad = 0;
};

struct MidiControllerOutputMessage
{
    int statusByte = 0;
    int data1 = 0;
    int data2 = 0;
};

class MidiDeckActivationState
{
public:
    bool toggle(int deck) noexcept;
    void selectExclusive(int deck) noexcept;
    void setEnabled(int deck, bool active) noexcept;
    bool isEnabled(int deck) const noexcept;
    bool allows(const MidiControllerEvent& event) const noexcept;

private:
    bool enabled[2]{true, true};
};

bool supportsMidiControllerMapping(const juce::String& deviceName);
bool supportsMidiControllerOutput(const juce::String& deviceName);
std::optional<juce::String> midiControllerManufacturerName(const juce::String& deviceName);
const char* midiControllerActionName(MidiControllerAction action) noexcept;
const char* midiControllerValueKindName(MidiControllerValueKind kind) noexcept;

class MidiControllerMapper
{
public:
    explicit MidiControllerMapper(const juce::String& deviceName);

    std::optional<MidiControllerEvent> mapMessage(int statusByte, int data1, int data2);
    std::array<MidiControllerOutputMessage, 2> selectedTrackMeterMessages(
        float peakL, float peakR) const noexcept;
    std::array<MidiControllerOutputMessage, 2> transportPlayMessages(bool playing) const noexcept;
    std::array<MidiControllerOutputMessage, 2> cueLightMessages(bool active) const noexcept;
    std::array<MidiControllerOutputMessage, 2> deckSelectionLightMessages(
        bool deck1Active, bool deck2Active) const noexcept;
    std::array<MidiControllerOutputMessage, 16> hotCueLightMessages(int markerCount) const noexcept;
    int scratchTicksPerTurn() const noexcept;

private:
    const MidiControllerProfile* profile = nullptr;
    bool shiftPressed[2]{false, false};
    bool jogTouched[2]{false, false};
    std::array<std::array<int, 32>, 16> highResolutionMsb{};
    std::array<std::array<bool, 32>, 16> highResolutionMsbPending{};
    std::array<std::array<int, 32>, 16> previousAbsolute{};
    std::array<std::array<bool, 32>, 16> previousAbsoluteValid{};
};

} // namespace silverdaw
