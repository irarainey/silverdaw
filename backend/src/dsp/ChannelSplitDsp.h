#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

// Copy one channel across every channel of a buffer's first `numSamples` frames,
// turning a stereo (or multi-channel) block into a mono-as-stereo block that
// carries only the chosen channel. Used by the "split stereo channels" export so
// the new clip is a stereo file whose L and R both hold the source's L (or R).
// No-op when the buffer has fewer than two channels or the index is out of range.
inline void duplicateChannelAcross(juce::AudioBuffer<float>& buffer, int numSamples, int sourceChannel)
{
    const int numChannels = buffer.getNumChannels();
    if (numChannels < 2 || sourceChannel < 0 || sourceChannel >= numChannels) return;
    const int frames = juce::jmin(numSamples, buffer.getNumSamples());
    if (frames <= 0) return;
    const float* const source = buffer.getReadPointer(sourceChannel);
    for (int channel = 0; channel < numChannels; ++channel)
    {
        if (channel == sourceChannel) continue;
        buffer.copyFrom(channel, 0, source, frames);
    }
}

} // namespace silverdaw
