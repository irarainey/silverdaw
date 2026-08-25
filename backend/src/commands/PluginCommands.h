#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class BridgeServer;
class ProjectState;
struct ProjectSession;

// VST3 insert commands (ADR 0025). Every handler runs on the message thread and keeps the
// project tree and the live engine chain in step, then rebroadcasts PROJECT_STATE so the
// renderer's slot list comes from the one authority.

/** Broadcasts the scanned catalogue as PLUGIN_LIST. */
void broadcastPluginList(AudioEngine& engine, BridgeServer& bridge);

void handlePluginListRequest(AudioEngine& engine, BridgeServer& bridge);
void handlePluginScan(const juce::var& payload, AudioEngine& engine, BridgeServer& bridge);

void handleTrackAddPlugin(const juce::var& payload, AudioEngine& engine,
                          ProjectState& projectState, BridgeServer& bridge,
                          ProjectSession& session);
void handleTrackRemovePlugin(const juce::var& payload, AudioEngine& engine,
                             ProjectState& projectState, BridgeServer& bridge,
                             ProjectSession& session);
void handleTrackReorderPlugin(const juce::var& payload, AudioEngine& engine,
                              ProjectState& projectState, BridgeServer& bridge,
                              ProjectSession& session);
void handleTrackSetPluginBypass(const juce::var& payload, AudioEngine& engine,
                                ProjectState& projectState, BridgeServer& bridge);
void handleTrackOpenPluginEditor(const juce::var& payload, AudioEngine& engine,
                                 ProjectState& projectState, BridgeServer& bridge);

} // namespace silverdaw
