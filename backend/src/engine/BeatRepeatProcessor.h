#pragma once

#include "BeatRepeatSnapshot.h"

#include <cstddef>

#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

class BeatRepeatProcessor
{
  public:
    void prepare(double sampleRate);
    void reset() noexcept;
    void process(juce::AudioBuffer<float>& buffer, int startSample, int numSamples,
                 juce::int64 timelineStart, const BeatRepeatSnapshot* snapshot) noexcept;

  private:
    const BeatRepeatRegionSamples* activeRegion{nullptr};
    const BeatRepeatSnapshot* activeSnapshot{nullptr};
    juce::AudioBuffer<float> capture;
    juce::int64 expectedTimelineSample{-1};
    std::size_t regionIndex{0};
    int captureLength{0};
    int capturedSamples{0};
    int repeatPosition{0};
};

} // namespace silverdaw
