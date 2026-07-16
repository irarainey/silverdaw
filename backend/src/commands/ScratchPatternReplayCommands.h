#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class BridgeServer;
class ProjectState;
struct ProjectSession;

void handleScratchPatternApply(const juce::var& payload, ProjectState& projectState,
                               AudioEngine& engine, BridgeServer& bridge,
                               const ProjectSession& session);

void handleScratchPatternRemove(const juce::var& payload, ProjectState& projectState,
                                AudioEngine& engine, BridgeServer& bridge,
                                const ProjectSession& session);

void handleScratchPatternReplayStart(const juce::var& payload, AudioEngine& engine,
                                     ProjectState& projectState, BridgeServer& bridge);

void handleScratchPatternReplayStop(const juce::var& payload, AudioEngine& engine,
                                    BridgeServer& bridge);

} // namespace silverdaw
