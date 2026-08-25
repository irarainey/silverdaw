#pragma once

#include "BeatRepeatSnapshot.h"
#include "BusGraph.h"
#include "DeviceCallbackGuard.h"
#include "MasterClockSource.h"
#include "MeteringSource.h"
#include "Metronome.h"
#include "OutputKeepAlive.h"
#include "PluginCatalogue.h"
#include "PluginEditorWindow.h"
#include "PluginPlayHead.h"
#include "ProjectStateTypes.h"
#include "TrackAutomationSnapshot.h"

#include <atomic>
#include <memory>
#include <unordered_map>
#include <vector>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>

namespace silverdaw
{

// Output graph, device, and track-effect snapshot ownership.
class AudioEngineGraphState
{
protected:
    struct BeatRepeatDefinition
    {
        std::vector<BeatRepeatRegion> regions;
        double bpm = 120.0;
    };

    juce::AudioDeviceManager deviceManager;
    juce::AudioSourcePlayer sourcePlayer;
    DeviceCallbackGuard deviceCallbackGuard{sourcePlayer};
    BusGraph busGraph;
    std::atomic<bool> audioReady{false};

    std::unordered_map<juce::String, std::unique_ptr<TrackAutomationSnapshot>> automationCurrent;
    std::vector<std::unique_ptr<TrackAutomationSnapshot>> retiredAutomation;
    std::unordered_map<juce::String, BeatRepeatDefinition> beatRepeatDefinitions;
    std::unordered_map<juce::String, std::unique_ptr<BeatRepeatSnapshot>> beatRepeatCurrent;
    std::vector<std::unique_ptr<BeatRepeatSnapshot>> retiredBeatRepeats;

    OutputKeepAlive outputKeepAlive;
    MasterClockSource master{busGraph, outputKeepAlive};
    juce::MixerAudioSource topMixer;
    Metronome metronome;
    MeteringSource masterMeter{topMixer, outputKeepAlive, master, metronome};
    juce::AudioFormatManager formatManager;
    // Created on first use: constructing it touches the on-disk plugin catalogue, which a
    // headless run that never mentions plugins has no reason to read or write.
    std::unique_ptr<plugins::PluginCatalogue> pluginCatalogueInstance;
    // Open native plugin editors, keyed by slot id, so a second open request refocuses the
    // existing window and removing a slot can close its window before the instance dies.
    std::unordered_map<std::string, std::unique_ptr<plugins::PluginEditorWindow>> pluginEditors;
    // Shared by every hosted plugin — one transport, read on the audio thread.
    plugins::PluginPlayHead pluginPlayHead;
};

} // namespace silverdaw
