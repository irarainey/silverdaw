#include "ProjectImportSource.h"

#include "ProjectFile.h"
#include "ProjectState.h"
#include "ScratchPatternState.h"

#include "scratch/ScratchProtocol.h"

namespace silverdaw
{
namespace
{

const juce::Identifier kProject{"PROJECT"};
const juce::Identifier kLibrary{"LIBRARY"};
const juce::Identifier kLibraryItem{"ITEM"};
const juce::Identifier kName{"name"};
const juce::Identifier kDisplayName{"displayName"};
const juce::Identifier kScratchPatternId{"scratchPatternId"};

bool isManagedSourceFile(const juce::File& file, const juce::File& root)
{
    return file.existsAsFile() && file.isAChildOf(root);
}

juce::var libraryItemAsImportData(const juce::ValueTree& item)
{
    auto* data = new juce::DynamicObject();
    for (int i = 0; i < item.getNumProperties(); ++i)
    {
        const auto property = item.getPropertyName(i);
        data->setProperty(property, item.getProperty(property));
    }

    const auto displayName = item.getProperty(kDisplayName).toString();
    if (displayName.isNotEmpty())
        data->setProperty("name", displayName);
    else
        data->setProperty("name", item.getProperty(kName).toString());

    if (item.hasProperty(kScratchPatternId))
        data->setProperty("scratchOrigin", true);
    return {data};
}

std::optional<SourceLibraryItem> parseSourceLibraryItem(const juce::ValueTree& item,
                                                        const juce::File& sourceProjectFile)
{
    const auto data = libraryItemAsImportData(item);
    const auto id = data.getProperty("id", {}).toString();
    const auto kind = data.getProperty("kind", "source").toString();
    const auto filePath = data.getProperty("filePath", {}).toString();
    if (id.isEmpty() || filePath.isEmpty() || (kind != "stem" && kind != "sample"))
        return std::nullopt;

    const auto sourceDirectory = sourceProjectFile.getParentDirectory();
    const auto stemsRoot = sourceDirectory.getChildFile("stems");
    const auto samplesRoot = sourceDirectory.getChildFile("samples");
    const auto scratchesRoot = sourceDirectory.getChildFile("scratches");
    const auto recordingsRoot = sourceDirectory.getChildFile("recordings");
    const juce::File file(filePath);

    if (kind == "stem" && isManagedSourceFile(file, stemsRoot))
        return SourceLibraryItem{data, id, kind, file, stemsRoot};
    if (kind == "sample" && isManagedSourceFile(file, samplesRoot))
        return SourceLibraryItem{data, id, kind, file, samplesRoot};
    if (kind == "sample" && data.getProperty("scratchOrigin", false)
        && isManagedSourceFile(file, scratchesRoot))
        return SourceLibraryItem{data, id, kind, file, scratchesRoot};
    // A recording is an ordinary sample living in its own category folder, so
    // containment alone identifies it (ADR 0030).
    if (kind == "sample" && isManagedSourceFile(file, recordingsRoot))
        return SourceLibraryItem{data, id, kind, file, recordingsRoot};
    return std::nullopt;
}

} // namespace

std::optional<SourceProjectImport> loadSourceProjectImport(const juce::File& sourceProjectFile,
                                                           juce::String& error)
{
    juce::ValueTree tree;
    const auto result = ProjectFile::loadTree(sourceProjectFile, tree);
    if (!result.ok)
    {
        error = result.error;
        return std::nullopt;
    }
    if (!tree.hasType(kProject))
    {
        error = "Source project has an invalid root";
        return std::nullopt;
    }

    SourceProjectImport source;
    source.name = tree.getProperty(kName, "Untitled").toString();

    // The source project is read as a bare tree, so it never goes through the load-time
    // repair. Apply it here too, or a stem an older build demoted to a plain source stays
    // invisible to this import until that project is opened and re-saved.
    auto library = tree.getChildWithName(kLibrary);
    ProjectState::repairLibraryItemKinds(library, sourceProjectFile.getParentDirectory());
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (!item.hasType(kLibraryItem))
            continue;
        if (const auto parsed = parseSourceLibraryItem(item, sourceProjectFile))
            source.library.emplace(parsed->id, *parsed);
    }

    const auto patterns = tree.getChildWithName(scratch_ids::kScratchPatterns);
    for (int i = 0; i < patterns.getNumChildren(); ++i)
    {
        const auto pattern = patterns.getChild(i);
        if (!pattern.hasType(scratch_ids::kScratchPattern))
            continue;
        const auto& data = pattern.getProperty(scratch_ids::kScratchPatternData);
        const auto parsed = scratch::parsePattern(data);
        if (parsed && parsed->id.isNotEmpty())
            source.scratchPatterns.emplace(parsed->id, data);
    }

    const auto scratchesRoot = sourceProjectFile.getParentDirectory().getChildFile("scratches");
    for (auto it = source.library.begin(); it != source.library.end();)
    {
        const auto patternId = it->second.data.getProperty("scratchPatternId", {}).toString();
        const auto sourceSnapshot = scratchesRoot.getChildFile(patternId).getChildFile("source.wav");
        if (patternId.isNotEmpty()
            && (source.scratchPatterns.find(patternId) == source.scratchPatterns.end()
                || !sourceSnapshot.existsAsFile()))
            it = source.library.erase(it);
        else
            ++it;
    }

    return source;
}

} // namespace silverdaw
