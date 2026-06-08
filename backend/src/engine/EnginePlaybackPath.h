#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class ProjectState;
class DecodedCache;

// Shared resolution of the on-disk path the audio engine should actually play
// for a given source file. Lives in its own TU because clip-ingest, waveform,
// preview, and engine-rebuild all depend on it.

// Library item id (if any) whose filePath matches `filePath`, else empty.
// CLIP_ADD payloads omit the library itemId, so callers re-derive it here.
juce::String findLibraryItemIdForPath(const ProjectState& projectState, const juce::String& filePath);

// Prefer the decoded-WAV cache for `sourceFilePath` so compressed sources play
// promptly; falls back to a stored .wav playback path, then the source itself.
// Updates the library item's playbackFilePath when a fresh cache is found.
juce::String resolveEnginePlaybackPath(const juce::String& sourceFilePath,
                                       ProjectState& projectState,
                                       const DecodedCache& decodedCache);

} // namespace silverdaw
