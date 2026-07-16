#pragma once

#include "BusGraph.h"

#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

#include <unordered_map>
#include <vector>

namespace silverdaw
{

class AudioEngine;
class BridgeServer;
class ProjectState;

/** Polls the audio engine and broadcasts PLAYHEAD_UPDATE while playing. */
class PlayheadEmitter : public juce::Timer
{
  public:
    PlayheadEmitter(AudioEngine& e, BridgeServer& b, ProjectState& p);

    void timerCallback() override;

  private:
    AudioEngine& engine;
    BridgeServer& bridge;
    ProjectState& project;
    // `payloadObject` keeps the pre-wrapped broadcast payload alive.
    juce::DynamicObject::Ptr payloadObject;
    juce::var payload;
    double lastPosMs = -1.0;
    juce::DynamicObject::Ptr previewPayloadObject{new juce::DynamicObject()};
    juce::var previewPayload{previewPayloadObject.get()};
    double lastPreviewPosMs = -1.0;
    juce::DynamicObject::Ptr masterLevelObject{new juce::DynamicObject()};
    juce::var masterLevelPayload{masterLevelObject.get()};
    bool lastMasterLevelHadSignal = false;
    // Wall-clock throttle for the perf.master output-peak diagnostic.
    static constexpr double kMasterPeakLogIntervalMs = 250.0;
    double lastMasterPeakLogMs = 0.0;
    float masterPeakLogMaxL = 0.0F;
    float masterPeakLogMaxR = 0.0F;
    // Wall-clock throttle for the perf.audio block-timing diagnostic.
    static constexpr double kAudioPerfLogIntervalMs = 1000.0;
    double lastAudioPerfLogMs = 0.0;
    juce::DynamicObject::Ptr trackLevelsObject{new juce::DynamicObject()};
    juce::var trackLevelsPayload{trackLevelsObject.get()};
    bool lastTrackLevelsHadSignal = false;
    // Reused across ticks to avoid reallocating the scratch vector.
    std::vector<BusGraph::TrackPeakSnapshot> trackPeakScratch;
    // Last observed bus-graph skip count, to log only newly dropped blocks.
    juce::uint64 lastSkippedBlocks = 0;
    int scratchStateTick = 0;
    juce::String lastScratchStatus;
    double lastScratchCrossfader = -1.0;
    // Wall-clock throttle for the perf.tracks per-track output-peak diagnostic.
    // Pinpoints which track falls silent (e.g. after a gain/filter change) since the
    // master meter alone hides a single muted track behind the others. Peaks are
    // accumulated per track between emissions so short one-shot clips are not missed.
    static constexpr double kTracksPeakLogIntervalMs = 250.0;
    double lastTracksPeakLogMs = 0.0;
    std::unordered_map<juce::String, std::pair<float, float>> tracksPeakLogMax;
};

} // namespace silverdaw
