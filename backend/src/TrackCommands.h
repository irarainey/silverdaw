#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;

// TRACK_* command handlers. Extracted from Main.cpp (an oversized god file)
// so the dispatcher only routes to them. Each validates its envelope, mutates
// ProjectState, pushes any live values to the AudioEngine, and acks/broadcasts
// the applied state. Track gain/mute/solo share the effective-gain fan-out kept
// file-local in TrackCommands.cpp.

void handleTrackAdd(const juce::var& payload, ProjectState& projectState, BridgeServer& bridge);
void handleTrackRemove(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                       BridgeServer& bridge);
void handleTrackRename(const juce::var& payload, ProjectState& projectState);
void handleTrackGain(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                     BridgeServer& bridge);
void handleTrackMute(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                     BridgeServer& bridge);
void handleTrackSolo(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                     BridgeServer& bridge);
void handleTrackSetSends(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                         BridgeServer& bridge);
void handleTrackSetPan(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                       BridgeServer& bridge);
void handleTrackSetTone(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                        BridgeServer& bridge);
void handleTrackSetLeveler(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                           BridgeServer& bridge);

} // namespace silverdaw
