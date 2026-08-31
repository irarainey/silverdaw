#pragma once

// Shared decode front-end for offline tempo analysis.
//
// Extracted from BpmDetector::analyse so that every tempo estimator sees byte
// -identical audio. That matters more than the code saving: comparing two
// estimators is only meaningful if any difference in their answers comes from
// the algorithms and not from a divergent decode, resample or channel fold.

#include <functional>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>
#include <vector>

namespace silverdaw
{

/** Why a decode produced no usable audio; `Ok` is the only success value. */
enum class BpmDecodeStatus
{
    Ok,
    MissingFile,
    NoReader,
    UnusableFormat,
    ReadFailed,
    ResampleFailed,
    TimedOut
};

struct BpmDecodeResult
{
    BpmDecodeStatus status = BpmDecodeStatus::MissingFile;
    /** Mono, at the requested analysis sample rate. Empty unless `status == Ok`. */
    std::vector<float> mono;
    /** The file's own rate, retained so beat times can be reported in source time. */
    double sourceSampleRate = 0.0;
    /** Set when the decode stopped early but kept enough audio to analyse. Forces
        `lowConfidence` on the result: the estimate describes only the part of the file
        that was read, so it may not hold for the rest. */
    bool truncated = false;

    bool ok() const noexcept { return status == BpmDecodeStatus::Ok; }
};

/** Minimum audio required before a truncated decode is still worth analysing.
    Comfortably more than the detector's six-beat fitting minimum at any
    plausible tempo (20 s is 13 beats even at 40 BPM), while still refusing
    fragments too short to yield a trustworthy period. */
constexpr double kMinUsableAnalysisSeconds = 20.0;

/** Decodes `audioFile` to one contiguous mono buffer at `analysisSampleRate`.
    Channels are averaged (tempo estimators here are single-channel), and at most
    `maxSeconds` of source audio is read so a pathological input cannot exhaust
    memory. `shouldAbort` is polled periodically during the decode loop; return
    true from it to abandon the pass with `TimedOut`. Blocking: call from a
    worker, never the audio or message thread. */
BpmDecodeResult decodeMonoForAnalysis(const juce::File& audioFile,
                                      juce::AudioFormatManager& formatManager, double maxSeconds,
                                      double analysisSampleRate,
                                      const std::function<bool()>& shouldAbort);

} // namespace silverdaw
