#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;
class DecodedCache;
class PeakJobCoordinator;
class PeaksCache;

namespace waveform { struct PeaksResult; }

// Keep bridge and sample-export peak rates aligned.

double effectivePeaksPerSecond(const waveform::PeaksResult& result);
[[nodiscard]] bool clipAddRequestsWaveform(const juce::var& payload);

void handleClipAdd(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                   BridgeServer& bridge, juce::ThreadPool& peakPool, const PeaksCache& cache,
                   const DecodedCache& decodedCache, PeakJobCoordinator& peakJobs);
void handleWaveformRequest(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                           BridgeServer& bridge, juce::ThreadPool& peakPool, const PeaksCache& cache,
                           const DecodedCache& decodedCache, PeakJobCoordinator& peakJobs);
void handleClipEditorPeaksRequest(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                                  BridgeServer& bridge, juce::ThreadPool& peakPool, const PeaksCache& cache,
                                  const DecodedCache& decodedCache, PeakJobCoordinator& peakJobs);

} // namespace silverdaw
