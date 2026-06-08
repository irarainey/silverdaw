#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;
class DecodedCache;

// Clip Editor preview is an exclusive audition path, separate from transport.

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
