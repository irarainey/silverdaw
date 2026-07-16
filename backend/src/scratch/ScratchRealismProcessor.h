#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <array>
#include <cstdint>

namespace silverdaw::scratch
{

enum class ScratchRealismLevel : std::uint8_t
{
    off,
    medium,
    high
};

// Audio-thread-owned finishing pass for held-platter realism. It only changes
// the monitored signal; transport and recorded platter trajectory stay untouched.
class ScratchRealismProcessor
{
  public:
    void prepare(double newSampleRate) noexcept;
    void reset() noexcept;

    void process(juce::AudioBuffer<float>& buffer, int startSample, int numSamples,
                 double semanticRate, float deckGain, bool platterHeld,
                 ScratchRealismLevel level) noexcept;

  private:
    static constexpr int kMaxChannels = 8;

    double sampleRate = 48000.0;
    std::array<float, kMaxChannels> lowPassState{};
    float grooveState = 0.0F;
    std::uint32_t noiseState = 0x9e3779b9U;
};

} // namespace silverdaw::scratch
