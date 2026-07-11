#pragma once

#include <chrono>

#include <juce_core/juce_core.h>

namespace silverdaw
{

class StemProgressCoalescer
{
  public:
    using Clock = std::chrono::steady_clock;

    bool shouldEmit(const char* stage, double percent, const char* detail);
    bool shouldEmitAt(const char* stage, double percent, const char* detail,
                      Clock::time_point now);

  private:
    static constexpr auto kMinimumInterval = std::chrono::milliseconds(100);

    Clock::time_point lastEmission{};
    juce::String lastStage;
    juce::String lastDetail;
    bool hasEmitted = false;
};

} // namespace silverdaw
