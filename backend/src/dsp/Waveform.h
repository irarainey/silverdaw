#pragma once

#include <cstdint>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>
#include <vector>

namespace silverdaw::waveform
{

// Keep in lockstep with renderer `PEAKS_PER_SECOND` so cached peaks splice cleanly.
constexpr int kDefaultPeaksPerSecond = 500;

// Flat channel-major peaks; lane 0 is always the mono summary for legacy compatibility.
struct PeaksResult
{
    std::vector<float> peaks;
    double sampleRate = 0.0;
    int peaksPerSecond = kDefaultPeaksPerSecond;
    int laneCount = 1;

    int bucketsPerLane() const
    {
        return laneCount > 0 ? static_cast<int>(peaks.size() / (2U * static_cast<std::size_t>(laneCount))) : 0;
    }
};

// Worker-thread decode; disk-bound scans must not freeze the UI.
PeaksResult computePeaks(const juce::File& file, juce::AudioFormatManager& formatManager,
                         int peaksPerSecond = kDefaultPeaksPerSecond);

} // namespace silverdaw::waveform
