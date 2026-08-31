#pragma once

#include <juce_core/juce_core.h>

namespace juce
{
class ThreadPool;
}

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;
class DecodedCache;

// Clip Editor preview is an exclusive audition path, separate from transport.

void handlePreviewLoad(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                       BridgeServer& bridge, const DecodedCache& decodedCache,
                       juce::ThreadPool& peakPool);
void handlePreviewUnload(AudioEngine& engine, BridgeServer& bridge);
void handlePreviewPlay(AudioEngine& engine, BridgeServer& bridge);
void handlePreviewPause(AudioEngine& engine, BridgeServer& bridge);
void handlePreviewStop(AudioEngine& engine, BridgeServer& bridge);
void handlePreviewSeek(const juce::var& payload, AudioEngine& engine);
void handlePreviewSetLoop(const juce::var& payload, AudioEngine& engine);
void handlePreviewSetWarp(const juce::var& payload, AudioEngine& engine);
void handlePreviewSetEnvelope(const juce::var& payload, AudioEngine& engine);
void handlePreviewSetReversed(const juce::var& payload, AudioEngine& engine);
void handlePreviewSetBrake(const juce::var& payload, AudioEngine& engine, ProjectState& projectState);
void handlePreviewSetBackspin(const juce::var& payload, AudioEngine& engine, ProjectState& projectState);
void handlePreviewSetMetronome(const juce::var& payload, AudioEngine& engine, ProjectState& projectState);

} // namespace silverdaw
