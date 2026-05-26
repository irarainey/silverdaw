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
 * `(min, max)` floats — `peaks[i*2]` is bucket i's min, `peaks[i*2+1]`
 * its max. Length is always even; `peakCount = peaks.size() / 2`.
 * Returned by value because the same buffer is then handed to both the
 * disk cache and the WebSocket binary frame; copying `std::vector<float>`
 * is one alloc + memcpy, which is dwarfed by the disk I/O of the read.
 */
struct PeaksResult
{
    std::vector<float> peaks;
    double sampleRate = 0.0;
    int peaksPerSecond = kDefaultPeaksPerSecond;
};

/**
 * Compute mono-mixed min/max peaks for `file` at `peaksPerSecond`
 * resolution. Returns an empty result on any decode failure (logged via
 * `silverdaw::log::warn`).
 *
 * Designed to be called from a worker thread (e.g. `juce::ThreadPool`) so
 * a long disk-bound scan never freezes the UI. A fresh `AudioFormatReader`
 * is opened internally; the caller does not need to own the file's audio
 * source.
 */
PeaksResult computePeaks(const juce::File& file, juce::AudioFormatManager& formatManager,
                         int peaksPerSecond = kDefaultPeaksPerSecond);

} // namespace silverdaw::waveform
