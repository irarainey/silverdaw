#include "BeatRepeatSnapshot.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace silverdaw
{
namespace
{
double beatsPerDivision(const juce::String& division) noexcept
{
    if (division == "1/4") return 1.0;
    if (division == "1/16") return 0.25;
    return 0.5;
}
} // namespace

std::unique_ptr<BeatRepeatSnapshot> makeBeatRepeatSnapshot(
    const std::vector<BeatRepeatRegion>& regions, double sampleRate, double bpm)
{
    const double rate = std::isfinite(sampleRate) && sampleRate > 0.0 ? sampleRate : 44100.0;
    const double safeBpm = std::isfinite(bpm) && bpm > 0.0 ? bpm : 120.0;
    const double samplesPerBeat = rate * 60.0 / safeBpm;
    const double maxSamples = static_cast<double>(std::numeric_limits<juce::int64>::max());
    auto snapshot = std::make_unique<BeatRepeatSnapshot>();
    snapshot->regions.reserve(regions.size());
    for (const auto& region : regions)
    {
        if (region.startBeat > maxSamples / samplesPerBeat
            || region.lengthBeats > maxSamples / samplesPerBeat)
            continue;
        const auto start = static_cast<juce::int64>(std::llround(region.startBeat * samplesPerBeat));
        const auto length = static_cast<juce::int64>(std::llround(region.lengthBeats * samplesPerBeat));
        const auto division = static_cast<int>(std::llround(beatsPerDivision(region.division)
                                                            * samplesPerBeat));
        if (start >= 0 && length > 0 && division > 0)
            snapshot->regions.push_back({start, start + length, division});
    }
    std::sort(snapshot->regions.begin(), snapshot->regions.end(),
              [](const BeatRepeatRegionSamples& a, const BeatRepeatRegionSamples& b) {
                  return a.startSample < b.startSample;
              });
    return snapshot;
}

} // namespace silverdaw
