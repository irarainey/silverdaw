#pragma once

// Builds and sends the inbound stem-separation envelopes (STEM_PROGRESS /
// STEM_READY / STEM_FAILED). Mirrors MixdownBroadcast so the wire shapes stay
// in one focused place, matching the zod schema in bridge-protocol.ts.

#include <vector>

#include <juce_core/juce_core.h>

#include "StemSeparator.h" // StemFailureCode, StemResultFile

namespace silverdaw
{

class BridgeServer;

namespace stem_bridge
{

void broadcastProgress(BridgeServer& bridge,
                       const juce::String& jobId,
                       const juce::String& clipId,
                       const char* stage,
                       double percent,
                       const juce::String& detail = {});

// One stem finished while the job is still running; lets the UI place its track
// immediately. The final STEM_READY still lists every stem.
void broadcastPartial(BridgeServer& bridge,
                      const juce::String& jobId,
                      const juce::String& clipId,
                      const juce::String& sourceName,
                      const StemResultFile& stem);

void broadcastReady(BridgeServer& bridge,
                    const juce::String& jobId,
                    const juce::String& clipId,
                    const juce::String& sourceName,
                    const std::vector<StemResultFile>& stems);

void broadcastFailed(BridgeServer& bridge,
                     const juce::String& jobId,
                     const juce::String& clipId,
                     StemFailureCode code,
                     const juce::String& error);

} // namespace stem_bridge
} // namespace silverdaw
