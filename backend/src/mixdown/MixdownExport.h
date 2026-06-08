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

// Output-format / metadata writers used by `renderMixdownAsync` after the
// render pass. These run on the worker thread doing post-encode file I/O —
// they are not audio-thread code. Kept in a dedicated internal namespace so
// they read as implementation detail, not public engine API.

/** Locate the bundled `lame.exe` (`lame` on non-Windows) next to the backend
 *  executable. JUCE's LAMEEncoderAudioFormat shells out to it. */
juce::File findLameExecutable();

/** Map a CBR bitrate (kbps) to JUCE's LAMEEncoderAudioFormat quality option
 *  index (CBR rates start at index 10 in the wrapper's option list). */
int lameQualityIndexForCbr(int kbps);

/** Build the id3* key/value map LAME recognises and writes as ID3v2 frames. */
std::unordered_map<juce::String, juce::String> buildMp3MetadataMap(const ExportMetadata& md);

/** Build the RIFF INFO key/value map JUCE's WavAudioFormat writes. */
std::unordered_map<juce::String, juce::String> buildWavMetadataMap(const ExportMetadata& md);

/** Patch AIFF text chunks (NAME/AUTH/(c) /ANNO) into an already-written AIFF
 *  file, since JUCE 8's AiffAudioFormat writer ignores metadata. */
bool writeAiffTextChunks(const juce::File& aiffFile, const ExportMetadata& md);

/** Inject a VORBIS_COMMENT block into an already-written FLAC file, since
 *  JUCE 8's FlacAudioFormat exposes no tag-writing hook. */
bool writeFlacVorbisComment(const juce::File& flacFile, const ExportMetadata& md);

/** Atomic "<file>.tmp" → "<file>" finalize (MoveFileEx on Windows). */
bool atomicReplace(const juce::File& tmp, const juce::File& target);

/** Create the final-format writer for the user's chosen container, applying
 *  WAV/MP3 metadata (FLAC/AIFF tags are post-processed after encode). MP3 forces
 *  16-bit integral + the CBR quality option. `baseOptions` must already carry
 *  sample rate / channels / bit depth / sample format. On failure returns
 *  nullptr WITHOUT consuming `stream`, so the caller cleans up the stream. */
std::unique_ptr<juce::AudioFormatWriter> createOutputWriter(
    MixdownOptions::Format format,
    const juce::AudioFormatWriterOptions& baseOptions,
    const juce::File& lameApp,
    const ExportMetadata& metadata,
    int bitrateKbps,
    std::unique_ptr<juce::OutputStream>& stream);

} // namespace silverdaw::mixdown_export
