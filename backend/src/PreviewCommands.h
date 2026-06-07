#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;
class DecodedCache;

// PREVIEW_* command handlers — the Clip Editor's exclusive audition path. Kept
// out of the Main.cpp dispatcher; each drives the engine's preview voice and
// (where relevant) broadcasts the resulting PREVIEW_STATE to the renderer.

void handlePreviewLoad(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                       BridgeServer& bridge, const DecodedCache& decodedCache);
void handlePreviewUnload(AudioEngine& engine, BridgeServer& bridge);
void handlePreviewPlay(AudioEngine& engine, BridgeServer& bridge);
void handlePreviewPause(AudioEngine& engine, BridgeServer& bridge);
void handlePreviewStop(AudioEngine& engine, BridgeServer& bridge);
void handlePreviewSeek(const juce::var& payload, AudioEngine& engine);
void handlePreviewSetWarp(const juce::var& payload, AudioEngine& engine);
void handlePreviewSetEnvelope(const juce::var& payload, AudioEngine& engine);

} // namespace silverdaw
