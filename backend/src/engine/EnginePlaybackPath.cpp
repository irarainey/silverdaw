#include "EnginePlaybackPath.h"

#include "DecodedCache.h"
#include "ProjectState.h"

namespace silverdaw
{

juce::String findLibraryItemIdForPath(const ProjectState& projectState, const juce::String& filePath)
{
    const auto& root = projectState.getTree();
    const auto library = root.getChildWithName(juce::Identifier{"LIBRARY"});
    if (!library.isValid()) return {};
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        // Saved clips share their source's filePath, so exclude them to avoid
        // resolving the source id; stems own a unique file and resolve here.
        if (item.getProperty(juce::Identifier{"kind"}, "audio-file").toString() != "saved-clip"
            && item.getProperty(juce::Identifier{"filePath"}).toString() == filePath)
        {
            return item.getProperty(juce::Identifier{"id"}).toString();
        }
    }
    return {};
}

juce::String resolveEnginePlaybackPath(const juce::String& sourceFilePath,
                                       ProjectState& projectState,
                                       const DecodedCache& decodedCache)
{
    if (sourceFilePath.isEmpty()) return sourceFilePath;
    const juce::File source(sourceFilePath);
    if (!source.existsAsFile()) return sourceFilePath;

    const auto cacheFile = decodedCache.getCacheFilePath(source);
    if (cacheFile.existsAsFile())
    {
        const auto cachePath = cacheFile.getFullPathName();
        const auto stored = projectState.getLibraryItemPlaybackPathForSource(sourceFilePath);
        if (stored != cachePath)
        {
            const auto itemId = findLibraryItemIdForPath(projectState, sourceFilePath);
            if (itemId.isNotEmpty())
            {
                projectState.setLibraryItemPlaybackPath(itemId, cachePath);
            }
        }
        return cachePath;
    }

    const auto stored = projectState.getLibraryItemPlaybackPathForSource(sourceFilePath);
    if (stored.isNotEmpty() && stored.endsWithIgnoreCase(".wav") && juce::File(stored).existsAsFile())
    {
        return stored;
    }
    return sourceFilePath;
}

} // namespace silverdaw
