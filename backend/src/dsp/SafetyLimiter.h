#pragma once

#include <atomic>

#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

// Final stereo-linked peak guard. It deliberately has no makeup gain or mastering controls.
class SafetyLimiter
{
public:
    static constexpr float kCeilingDb = -1.0F;

    void prepare(double sampleRate) noexcept;
    void reset() noexcept;

    void setEnabled(bool enabled, bool snap) noexcept;
    void process(juce::AudioBuffer<float>& buffer, int startSample, int numSamples) noexcept;

    static float ceilingGain() noexcept;

private:
    static float limitedMagnitude(float magnitude) noexcept;

    double sampleRate = 44100.0;
    float mix = 0.0F;
    float mixStep = 1.0F;
    std::atomic<bool> targetEnabled{false};
    std::atomic<bool> snapRequested{false};
};

} // namespace silverdaw
