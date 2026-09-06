#pragma once

#include <juce_audio_formats/juce_audio_formats.h>

namespace silverdaw::recording
{

struct FinaliseRequest
{
    juce::File sourceFile;
    juce::File destinationFile;
    /** Rate the file was written at, the rate the capture clock actually ran at, and the
     *  rate the output device — and so the timeline the take will sit on — really advances
     *  at. All three measured against the same wall clock, so common-mode wall-clock error
     *  cancels in the ratio. `measuredSampleRate == timelineSampleRate` means no drift;
     *  `timelineSampleRate` of 0 falls back to the nominal rate. */
    double nominalSampleRate = 0.0;
    double measuredSampleRate = 0.0;
    double timelineSampleRate = 0.0;
    /** Round trip the performer played against: input plus output latency. */
    double latencyMs = 0.0;
    /** Exact length the finished file should have, in ms; 0 leaves it untrimmed.
     *  Used when a beat count is claimed for the recording, so the count stays true
     *  of the audio after the capture overrun past the window end is removed. Only
     *  ever trims: material shorter than this is left alone and reported as such. */
    double exactDurationMs = 0.0;
};

struct FinaliseResult
{
    bool ok = false;
    juce::String error;
    double durationMs = 0.0;
    double sampleRate = 0.0;
    int channelCount = 0;
    double driftPpm = 0.0;
    double latencyOffsetMs = 0.0;
    /** True when `exactDurationMs` was requested and the audio was long enough to
     *  trim to it. False means the caller must not claim a beat count. */
    bool exactLength = false;
};

/**
 * Corrects latency and clock drift once, offline, before the recording becomes
 * a library item (ADR 0030). Latency is a trim from the head; drift is a
 * resample to the measured ratio. Streamed in blocks, so a long recording never
 * has to fit in memory. Worker thread only.
 */
FinaliseResult finaliseRecording(const FinaliseRequest& request,
                                 juce::AudioFormatManager& formatManager);

/**
 * Writes `source` out as a two-channel WAV with its single channel on both
 * sides, leaving the source untouched (ADR 0030, Amendment 9).
 *
 * A mono take is centred by every playback path already, so this is not about
 * where it sounds: it is about what the file *is*, for anything downstream that
 * treats a one-channel file differently — a stem separation, an export, another
 * tool. Streamed in blocks like the finalise pass, so length costs no memory.
 * Returns false and leaves nothing behind when the source is not mono or cannot
 * be read. Worker or message thread; never the audio thread.
 */
bool duplicateMonoToStereo(const juce::File& source, const juce::File& destination,
                           juce::AudioFormatManager& formatManager);

} // namespace silverdaw::recording
