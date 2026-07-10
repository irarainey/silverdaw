#pragma once

#include "MidiControllerMapping.h"

#include <optional>
#include <vector>

#include <juce_core/juce_core.h>

namespace silverdaw
{

enum class MidiInputEncoding
{
    button,
    relative,
    relativeTwosComplement,
    absolute7,
    absolute14,
    absolute14Relative,
    padRange
};

enum class MidiOutputPurpose
{
    channelMeter,
    playLight,
    cueLight,
    deckSelectionLight,
    hotCueLights
};

struct MidiInputBinding
{
    MidiControllerAction action;
    std::optional<MidiControllerAction> shiftedAction;
    std::optional<MidiControllerAction> touchedAction;
    MidiInputEncoding encoding;
    int messageType = 0;
    int data1 = 0;
    int data1Count = 1;
    int lsbData1 = -1;
    int center = 64;
    int direction = 1;
    int padOffset = 0;
    std::vector<int> channels;
    std::vector<int> decks;
};

struct MidiOutputBinding
{
    MidiOutputPurpose purpose;
    int messageType = 0;
    int data1 = 0;
    int onValue = 127;
    int offValue = 0;
    int count = 8;
    std::vector<int> data1Values;
    std::vector<int> channels;
};

struct MidiControllerProfile
{
    juce::String name;
    std::vector<juce::String> models;
    std::vector<juce::String> excludedModels;
    std::vector<MidiInputBinding> inputs;
    std::vector<MidiOutputBinding> outputs;
};

const MidiControllerProfile* findMidiControllerProfile(const juce::String& deviceName);
const MidiOutputBinding* findMidiOutputBinding(const MidiControllerProfile& profile,
                                               MidiOutputPurpose purpose) noexcept;

} // namespace silverdaw
