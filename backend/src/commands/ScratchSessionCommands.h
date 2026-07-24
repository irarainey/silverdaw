#pragma once

#include <juce_core/juce_core.h>

namespace juce
{
class ThreadPool;
}

namespace silverdaw
{

class AudioEngine;
class BridgeServer;
class PeaksCache;
class ProjectState;

void handleScratchSessionOpen(const juce::var& payload,
                              AudioEngine& engine,
                              ProjectState& projectState,
                              BridgeServer& bridge,
                              juce::ThreadPool& workerPool,
                              const PeaksCache& cache,
                              const juce::String& projectPath);
void handleScratchSessionClose(const juce::var& payload,
                               AudioEngine& engine,
                               BridgeServer& bridge);
void handleScratchSessionControl(const juce::var& payload,
                                 AudioEngine& engine,
                                 BridgeServer& bridge);
void handleScratchBackingPrepare(const juce::var& payload,
                                 AudioEngine& engine,
                                 ProjectState& projectState,
                                 BridgeServer& bridge,
                                 juce::ThreadPool& workerPool);
void handleScratchBackingClear(const juce::var& payload,
                               AudioEngine& engine,
                               BridgeServer& bridge);
void broadcastScratchSessionState(AudioEngine& engine, BridgeServer& bridge);

} // namespace silverdaw
