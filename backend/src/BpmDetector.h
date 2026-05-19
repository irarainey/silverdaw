#pragma once

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>
#include <vector>

namespace silverdaw
{

/** Output of one offline analysis pass. */
struct BpmAnalysis
{
    /** Estimated tempo in BPM. 0 when no plausible tempo was found. */
    double bpm = 0.0;
    /** Beat positions in seconds from the start of the source file.
     *  Empty when `bpm == 0`. Each entry is the time of one detected
     *  beat — at 120 BPM you'd get ~120 entries for a one-minute clip. */
    std::vector<double> beatTimesSec;
    /** True when BTrack's running tempo estimate fluctuated by more
     *  than ~2 % over the analysis window (after a short settling
     *  period). Drives the "variable tempo" badge on the library tile;
     *  the project-BPM seed logic suppresses itself for these files
     *  so a wobbly groove doesn't pick a misleading project tempo. */
    bool variableTempo = false;
};

/**
 * Offline BPM + beat-position detection using the BTrack algorithm
 * (Stark / Davies / Plumbley, Queen Mary University of London).
 *
 * Workflow:
 *   1. Open the file via the supplied `juce::AudioFormatManager`.
 *   2. Decode the whole capped range to a single mono float buffer.
 *   3. Resample to BTrack's expected 44.1 kHz with libsamplerate
 *      (`src_simple`, one-shot — much simpler than the chunked
 *      interpolator we tried first and avoids the gotchas with
 *      JUCE's interpolator returning "input samples consumed").
 *   4. Feed the mono signal into BTrack frame-by-frame at the
 *      default hop=512 / frame=1024 settings.
 *   5. Record a beat-time entry for every frame where
 *      `beatDueInCurrentFrame()` fires, plus the running tempo
 *      estimate sampled at each beat.
 *   6. Final tempo = `getCurrentTempoEstimate()`, clamped into
 *      `[kMinPlausibleBpm, kMaxPlausibleBpm]`.
 *
 * Designed to run on a background worker thread (the existing peaks
 * pool) — no JUCE message-thread or audio-thread interaction.
 */
class BpmDetector
{
  public:
    /** Sample rate BTrack was tuned for. */
    static constexpr double kAnalysisSampleRate = 44100.0;
    /** BTrack hop size. */
    static constexpr int kHopSize = 512;
    /** BTrack frame size — twice the hop. */
    static constexpr int kFrameSize = 1024;
    /** Plausibility window for a final estimate. Anything outside is
     *  treated as "didn't detect anything useful" and reported as 0. */
    static constexpr double kMinPlausibleBpm = 40.0;
    static constexpr double kMaxPlausibleBpm = 240.0;
    /** Cap the amount of audio fed to BTrack — long files don't yield
     *  better estimates and the user shouldn't wait for the whole
     *  thing. Two minutes is enough to capture a steady tempo on
     *  music-style material. */
    static constexpr double kMaxAnalysisSeconds = 120.0;

    /**
     * Run the offline analysis on `audioFile`. Returns a populated
     * `BpmAnalysis`; an empty result (`bpm == 0`, empty beats) means
     * the file was unreadable, the decode failed, or no plausible
     * tempo was detected. Blocking — call from a worker thread, not
     * the audio or message thread. `formatManager` must outlive the
     * call.
     */
    BpmAnalysis analyse(const juce::File& audioFile, juce::AudioFormatManager& formatManager);
};

} // namespace silverdaw
