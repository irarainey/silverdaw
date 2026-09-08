#include "recording/LatencyCalibration.h"

#include <algorithm>
#include <cmath>

namespace silverdaw::recording
{

std::vector<juce::int64> findBurstOnsets(const float* samples, juce::int64 numSamples,
                                         float noiseFloor, juce::int64 minSpacingSamples)
{
    std::vector<juce::int64> onsets;
    if (samples == nullptr || numSamples <= 0) return onsets;

    const auto spacing = juce::jmax<juce::int64>(1, minSpacingSamples);
    juce::int64 i = 0;
    while (i < numSamples)
    {
        if (std::abs(samples[i]) < noiseFloor)
        {
            ++i;
            continue;
        }

        // Peak of this burst, bounded by the spacing so a long tail cannot swallow the next one.
        const auto searchEnd = juce::jmin(numSamples, i + spacing);
        float peak = 0.0F;
        for (juce::int64 j = i; j < searchEnd; ++j) peak = juce::jmax(peak, std::abs(samples[j]));

        const float threshold = peak * kOnsetFraction;
        juce::int64 onset = i;
        while (onset > 0 && std::abs(samples[onset - 1]) >= threshold) --onset;
        onsets.push_back(onset);

        i = searchEnd;
    }
    return onsets;
}

std::optional<double> agreedRoundTripMs(std::vector<double> readings, double toleranceMs)
{
    readings.erase(std::remove_if(readings.begin(), readings.end(),
                                  [](double ms) {
                                      return ! std::isfinite(ms) || ms < kMinPlausibleRoundTripMs
                                             || ms > kMaxPlausibleRoundTripMs;
                                  }),
                   readings.end());
    if (readings.size() < 3) return std::nullopt;

    std::sort(readings.begin(), readings.end());
    const double median = readings[readings.size() / 2];

    const auto agreeing = std::count_if(readings.begin(), readings.end(), [&](double ms) {
        return std::abs(ms - median) <= toleranceMs;
    });
    if (static_cast<size_t>(agreeing) * 2 <= readings.size()) return std::nullopt;

    // Average only the readings that agree, so the answer keeps sub-reading precision without
    // letting an outlier that survived the median back into it.
    double sum = 0.0;
    int used = 0;
    for (double ms : readings)
    {
        if (std::abs(ms - median) > toleranceMs) continue;
        sum += ms;
        ++used;
    }
    return used > 0 ? std::optional<double>(sum / used) : std::nullopt;
}

} // namespace silverdaw::recording
