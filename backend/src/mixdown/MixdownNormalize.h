#pragma once

// Shared TPDF dither keeps 16-bit output identical across render paths.

#include "LoudnessAnalyzer.h"
#include "MixdownDither.h"
#include "MixdownEngine.h"  // MixdownOptions, MixdownFailureCode, BridgeServer fwd

#include <atomic>
#include <cstdint>

#include <juce_core/juce_core.h>

namespace silverdaw::mixdown_normalize
{

struct Pass2Result
{
    bool ok { false };
    MixdownFailureCode code { MixdownFailureCode::Io };
    juce::String message;

    int64_t outputFramesWritten { 0 };
    int64_t clippedSamples { 0 };
    double postGainPeakAmp { 0.0 };
    LoudnessAnalyzer::Result finalLoudness {};
};

Pass2Result runNormalizePass2(const juce::File& f32TmpFile,
                              const juce::File& tmpFile,
                              const MixdownOptions& options,
                              const juce::File& lameApp,
                              int chosenBitDepth,
                              bool wantFloatWav,
                              double appliedGainDb,
                              LoudnessAnalyzer& analyzer,
                              mixdown_dither::Xorshift32& rngL,
                              mixdown_dither::Xorshift32& rngR,
                              BridgeServer& bridge,
                              std::atomic<bool>& cancelFlag);

} // namespace silverdaw::mixdown_normalize
