#pragma once

// Mixdown render pass-1: build the per-clip offline source graph, run the main
// pump loop (read → mix → master gain → meter → final-resample → optional
// dither → write), and flush. Split out of MixdownRender.cpp to mirror the
// pass-2 split (MixdownNormalize.cpp) and keep `runMixdownJob` as the
// orchestration layer.
//
// The built clip chains are RETURNED to the caller (not destroyed here): on
// Windows, closing each source reader's file handle is ~1 s, so the caller
// defers that teardown until AFTER the MIXDOWN_DONE broadcast so the dialog
// dismisses promptly.

#include "LoudnessAnalyzer.h"
#include "MixdownDither.h"
#include "MixdownEngine.h"  // MixdownSnapshot, MixdownOptions, MixdownFailureCode, BridgeServer fwd
#include "MixdownGraph.h"   // OfflineClip

#include <atomic>
#include <memory>
#include <vector>

#include <juce_audio_formats/juce_audio_formats.h>

namespace silverdaw
{
namespace mixdown_render_pass1
{

struct Pass1Result
{
    bool ok { false };
    MixdownFailureCode code { MixdownFailureCode::Io };
    juce::String message;

    // The live per-clip chains, handed back for deferred teardown.
    std::vector<std::unique_ptr<mixdown_graph::OfflineClip>> clips;

    int64_t outputFramesWritten { 0 };
    double effectiveRenderLengthMs { 0.0 };
    double preClampPeakAmplitude { 0.0 };
    int64_t clippedSampleCount { 0 };
};

// Runs the whole pass-1 stream into `writer` (already opened by the caller).
// `analyzer`, when non-null, is fed the pre-dither program for loudness
// measurement but is NOT finalized here. On failure the result carries the
// code + message and any partial file at `pass1File` has been removed.
Pass1Result runPass1(const MixdownSnapshot& snapshot,
                     const MixdownOptions& options,
                     juce::AudioFormatManager& formatManager,
                     juce::AudioFormatWriter& writer,
                     LoudnessAnalyzer* analyzer,
                     bool normalizing,
                     bool analyzing,
                     const juce::File& pass1File,
                     mixdown_dither::Xorshift32& rngL,
                     mixdown_dither::Xorshift32& rngR,
                     BridgeServer& bridge,
                     std::atomic<bool>& cancelFlag);

} // namespace mixdown_render_pass1
} // namespace silverdaw
