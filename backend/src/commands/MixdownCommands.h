#pragma once

#include <atomic>

#include <juce_core/juce_core.h>

namespace silverdaw
{

class AudioEngine;
class ProjectState;
class BridgeServer;
class DecodedCache;

// Offline-mixdown command handlers. MIXDOWN_START validates the export
// request, snapshots the project on the message thread, then dispatches
// the render onto the peak pool (results stream back as MIXDOWN_PROGRESS
// / MIXDOWN_DONE / MIXDOWN_FAILED). `mixdownBusy` / `mixdownCancel` are
// owned by the caller so the transport-play gate can observe an
// in-flight render.

void handleMixdownStart(const juce::var& payload, AudioEngine& engine, ProjectState& projectState,
                        BridgeServer& bridge, juce::ThreadPool& peakPool, const DecodedCache& decodedCache,
                        std::atomic<bool>& mixdownBusy, std::atomic<bool>& mixdownCancel);

void handleMixdownCancel(std::atomic<bool>& mixdownBusy, std::atomic<bool>& mixdownCancel);

} // namespace silverdaw
