#pragma once

// Mixdown bridge-envelope emitters. The render pump (MixdownRender.cpp) and the
// Normalize pass-2 (MixdownNormalize.cpp) both stream MIXDOWN_PROGRESS and end
// on MIXDOWN_DONE / MIXDOWN_FAILED, so these live in one place rather than being
// duplicated per pass.

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
