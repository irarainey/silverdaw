#pragma once

// Mixdown Normalize pass-2: stream the float intermediate written in pass-1,
// apply the loudness-derived linear gain, optionally dither to 16-bit, and
// encode the user's final container. Split out of MixdownRender.cpp because it
// is a self-contained second streaming pass with its own writer setup.

#include "LoudnessAnalyzer.h"
#include "MixdownDither.h"
#include "MixdownEngine.h"  // MixdownOptions, MixdownFailureCode, BridgeServer fwd

#include <atomic>
#include <cstdint>

#include <juce_core/juce_core.h>

namespace silverdaw
{
namespace mixdown_normalize
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

// Performs the whole pass-2 stream. On failure the result carries the code +
// message and all pass-2-local files/writers have already been cleaned up; the
// caller only needs to broadcast the failure. `rngL`/`rngR` are the same dither
// generators used by pass-1 so the quantisation is consistent.
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

} // namespace mixdown_normalize
} // namespace silverdaw
