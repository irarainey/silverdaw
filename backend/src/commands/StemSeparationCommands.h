#pragma once

#include <atomic>

#include <juce_core/juce_core.h>

namespace silverdaw
{

class ProjectState;
class BridgeServer;
class DecodedCache;
class StemSeparator;

// Resolves the clip's decoded source, builds a StemSeparationRequest, and
// launches the background separation job. `activeJobId` is read/written only on
// the message thread (both this and cancel run there), so it needs no lock.
void handleStemSeparate(const juce::var& payload,
                        ProjectState& projectState,
                        BridgeServer& bridge,
                        juce::ThreadPool& pool,
                        const DecodedCache& decodedCache,
                        StemSeparator& separator,
                        std::atomic<bool>& busyFlag,
                        std::atomic<bool>& cancelFlag,
                        juce::String& activeJobId,
                        const juce::String& projectPath);

void handleStemSeparateCancel(const juce::var& payload,
                              std::atomic<bool>& busyFlag,
                              std::atomic<bool>& cancelFlag,
                              const juce::String& activeJobId);

// Maps a requested quality preset to the inference window overlap fraction.
// Higher overlap = smoother seams but more model runs (slower). Unknown or
// absent values fall back to the "balanced" default so a malformed envelope is
// safe. Exposed for unit testing.
double overlapForStemQuality(const juce::String& quality);

// Base folder a project's separated stems are written under: a "stems" subfolder
// beside the project file when it has been saved (so the whole project folder is
// portable), otherwise the disposable temporary workspace for unsaved projects.
// Exposed for testing.
juce::File stemsOutputBaseDir(const juce::String& projectPath);

} // namespace silverdaw
