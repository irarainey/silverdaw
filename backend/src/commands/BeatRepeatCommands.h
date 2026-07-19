#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class BridgeServer;
class ProjectState;
struct ProjectSession;

bool applyBeatRepeatAdd(const juce::var& payload, ProjectState& projectState);
bool applyBeatRepeatDelete(const juce::var& payload, ProjectState& projectState);
void syncBeatRepeatRegions(AudioEngine& engine, const ProjectState& projectState);
void finishBeatRepeatEdit(AudioEngine& engine, ProjectState& projectState,
                          BridgeServer& bridge, ProjectSession& session);

} // namespace silverdaw
