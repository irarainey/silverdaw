#pragma once

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>

namespace silverdaw
{

/**
 * Offline BPM detection using the BTrack algorithm
 * (Stark / Davies / Plumbley, Queen Mary University of London).
 *
 * Workflow:
 *   1. Open the file via the supplied `juce::AudioFormatManager`.
 *   2. Decode in blocks, downmix to mono float, and resample to
 *      BTrack's expected 44.1 kHz with JUCE's CatmullRom interpolator.
 *   3. Feed the mono signal into BTrack frame-by-frame at the
 *      default hop=512 / frame=1024 settings.
 *   4. Return the algorithm's final tempo estimate, clamped into
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
     * Estimate the BPM of `audioFile`. Returns 0.0 on any failure
     * (file unreadable, decode error, no plausible tempo detected).
     * Blocking — call from a worker thread, not the audio or message
     * thread. `formatManager` must outlive the call.
     */
    double estimateBpm(const juce::File& audioFile, juce::AudioFormatManager& formatManager);
};

} // namespace silverdaw
