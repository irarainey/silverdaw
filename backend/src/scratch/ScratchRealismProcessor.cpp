#include "ScratchRealismProcessor.h"

#include <cmath>

namespace silverdaw::scratch
{

void ScratchRealismProcessor::prepare(double newSampleRate) noexcept
{
    sampleRate = juce::jmax(1.0, newSampleRate);
    reset();
}

void ScratchRealismProcessor::reset() noexcept
{
    lowPassState.fill(0.0F);
    grooveState = 0.0F;
    noiseState = 0x9e3779b9U;
}

void ScratchRealismProcessor::process(juce::AudioBuffer<float>& buffer, int startSample,
                                      int numSamples, double semanticRate, float deckGain,
                                      bool platterHeld, ScratchRealismLevel level) noexcept
{
    if (!platterHeld || level == ScratchRealismLevel::off || numSamples <= 0
        || startSample < 0 || startSample >= buffer.getNumSamples())
        return;

    const int samples = juce::jmin(numSamples, buffer.getNumSamples() - startSample);
    const int channels = juce::jmin(kMaxChannels, buffer.getNumChannels());
    if (samples <= 0 || channels <= 0)
        return;

    const double strength = level == ScratchRealismLevel::high ? 1.15 : 0.82;
    const double rateMagnitude = juce::jlimit(0.0, 8.0, std::abs(semanticRate));
    const double speedFactor = rateMagnitude / 8.0;
    const double reverseFactor = semanticRate < -0.01 ? 1.0 : 0.0;
    const double baseCutoffHz = level == ScratchRealismLevel::high ? 7200.0 : 11200.0;
    const double cutoffHz = juce::jmax(
        2600.0,
        baseCutoffHz * (1.0 - strength * (0.52 * speedFactor + 0.19 * reverseFactor)));
    const float inputCoefficient = static_cast<float>(
        1.0 - std::exp(-2.0 * juce::MathConstants<double>::pi * cutoffHz / sampleRate));
    const float textureGain = static_cast<float>(
        deckGain * strength * (0.00070 + 0.00065 * speedFactor));

    for (int sample = 0; sample < samples; ++sample)
    {
        noiseState = noiseState * 1664525U + 1013904223U;
        const float white = static_cast<float>((noiseState >> 8) * (1.0 / 16777215.0) - 0.5);
        grooveState += (white - grooveState) * 0.09F;
        const float texture = grooveState * textureGain;
        const int outputSample = startSample + sample;

        for (int channel = 0; channel < channels; ++channel)
        {
            auto* output = buffer.getWritePointer(channel);
            lowPassState[static_cast<std::size_t>(channel)] +=
                (output[outputSample] - lowPassState[static_cast<std::size_t>(channel)])
                * inputCoefficient;
            output[outputSample] = lowPassState[static_cast<std::size_t>(channel)] + texture;
        }
    }
}

} // namespace silverdaw::scratch
