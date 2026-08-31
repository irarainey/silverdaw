#pragma once

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>

namespace silverdaw
{

// Result of streaming a reader into a writer; `samplesWritten` may fall short of the
// reader's reported length when that length was only an estimate.
struct DecodeResult
{
    juce::int64 samplesWritten = 0;
    bool writeFailed = false;
};

// Below this share of the reader's reported length a decode is a real failure, not an
// over-estimated tail, and must not be cached.
inline constexpr double kMinDecodedFraction = 0.98;

// Copy reader -> writer a block at a time, stopping cleanly when the reader runs dry.
DecodeResult writeDecodedBlocks(juce::AudioFormatReader& reader, juce::AudioFormatWriter& writer);

// True if `wav` reads back as real audio.
//
// Deliberately checks the WAV format directly instead of going through
// AudioFormatManager, which selects a reader from the file extension: decodes land
// on a `.wav.tmp` staging path, so an extension-based check finds no format for
// `.tmp` and rejects every good decode.
bool decodedWavIsUsable(const juce::File& wav);

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
    juce::Array<juce::File> supersededCacheFilesFor(const juce::File& sourceFile) const;
    juce::File cacheDir;
};

} // namespace silverdaw
