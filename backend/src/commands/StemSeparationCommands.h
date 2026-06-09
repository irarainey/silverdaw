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
                        juce::String& activeJobId);

void handleStemSeparateCancel(const juce::var& payload,
                              std::atomic<bool>& busyFlag,
                              std::atomic<bool>& cancelFlag,
                              const juce::String& activeJobId);

} // namespace silverdaw
