#pragma once

#include "BusGraph.h"

#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

#include <vector>

namespace silverdaw
{

class AudioEngine;
class BridgeServer;

/** Polls the audio engine and broadcasts PLAYHEAD_UPDATE while playing. */
class PlayheadEmitter : public juce::Timer
{
  public:
    PlayheadEmitter(AudioEngine& e, BridgeServer& b);

    void timerCallback() override;

  private:
    AudioEngine& engine;
    BridgeServer& bridge;
    // Reference-counted: held alive by `payloadObject`; `payload` is the
    // pre-wrapped juce::var we hand to broadcast() each tick.
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
    juce::DynamicObject::Ptr trackLevelsObject{new juce::DynamicObject()};
    juce::var trackLevelsPayload{trackLevelsObject.get()};
    bool lastTrackLevelsHadSignal = false;
    // Reused across ticks so steady-state metering broadcasts allocate
    // only the per-track DynamicObject envelope payloads (not this
    // scratch vector itself).
    std::vector<BusGraph::TrackPeakSnapshot> trackPeakScratch;
};

} // namespace silverdaw
