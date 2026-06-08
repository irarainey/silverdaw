#pragma once

#include "MixdownEngine.h" // for silverdaw::ExportMetadata

#include <memory>
#include <unordered_map>

#include <juce_core/juce_core.h>

namespace juce
{
class AudioFormatWriter;
class AudioFormatWriterOptions;
class OutputStream;
} // namespace juce

namespace silverdaw::mixdown_export
{


juce::File findLameExecutable();

int lameQualityIndexForCbr(int kbps);

std::unordered_map<juce::String, juce::String> buildMp3MetadataMap(const ExportMetadata& md);

std::unordered_map<juce::String, juce::String> buildWavMetadataMap(const ExportMetadata& md);

// JUCE 8 lacks some tag hooks, so FLAC/AIFF metadata is post-processed after encode.
bool writeAiffTextChunks(const juce::File& aiffFile, const ExportMetadata& md);

bool writeFlacVorbisComment(const juce::File& flacFile, const ExportMetadata& md);

// Write caches to a sibling temp file so partial entries are never visible.
bool atomicReplace(const juce::File& tmp, const juce::File& target);

std::unique_ptr<juce::AudioFormatWriter> createOutputWriter(
    MixdownOptions::Format format,
    const juce::AudioFormatWriterOptions& baseOptions,
    const juce::File& lameApp,
    const ExportMetadata& metadata,
    int bitrateKbps,
    std::unique_ptr<juce::OutputStream>& stream);

} // namespace silverdaw::mixdown_export
