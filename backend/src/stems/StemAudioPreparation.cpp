#include "StemAudioPreparation.h"

namespace silverdaw
{

juce::AudioBuffer<float> denormaliseStemMixture(
    const juce::AudioBuffer<float>& mixture, int channelCount, float mean, float standardDeviation)
{
    juce::AudioBuffer<float> raw(channelCount, mixture.getNumSamples());
    for (int channel = 0; channel < channelCount; ++channel)
    {
        const float* source = mixture.getReadPointer(channel);
        float* destination = raw.getWritePointer(channel);
        for (int sample = 0; sample < mixture.getNumSamples(); ++sample)
            destination[sample] = source[sample] * standardDeviation + mean;
    }
    return raw;
}

bool shouldBuildRawStemMixture(
    bool haveVocalPack, bool vocalsSelected, bool useRhythmPack) noexcept
{
    return (haveVocalPack && vocalsSelected) || useRhythmPack;
}

} // namespace silverdaw
