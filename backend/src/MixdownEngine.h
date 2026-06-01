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
        /** Per-clip volume-envelope breakpoints (persisted form: objects
         *  carrying `timeMs` + `gain`). Empty = no shape. Applied inside
         *  the offline `OffsetSource` exactly as the live engine does so
         *  the export carries the same volume shape the user hears. */
        juce::Array<juce::var> envelopePoints;
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
        // Phase 5 — per-track Tone EQ, captured on the message thread so
        // the offline render applies the same tilt the live engine does.
        float toneBassDb{0.0F};
        float toneMidDb{0.0F};
        float toneTrebleDb{0.0F};
        bool toneLowCut{false};
        bool toneHighCut{false};
        // Phase 5 — per-track wet send amounts into the shared Room / Echo
        // buses, captured so the offline render feeds the same shared FX
        // the live engine does (§7.9.6 parity).
        float reverbSend{0.0F};
        float delaySend{0.0F};
        std::vector<ClipSnapshot> clips;
    };

    /** The rate every track buffer is summed at before the optional
     *  one-final-resample pass at the end. Mirrors the live engine's
     *  effective project rate so the offline output sounds like the
     *  live transport sounds. */
    int projectSampleRate{44100};
    /** Master output gain applied to the summed mix bus just before
     *  loudness analysis / peak measurement / final resample / dither.
     *  Mirrors the live engine's `setMasterGain` so the exported file
     *  matches what the user heard. Linear, clamped [0, 1]. */
    float masterGain{1.0F};
    // Phase 5 — project-shared Room (reverb) + Echo (delay) parameters.
    // The offline render runs the identical `SharedFx` the live engine
    // does (§7.9.6 parity). The Echo delay time is resolved from the
    // note value + BPM via `silverdaw::delayNoteToMs` so live and export
    // agree exactly.
    float reverbSize{0.0F};
    float reverbDecay{0.0F};
    float reverbTone{0.0F};
    float reverbMix{0.0F};
    juce::String delayNoteValue{"1/8"};
    float delayFeedback{0.0F};
    float delayTone{0.0F};
    float delayMix{0.0F};
    double bpm{120.0};
    std::vector<TrackSnapshot> tracks;
};

/**
 * Optional metadata tag fields shared across formats. All entries are
 * optional — empty strings are dropped before being written.
 *
 * Per-format target:
 *   - WAV  → RIFF INFO chunk (INAM/IART/IPRD/ICRD/IGNR/ICMT).
 *   - AIFF → AIFF text chunks (NAME/AUTH/(c) /ANNO), inserted by a
 *            post-process pass because JUCE 8's AiffAudioFormat writer
 *            ignores metadata.
 *   - MP3  → ID3v2 frames written by LAME (id3title/id3artist/...).
 *   - FLAC → VORBIS_COMMENT block (TITLE/ARTIST/ALBUM/DATE/GENRE/COMMENT).
 *
 * JUCE 8's FLAC and AIFF writers do not expose tag-writing hooks, so
 * both paths post-process the encoded file (see `writeFlacVorbisComment()`
 * and `writeAiffTextChunks()` in MixdownEngine.cpp).
 *
 * Bridge protocol mirrors this shape under the `metadata` key.
 */
struct ExportMetadata
{
    juce::String title;
    juce::String artist;
    juce::String album;
    juce::String year;
    juce::String genre;
    juce::String comment;

    bool isEmpty() const noexcept
    {
        return title.isEmpty() && artist.isEmpty() && album.isEmpty()
            && year.isEmpty()  && genre.isEmpty()  && comment.isEmpty();
    }
};

/**
 * User-specified render options gathered from the dialog. Validated
 * by the dispatch handler before being passed in (so the engine can
 * assume sane values).
 */
struct MixdownOptions
{
    enum class Format { Wav, Mp3, Flac, Aiff };

    juce::File outputFile;
    int outputSampleRate{44100};
    Format format{Format::Wav};
    /** Output sample bit-depth.
     *  - WAV:  16 / 24 (PCM) or 32 (IEEE float).
     *  - FLAC: 16 / 24.
     *  - AIFF: 16 / 24 (PCM only — AIFF has no float container in JUCE).
     *  - MP3:  ignored.
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
    /** ITU-R BS.1770-4 loudness measurement / normalization.
     *  - Off:         no analysis, no gain, current behaviour.
     *  - AnalyzeOnly: single-pass render measures integrated LUFS +
     *                 true-peak and reports them; output is bit-
     *                 identical to Off.
     *  - Normalize:   two-pass render. Pass 1 measures and writes a
     *                 32-float intermediate; pass 2 applies the
     *                 computed linear gain, with a true-peak ceiling
     *                 back-off, then dithers + writes the chosen
     *                 final format. */
    enum class LoudnessMode { Off, AnalyzeOnly, Normalize };
    LoudnessMode loudnessMode{LoudnessMode::Off};
    /** Target integrated loudness in LUFS. Only consulted when
     *  loudnessMode == Normalize. Validated to [-30, -6]. */
    double targetLufs{-14.0};
    /** True-peak ceiling in dBTP. Final gain is clamped so the
     *  post-gain true peak does not exceed (ceilingDbtp - 0.2 dB).
     *  Validated to [-9, 0]. Only consulted for Normalize. */
    double ceilingDbtp{-1.0};
    /** MP3 only; ignored for WAV/FLAC/AIFF. */
    int bitrateKbps{192};
    /** Total render duration in milliseconds. Resolved from
     *  `lengthMode` ('trim-to-last-clip' or 'fixed-duration') by the
     *  dispatch handler before the engine sees it. */
    double lengthMs{0.0};
    /** Optional file-level tags. Written per-format (RIFF INFO for WAV,
     *  AIFF text chunks for AIFF, ID3 for MP3, VORBIS_COMMENT for FLAC).
     *  Empty struct → nothing written. */
    ExportMetadata metadata;
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
