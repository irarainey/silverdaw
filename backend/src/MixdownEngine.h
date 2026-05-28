#pragma once

#include <atomic>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <juce_core/juce_core.h>

namespace silverdaw
{

class BridgeServer;
class ProjectState;

/**
 * Immutable snapshot of every parameter the mixdown engine needs to
 * render a project offline. Taken on the JUCE message thread before
 * the worker is dispatched (rubber-duck blocking concern A — never
 * walk the live ValueTree from a worker thread). The worker reads
 * only from the snapshot for the duration of the render; concurrent
 * user edits to the project don't change what's exported.
 */
struct MixdownSnapshot
{
    struct ClipSnapshot
    {
        juce::String id;
        /** Library item the clip references. Carried so Main.cpp can
         *  re-resolve the engine playback path through the live
         *  `resolveEnginePlaybackPath` helper (which also consults the
         *  runtime decodedCache) — without that, mixdown can pick the
         *  raw MP3/WMA for some clips while live plays the decoded WAV
         *  cache, causing selective warp/volume divergence. */
        juce::String libraryItemId;
        /** Absolute on-disk path of the source audio. Set in two
         *  passes: the snapshot fills it from
         *  `getLibraryItemPlaybackPath` (decoded WAV if present); the
         *  dispatcher overrides it with the same path the live engine
         *  is using so both pipelines read identical bytes. */
        juce::String filePath;
        /** Where the clip starts on the project timeline (ms). */
        double offsetMs{0.0};
        /** Window into the source file (source time, ms). */
        double inMs{0.0};
        /** Length of the source window before warp (source time, ms). */
        double durationMs{0.0};
        /** Effective duration on the timeline after warp / pitch (ms). */
        double effectiveDurationMs{0.0};
        bool warpEnabled{false};
        juce::String warpMode; // "rhythmic" / "tonal" / "complex"
        double tempoRatio{1.0};
        double semitones{0.0};
        double cents{0.0};
        /** Cached on the snapshot so the worker doesn't have to open
         *  the file just to find out its native rate. Populated from
         *  the library item's `sampleRate` field. */
        int sourceSampleRate{0};
        int sourceChannelCount{0};
    };

    struct TrackSnapshot
    {
        juce::String id;
        float gain{1.0F};
        std::vector<ClipSnapshot> clips;
    };

    /** The rate every track buffer is summed at before the optional
     *  one-final-resample pass at the end. Mirrors the live engine's
     *  effective project rate so the offline output sounds like the
     *  live transport sounds. */
    int projectSampleRate{44100};
    std::vector<TrackSnapshot> tracks;
};

/**
 * Optional MP3 ID3v2 tag fields. All optional — empty strings are
 * dropped. Bridge protocol mirrors this shape. Not yet wired up to a
 * real encoder; the WAV path ignores this entirely.
 */
struct Mp3Metadata
{
    juce::String title;
    juce::String artist;
    juce::String album;
    juce::String year;
    juce::String genre;
    juce::String comment;
};

/**
 * User-specified render options gathered from the dialog. Validated
 * by the dispatch handler before being passed in (so the engine can
 * assume sane values).
 */
struct MixdownOptions
{
    enum class Format { Wav, Mp3, Flac };

    juce::File outputFile;
    int outputSampleRate{44100};
    Format format{Format::Wav};
    /** Output sample bit-depth.
     *  - WAV: 16 / 24 (PCM) or 32 (IEEE float).
     *  - FLAC: 16 / 24.
     *  - MP3: ignored.
     *  Validated by the dispatch handler against the chosen format. */
    int bitDepth{16};
    /** TPDF dither applied immediately before integer quantisation.
     *  Only active when the target bit-depth is 16 (24-bit's noise
     *  floor is ~144 dB so dither is rarely audible; 32-float has
     *  no quantisation step). Default ON for 16-bit. */
    bool dither{true};
    /** Extra silence-tail in seconds appended AFTER the timeline
     *  length. Independent of, and additive on top of, per-clip
     *  processor tails (reverb/delay decay). Range [0, 60]; clamped
     *  by the dispatch handler. The user-visible exported file
     *  duration equals `lengthMs/1000 + tailSeconds + processor
     *  tail` (the processor tail today is 0 — reverb/delay land
     *  next). */
    double tailSeconds{0.0};
    /** MP3 only; ignored for WAV/FLAC. */
    int bitrateKbps{192};
    /** Total render duration in milliseconds. Resolved from
     *  `lengthMode` ('trim-to-last-clip' or 'fixed-duration') by the
     *  dispatch handler before the engine sees it. */
    double lengthMs{0.0};
    /** Only consulted when `format == Mp3`. */
    Mp3Metadata mp3Metadata;
};

/**
 * Failure taxonomy mirroring the bridge `MIXDOWN_FAILED.code` field.
 * Lets the UI distinguish intentional cancel from a real error.
 */
enum class MixdownFailureCode
{
    Cancelled,
    Io,
    Decode,
    Encode,
    Invalid
};

const char* mixdownFailureCodeToString(MixdownFailureCode code) noexcept;

/**
 * Build a snapshot of the project's current track / clip state on
 * the calling thread (JUCE message thread). MUST run on the message
 * thread so the ValueTree read is race-free.
 */
MixdownSnapshot snapshotProjectForMixdown(const ProjectState& project);

/**
 * Compute the timeline position (ms) of the latest-ending clip in
 * the snapshot. Used by the dispatch handler to resolve
 * `lengthMode = 'trim-to-last-clip'`. Returns 0 for an empty
 * snapshot.
 */
double computeLastClipEndMs(const MixdownSnapshot& snapshot);

/**
 * Dispatch an offline mixdown render onto `pool`. Returns
 * immediately; progress is streamed via `MIXDOWN_PROGRESS` envelopes
 * and the terminal envelope is `MIXDOWN_DONE` or `MIXDOWN_FAILED`.
 *
 * `cancelFlag` is checked at every block boundary and before every
 * encoder write. `busyFlag` is set true at start and cleared on
 * completion — the bridge dispatch uses it to reject `TRANSPORT_PLAY`
 * while a render is active (so transport can't audibly start mid-
 * render — see rubber-duck finding M).
 */
void renderMixdownAsync(MixdownSnapshot snapshot,
                        MixdownOptions options,
                        juce::ThreadPool& pool,
                        BridgeServer& bridge,
                        std::atomic<bool>& cancelFlag,
                        std::atomic<bool>& busyFlag);

} // namespace silverdaw
