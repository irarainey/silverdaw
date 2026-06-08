#pragma once

#include <cstdint>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>
#include <vector>

namespace silverdaw::waveform
{

/**
 * Default peak resolution for waveform rendering. Kept in lockstep with
 * `PEAKS_PER_SECOND` in `frontend/src/renderer/src/lib/audio.ts` so the
 * renderer can splice peaks from any source (backend or renderer-side
 * decode) at the same density.
 */
constexpr int kDefaultPeaksPerSecond = 500;

/**
 * Result of a peaks computation. `peaks` is a flat array of alternating
 * `(min, max)` floats laid out **channel-major** across `laneCount`
 * lanes: lane L occupies `peaks[L*bucketsPerLane*2 .. (L+1)*bucketsPerLane*2)`.
 *
 * Lane 0 is ALWAYS the mono summary (the per-sample channel average,
 * bucketed to min/max — identical to the legacy single-lane format).
 * Stereo (2-channel) files additionally store lane 1 = left, lane 2 =
 * right, so `laneCount == 3`. Mono files and files with more than two
 * channels store only the summary, so `laneCount == 1`.
 *
 * `bucketsPerLane = peaks.size() / (2 * laneCount)`; this is the value
 * surfaced to the renderer as `peakCount`. Returned by value because the
 * same buffer is then handed to both the disk cache and the bridge
 * envelope; copying `std::vector<float>` is one alloc + memcpy, which is
 * dwarfed by the disk I/O of the read.
 */
struct PeaksResult
{
    std::vector<float> peaks;
    double sampleRate = 0.0;
    int peaksPerSecond = kDefaultPeaksPerSecond;
    int laneCount = 1;

    /** Number of (min, max) buckets in each lane. Zero when `peaks` is empty. */
    int bucketsPerLane() const
    {
        return laneCount > 0 ? static_cast<int>(peaks.size() / (2U * static_cast<std::size_t>(laneCount))) : 0;
    }
};

/**
 * Compute min/max peaks for `file` at `peaksPerSecond` resolution. Lane 0
 * is the mono-mixed summary; stereo files also get per-channel L/R lanes
 * (see `PeaksResult`). Returns an empty result on any decode failure
 * (logged via `silverdaw::log::warn`).
 *
 * Designed to be called from a worker thread (e.g. `juce::ThreadPool`) so
 * a long disk-bound scan never freezes the UI. A fresh `AudioFormatReader`
 * is opened internally; the caller does not need to own the file's audio
 * source.
 */
PeaksResult computePeaks(const juce::File& file, juce::AudioFormatManager& formatManager,
                         int peaksPerSecond = kDefaultPeaksPerSecond);

} // namespace silverdaw::waveform
