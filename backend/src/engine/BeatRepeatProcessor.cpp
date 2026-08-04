#include "BeatRepeatProcessor.h"

#include <algorithm>

namespace silverdaw
{

void BeatRepeatProcessor::prepare(double sampleRate)
{
    const int capacity = juce::jmax(1, static_cast<int>(sampleRate * 4.0));
    capture.setSize(2, capacity, false, true, false);
    reset();
}

void BeatRepeatProcessor::reset() noexcept
{
    activeRegion = nullptr;
    activeSnapshot = nullptr;
    expectedTimelineSample = -1;
    regionIndex = 0;
    captureLength = 0;
    capturedSamples = 0;
    repeatPosition = 0;
    boundaryFadeSamples = 0;
}

void BeatRepeatProcessor::process(juce::AudioBuffer<float>& buffer, int startSample, int numSamples,
                                  juce::int64 timelineStart,
                                  const BeatRepeatSnapshot* snapshot) noexcept
{
    if (snapshot != activeSnapshot || timelineStart != expectedTimelineSample)
    {
        activeRegion = nullptr;
        activeSnapshot = snapshot;
        regionIndex = snapshot == nullptr
                          ? 0
                          : static_cast<std::size_t>(std::lower_bound(
                                snapshot->regions.begin(), snapshot->regions.end(), timelineStart,
                                [](const BeatRepeatRegionSamples& region, juce::int64 sample) {
                                    return region.endSample <= sample;
                                })
                                - snapshot->regions.begin());
        captureLength = 0;
        capturedSamples = 0;
        repeatPosition = 0;
        boundaryFadeSamples = 0;
    }

    const int channels = buffer.getNumChannels();
    for (int i = 0; i < numSamples; ++i)
    {
        const auto timelineSample = timelineStart + i;
        const BeatRepeatRegionSamples* region = nullptr;
        if (snapshot != nullptr && regionIndex < snapshot->regions.size())
        {
            const auto* candidate = &snapshot->regions[regionIndex];
            if (timelineSample >= candidate->endSample && ++regionIndex < snapshot->regions.size())
                candidate = &snapshot->regions[regionIndex];
            if (timelineSample >= candidate->startSample && timelineSample < candidate->endSample)
                region = candidate;
        }

        if (region != activeRegion)
        {
            activeRegion = region;
            capturedSamples = 0;
            repeatPosition = 0;
            captureLength = region != nullptr
                                ? juce::jlimit(1, capture.getNumSamples(), region->divisionSamples)
                                : 0;
            boundaryFadeSamples = juce::jmin(kMaximumBoundaryFadeSamples, captureLength / 2);
        }

        if (region == nullptr)
            continue;

        if (capturedSamples < captureLength)
        {
            const int capturePosition = capturedSamples;
            for (int ch = 0; ch < juce::jmin(2, channels); ++ch)
                capture.setSample(ch, capturePosition, buffer.getSample(ch, startSample + i));
            ++capturedSamples;

            if (boundaryFadeSamples > 0 && capturePosition >= captureLength - boundaryFadeSamples)
            {
                const int fadePosition = capturePosition - (captureLength - boundaryFadeSamples);
                const float mix = static_cast<float>(fadePosition + 1)
                                  / static_cast<float>(boundaryFadeSamples);
                for (int ch = 0; ch < juce::jmin(2, channels); ++ch)
                {
                    const float tail = buffer.getSample(ch, startSample + i);
                    const float head = capture.getSample(ch, fadePosition);
                    buffer.setSample(ch, startSample + i, tail + (head - tail) * mix);
                }
            }

            if (capturedSamples == captureLength)
                repeatPosition = boundaryFadeSamples;
        }
        else
        {
            for (int ch = 0; ch < juce::jmin(2, channels); ++ch)
            {
                const float tail = capture.getSample(ch, repeatPosition);
                if (boundaryFadeSamples > 0 && repeatPosition >= captureLength - boundaryFadeSamples)
                {
                    const int fadePosition = repeatPosition - (captureLength - boundaryFadeSamples);
                    const float mix = static_cast<float>(fadePosition + 1)
                                      / static_cast<float>(boundaryFadeSamples);
                    const float head = capture.getSample(ch, fadePosition);
                    buffer.setSample(ch, startSample + i, tail + (head - tail) * mix);
                }
                else
                {
                    buffer.setSample(ch, startSample + i, tail);
                }
            }
            ++repeatPosition;
            if (repeatPosition >= captureLength)
                repeatPosition = boundaryFadeSamples;
        }
    }
    expectedTimelineSample = timelineStart + numSamples;
}

} // namespace silverdaw
