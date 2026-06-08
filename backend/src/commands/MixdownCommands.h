#pragma once

#include <atomic>

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;
class DecodedCache;

// Caller-owned atomics let transport observe an in-flight offline render.

void handleMixdownStart(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                        BridgeServer& bridge, juce::ThreadPool& peakPool, const DecodedCache& decodedCache,
                        std::atomic<bool>& mixdownBusy, std::atomic<bool>& mixdownCancel);

void handleMixdownCancel(std::atomic<bool>& mixdownBusy, std::atomic<bool>& mixdownCancel);

} // namespace silverdaw
