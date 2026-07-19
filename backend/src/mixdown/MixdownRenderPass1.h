#pragma once

// Pass 1 returns clip chains so Windows handle teardown can be deferred.

#include "LoudnessAnalyzer.h"
#include "MixdownDither.h"
#include "MixdownEngine.h"  // MixdownSnapshot, MixdownOptions, MixdownFailureCode, BridgeServer fwd
#include "MixdownGraph.h"   // OfflineClip

#include <atomic>
#include <memory>
#include <vector>

#include <juce_audio_formats/juce_audio_formats.h>

namespace silverdaw::mixdown_render_pass1
{

struct Pass1Result
{
    bool ok { false };
    MixdownFailureCode code { MixdownFailureCode::Io };
    juce::String message;

    // Member order preserves JUCE source lifetimes during teardown.
    std::vector<std::unique_ptr<mixdown_graph::OfflineClip>> clips;

    int64_t outputFramesWritten { 0 };
    double effectiveRenderLengthMs { 0.0 };
    double preClampPeakAmplitude { 0.0 };
    int64_t clippedSampleCount { 0 };
};

// Loudness normalization uses a measured pass before final gain, limiting, dither, and encode.
Pass1Result runPass1(const MixdownSnapshot& snapshot,
                     const MixdownOptions& options,
                     juce::AudioFormatManager& formatManager,
                     juce::AudioFormatWriter& writer,
                     LoudnessAnalyzer* analyzer,
                     bool normalizing,
                     bool analyzing,
                     mixdown_dither::Xorshift32& rngL,
                     mixdown_dither::Xorshift32& rngR,
                     BridgeServer& bridge,
                     std::atomic<bool>& cancelFlag);

} // namespace silverdaw::mixdown_render_pass1
