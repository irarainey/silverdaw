#pragma once

#include "BeatRepeatSnapshot.h"
#include "BusGraph.h"
#include "MasterClockSource.h"
#include "MeteringSource.h"
#include "Metronome.h"
#include "OutputKeepAlive.h"
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
};

} // namespace silverdaw
