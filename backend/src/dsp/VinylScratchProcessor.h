#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

// prepare/reset run while stopped. Target setters and process are audio-thread
// owned; cross-thread controls must reach them through a lock-free snapshot.
class VinylScratchProcessor
{
  public:
    struct Settings
    {
        double maxAbsRate = 8.0;
        double rateSmoothingSeconds = 0.004;
        double gainSmoothingSeconds = 0.002;
        double boundaryFadeSeconds = 0.003;
    };

    void prepare(double newSampleRate, Settings newSettings = {}) noexcept;
    void reset(double sourcePositionSamples, double initialRate = 0.0,
               float initialGain = 1.0F) noexcept;

    void setTargetRate(double rate) noexcept;
    void setTargetGain(float gain) noexcept;

    void process(const juce::AudioBuffer<float>& source,
                 juce::AudioBuffer<float>& destination, int destinationStartSample,
                 int numSamples) noexcept;

    double getSourcePosition() const noexcept { return sourcePosition; }
    double getCurrentRate() const noexcept { return currentRate; }
    double getTargetRate() const noexcept { return targetRate; }
    float getCurrentGain() const noexcept { return currentGain; }
    bool wasClampedAtEnd() const noexcept { return clampedAtEnd; }
    bool wasClampedAtStart() const noexcept { return clampedAtStart; }

    static constexpr double kSecondsPerTurn = 1.8;
    static double turnsForSeconds(double seconds) noexcept;
    static double secondsForTurns(double turns) noexcept;

  private:
    static constexpr int kSincRadius = 32;
    static constexpr double kSilenceRate = 0.01;
    static constexpr double kFullGainRate = 0.08;

    float interpolate(const float* source, int sourceSamples, double position,
                      double rate) const noexcept;
    float boundaryGain(int sourceSamples) const noexcept;
    static float smoothStep(double value) noexcept;

    Settings settings;
    double sampleRate = 48000.0;
    double sourcePosition = 0.0;
    double currentRate = 0.0;
    double targetRate = 0.0;
    double rateSmoothing = 1.0;
    float currentGain = 1.0F;
    float targetGain = 1.0F;
    double gainSmoothing = 1.0;
    double boundaryFadeSamples = 0.0;
    bool clampedAtEnd = false;
    bool clampedAtStart = false;
};

} // namespace silverdaw
