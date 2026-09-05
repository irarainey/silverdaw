#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{
class AudioEngine;
class BridgeServer;
class DecodedCache;
class PeakJobCoordinator;
class PeaksCache;
class ProjectState;
struct ProjectSession;

// Audio recording (ADR 0030). A recording is captured on a standalone input
// device, finalised offline and only then offered as an ordinary library
// sample: nothing touches the project until the user commits.

void handleRecordInputsRequest(const juce::var& payload, BridgeServer& bridge);

void handleRecordSessionOpen(const juce::var& payload, AudioEngine& engine,
                             ProjectState& projectState, BridgeServer& bridge,
                             juce::ThreadPool& peakPool, const PeaksCache& cache,
                             ProjectSession& session);

void handleRecordSessionControl(const juce::var& payload, ProjectState& projectState,
                                BridgeServer& bridge);

void handleRecordSessionClose(const juce::var& payload, BridgeServer& bridge);

void handleRecordRecordingCommit(const juce::var& payload, AudioEngine& engine,
                                 ProjectState& projectState, BridgeServer& bridge,
                                 juce::ThreadPool& peakPool, const PeaksCache& cache,
                                 const DecodedCache& decodedCache, PeakJobCoordinator& peakJobs,
                                 ProjectSession& session);

} // namespace silverdaw
