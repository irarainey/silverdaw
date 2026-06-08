#pragma once


#include "LoudnessAnalyzer.h"
#include "MixdownEngine.h"  // MixdownFailureCode, BridgeServer fwd-decl

#include <cstdint>

#include <juce_core/juce_core.h>

namespace silverdaw::mixdown_bridge
{

void broadcastProgress(BridgeServer& bridge, double percent, const char* stage);

void broadcastDone(BridgeServer& bridge,
                   const juce::File& outputFile,
                   double durationMs,
                   const LoudnessAnalyzer::Result* loudness,
                   bool limitedByTruePeak,
                   double appliedGainDb,
                   int64_t pass2PostGainClipCount,
                   double pass2PostGainPeakAmp);

void broadcastFailed(BridgeServer& bridge, MixdownFailureCode code, const juce::String& error);

} // namespace silverdaw::mixdown_bridge
