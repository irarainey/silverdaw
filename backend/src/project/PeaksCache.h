#pragma once

#include "Waveform.h"

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>

namespace silverdaw
{

// Disk cache invalidated by path, mtime, size, and peaks/s; entries are read-only after atomic write.
class PeaksCache
{
  public:
    PeaksCache();

    explicit PeaksCache(const juce::File& cacheDirectory);

    // Empty result means cache miss or failed validation.
    waveform::PeaksResult tryLoad(const juce::File& sourceFile, int peaksPerSecond) const;

    // Cache writes are best-effort; misses remain recoverable.
    void store(const juce::File& sourceFile, const waveform::PeaksResult& result) const;

    // Lets the bridge send cache paths instead of waveform bytes.
    juce::File getCacheFilePath(const juce::File& sourceFile, int peaksPerSecond) const;

  private:
    juce::File cacheFileFor(const juce::File& sourceFile, int peaksPerSecond) const;
    juce::File cacheDir;
};

} // namespace silverdaw
