#pragma once

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>

namespace silverdaw
{

// Deep read-ahead priming avoids JUCE BufferingAudioSource dropping cold samples at play start.
class DecodedCache
{
  public:
    DecodedCache();

    juce::File ensureDecoded(const juce::File& sourceFile, juce::AudioFormatManager& formatManager) const;

    juce::File recreateDecoded(const juce::File& sourceFile, juce::AudioFormatManager& formatManager) const;

    juce::File getCacheFilePath(const juce::File& sourceFile) const;

  private:
    juce::File cacheFileFor(const juce::File& sourceFile) const;
    juce::File cacheDir;
};

} // namespace silverdaw
