#pragma once

#include <atomic>

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;
class DecodedCache;
struct MixdownSnapshot;

// Capture the audible arrangement and live insert state before dispatching to a render worker.
MixdownSnapshot snapshotAudibleMixForExport(AudioEngine& engine, ProjectState& project, const DecodedCache& cache);

// Caller-owned atomics let transport observe an in-flight offline render.
void handleMixdownStart(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                        BridgeServer& bridge, juce::ThreadPool& peakPool, const DecodedCache& decodedCache,
                        std::atomic<bool>& mixdownBusy, std::atomic<bool>& mixdownCancel);

void handleMixdownCancel(std::atomic<bool>& mixdownBusy, std::atomic<bool>& mixdownCancel);

void handleTrackExportStart(const juce::var& payload, AudioEngine& engine, ProjectState& project,
                            BridgeServer& bridge, juce::ThreadPool& pool, const DecodedCache& cache,
                            const juce::String& projectPath, std::atomic<bool>& busy, std::atomic<bool>& cancel);

} // namespace silverdaw
