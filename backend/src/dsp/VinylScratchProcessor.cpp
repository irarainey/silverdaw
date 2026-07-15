#include "VinylScratchProcessor.h"

#include <algorithm>
#include <cmath>

namespace silverdaw
{
namespace
{
double smoothingCoefficient(double seconds, double sampleRate) noexcept
{
    if (seconds <= 0.0 || sampleRate <= 0.0) return 1.0;
    return 1.0 - std::exp(-1.0 / (seconds * sampleRate));
}

double sinc(double value) noexcept
{
    if (std::abs(value) < 1.0e-12) return 1.0;
    const double x = juce::MathConstants<double>::pi * value;
    return std::sin(x) / x;
}
} // namespace

void VinylScratchProcessor::prepare(double newSampleRate, Settings newSettings) noexcept
{
    sampleRate = std::max(1.0, newSampleRate);
    settings.maxAbsRate = juce::jlimit(1.0, 32.0, newSettings.maxAbsRate);
    settings.rateSmoothingSeconds =
        juce::jlimit(0.0, 0.25, newSettings.rateSmoothingSeconds);
    settings.manualRateSmoothingSeconds =
        juce::jlimit(0.0, 0.25, newSettings.manualRateSmoothingSeconds);
    settings.gainSmoothingSeconds =
        juce::jlimit(0.0, 0.25, newSettings.gainSmoothingSeconds);
    settings.boundaryFadeSeconds =
        juce::jlimit(0.0, 0.1, newSettings.boundaryFadeSeconds);
    rateSmoothingFast = smoothingCoefficient(settings.rateSmoothingSeconds, sampleRate);
    rateSmoothingHeavy = smoothingCoefficient(settings.manualRateSmoothingSeconds, sampleRate);
    rateSmoothing = rateSmoothingFast;
    gainSmoothing = smoothingCoefficient(settings.gainSmoothingSeconds, sampleRate);
    boundaryFadeSamples = settings.boundaryFadeSeconds * sampleRate;
    setTargetRate(targetRate);
}

void VinylScratchProcessor::reset(double sourcePositionSamples, double initialRate,
                                  float initialGain) noexcept
{
    sourcePosition = sourcePositionSamples;
    currentRate = juce::jlimit(-settings.maxAbsRate, settings.maxAbsRate, initialRate);
    targetRate = currentRate;
    currentGain = juce::jlimit(0.0F, 1.0F, initialGain);
    targetGain = currentGain;
    clampedAtEnd = false;
    clampedAtStart = false;
}

void VinylScratchProcessor::setTargetRate(double rate) noexcept
{
    targetRate = juce::jlimit(-settings.maxAbsRate, settings.maxAbsRate, rate);
}

void VinylScratchProcessor::setTargetGain(float gain) noexcept
{
    targetGain = juce::jlimit(0.0F, 1.0F, gain);
}

void VinylScratchProcessor::setManualWeightEngaged(bool engaged) noexcept
{
    rateSmoothing = engaged ? rateSmoothingHeavy : rateSmoothingFast;
}

void VinylScratchProcessor::process(const juce::AudioBuffer<float>& source,
                                    juce::AudioBuffer<float>& destination,
                                    int destinationStartSample, int numSamples) noexcept
{
    const int destinationSamples = destination.getNumSamples();
    if (destinationStartSample < 0 || destinationStartSample >= destinationSamples
        || numSamples <= 0)
        return;
    const int samplesToWrite =
        std::min(destinationSamples - destinationStartSample, numSamples);
    if (samplesToWrite <= 0) return;

    const int sourceChannels = source.getNumChannels();
    const int sourceSamples = source.getNumSamples();
    const int destinationChannels = destination.getNumChannels();
    const double lastSourceSample = static_cast<double>(sourceSamples - 1);
    if (sourceChannels <= 0 || sourceSamples <= 0 || destinationChannels <= 0)
    {
        destination.clear(destinationStartSample, samplesToWrite);
        return;
    }

    for (int i = 0; i < samplesToWrite; ++i)
    {
        currentRate += (targetRate - currentRate) * rateSmoothing;
        currentGain += static_cast<float>((targetGain - currentGain) * gainSmoothing);

        const double rateMagnitude = std::abs(currentRate);
        const float rateGain = smoothStep(
            (rateMagnitude - kSilenceRate) / (kFullGainRate - kSilenceRate));
        const float outputGain = currentGain * rateGain * boundaryGain(sourceSamples);

        for (int channel = 0; channel < destinationChannels; ++channel)
        {
            const int sourceChannel = std::min(channel, sourceChannels - 1);
            const float sample =
                interpolate(source.getReadPointer(sourceChannel), sourceSamples,
                            sourcePosition, currentRate);
            destination.setSample(channel, destinationStartSample + i,
                                  sample * outputGain);
        }
        sourcePosition = juce::jlimit(0.0, lastSourceSample, sourcePosition + currentRate);
        if (sourcePosition >= lastSourceSample)
            clampedAtEnd = true;
        else if (sourcePosition <= 0.0)
            clampedAtStart = true;
    }
}

double VinylScratchProcessor::turnsForSeconds(double seconds) noexcept
{
    return seconds / kSecondsPerTurn;
}

double VinylScratchProcessor::secondsForTurns(double turns) noexcept
{
    return turns * kSecondsPerTurn;
}

float VinylScratchProcessor::interpolate(const float* source, int sourceSamples,
                                         double position, double rate) const noexcept
{
    if (position < 0.0 || position > static_cast<double>(sourceSamples - 1)) return 0.0F;

    const double rateMagnitude = std::abs(rate);
    double cutoff = 1.0;
    if (rateMagnitude > 1.0)
    {
        const double transition = juce::jlimit(0.0, 1.0, rateMagnitude - 1.0);
        const double guard = 1.0 - 0.06 * transition * transition * (3.0 - 2.0 * transition);
        cutoff = guard / rateMagnitude;
    }
    const int centre = static_cast<int>(std::floor(position));
    double weighted = 0.0;
    double weightSum = 0.0;

    for (int tap = -kSincRadius + 1; tap <= kSincRadius; ++tap)
    {
        const int index = centre + tap;
        const double distance = position - static_cast<double>(index);
        if (std::abs(distance) >= static_cast<double>(kSincRadius)) continue;

        const double window =
            0.5 + 0.5 * std::cos(juce::MathConstants<double>::pi * distance
                                 / static_cast<double>(kSincRadius));
        const double weight = cutoff * sinc(cutoff * distance) * window;
        weightSum += weight;
        if (index >= 0 && index < sourceSamples)
            weighted += static_cast<double>(source[index]) * weight;
    }

    if (std::abs(weightSum) < 1.0e-12) return 0.0F;
    return static_cast<float>(weighted / weightSum);
}

float VinylScratchProcessor::boundaryGain(int sourceSamples) const noexcept
{
    if (boundaryFadeSamples <= 0.0) return 1.0F;
    const double lastSample = static_cast<double>(sourceSamples - 1);
    const double edgeDistance = std::min(sourcePosition, lastSample - sourcePosition);
    return smoothStep(edgeDistance / boundaryFadeSamples);
}

float VinylScratchProcessor::smoothStep(double value) noexcept
{
    const double x = juce::jlimit(0.0, 1.0, value);
    return static_cast<float>(x * x * (3.0 - 2.0 * x));
}

} // namespace silverdaw
