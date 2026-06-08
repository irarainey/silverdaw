#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class ProjectState;
class DecodedCache;


juce::String findLibraryItemIdForPath(const ProjectState& projectState, const juce::String& filePath);

juce::String resolveEnginePlaybackPath(const juce::String& sourceFilePath,
                                       ProjectState& projectState,
                                       const DecodedCache& decodedCache);

} // namespace silverdaw
