#include "ProjectCommands.h"

#include "BridgeServer.h"
#include "EditUndoState.h"
#include "Log.h"
#include "PayloadHelpers.h"
#include "ProjectImportSource.h"
#include "ProjectSession.h"
#include "ProjectState.h"
#include "UndoCommands.h"

#include "scratch/ScratchProtocol.h"

#include <cmath>
#include <map>
#include <optional>
#include <set>
#include <vector>

namespace silverdaw
{
namespace
{

using bridge::tryGetRequiredString;
using bridge::tryGetStringArray;

struct StagedLibraryItem
{
    SourceLibraryItem source;
    juce::String destinationId;
    juce::File stagingDirectory;
    juce::File destinationDirectory;
    juce::File destinationFile;
};

struct StagedScratchPattern
{
    juce::String sourceId;
    juce::var pattern;
    juce::String destinationId;
    juce::File stagingDirectory;
    juce::File destinationDirectory;
};

juce::var makeResultPayload(bool ok, const juce::String& sourceProjectPath,
                            const juce::String& error = {})
{
    auto* result = new juce::DynamicObject();
    result->setProperty("ok", ok);
    result->setProperty("sourceProjectPath", sourceProjectPath);
    if (error.isNotEmpty())
        result->setProperty("error", error);
    return juce::var(result);
}

bool copyDirectoryOrFileToStaging(const juce::File& sourceFile, const juce::File& sourceRoot,
                                  const juce::File& stagingDirectory, juce::String& error)
{
    const auto sourceDirectory = sourceFile.getParentDirectory();
    if (sourceDirectory == sourceRoot)
    {
        if (!stagingDirectory.createDirectory()
            || !sourceFile.copyFileTo(stagingDirectory.getChildFile(sourceFile.getFileName())))
        {
            error = "Could not stage imported audio";
            return false;
        }
        return true;
    }

    if (!sourceDirectory.isAChildOf(sourceRoot)
        || !sourceDirectory.copyDirectoryTo(stagingDirectory))
    {
        error = "Could not stage imported project artifacts";
        return false;
    }
    return true;
}

bool moveStagedDirectory(const juce::File& stagingDirectory, const juce::File& destinationDirectory)
{
    if (!destinationDirectory.getParentDirectory().createDirectory())
        return false;
    return stagingDirectory.moveFileTo(destinationDirectory);
}

bool addImportedLibraryItem(ProjectState& projectState, const StagedLibraryItem& item)
{
    const auto& source = item.source.data;
    const auto name = source.getProperty("name", {}).toString();
    const auto fileName = item.destinationFile.getFileName();
    const auto durationMs = static_cast<double>(source.getProperty("durationMs", 0.0));
    const auto sampleRate = static_cast<int>(source.getProperty("sampleRate", 0));
    const auto channelCount = static_cast<int>(source.getProperty("channelCount", 0));
    const auto key = source.getProperty("key", {}).toString();
    const auto mediaId = source.getProperty("mediaId", {}).toString();
    // A stem's schema requires a source item. Imported stems have no foreign
    // source relationship, so their new destination item is their stable local origin.
    const auto sourceItemId = item.source.kind == "stem" ? item.destinationId : juce::String{};

    if (!projectState.addLibraryItem(item.destinationId, item.destinationFile.getFullPathName(), fileName,
                                     durationMs, sampleRate, channelCount,
                                     item.destinationFile.getFullPathName(), key, item.source.kind, name,
                                     sourceItemId, {}, -1.0, -1.0, -1, mediaId))
        return false;

    const auto audioType = source.getProperty("audioType", {}).toString();
    if (audioType == "simple" || audioType == "music")
        projectState.setLibraryItemAudioType(item.destinationId, audioType);

    const auto bpm = static_cast<double>(source.getProperty("bpm", 0.0));
    if (std::isfinite(bpm) && bpm > 0.0)
        projectState.setLibraryItemBpm(item.destinationId, bpm);

    if (const auto* beats = source.getProperty("beats", juce::var()).getArray())
    {
        std::vector<double> times;
        times.reserve(static_cast<size_t>(beats->size()));
        for (const auto& beat : *beats)
        {
            if (!(beat.isDouble() || beat.isInt() || beat.isInt64()))
                continue;
            const auto seconds = static_cast<double>(beat);
            if (std::isfinite(seconds) && seconds >= 0.0)
                times.push_back(seconds);
        }
        projectState.setLibraryItemBeats(item.destinationId, times);
    }

    const auto beatAnchor = static_cast<double>(source.getProperty("beatAnchorSec", 0.0));
    if (std::isfinite(beatAnchor))
        projectState.setLibraryItemBeatAnchor(item.destinationId, beatAnchor);
    if (source.getProperty("variableTempo", false))
        projectState.setLibraryItemVariableTempo(item.destinationId, true);
    if (source.getProperty("lowConfidence", false))
        projectState.setLibraryItemLowConfidence(item.destinationId, true);
    return true;
}

juce::var remapScratchPattern(const juce::var& source, const juce::String& destinationId)
{
    const auto parsed = scratch::parsePattern(source);
    jassert(parsed.has_value());
    auto imported = *parsed;
    imported.id = destinationId;
    imported.provenance.reset();
    return scratch::serializePattern(imported);
}

bool copyRelevantMedia(const std::vector<StagedLibraryItem>& items, const juce::File& sourceProjectFile,
                       const juce::File& destinationBase, juce::String& error)
{
    const auto sourceBase = sourceProjectFile.getParentDirectory();
    const auto sourceMetadata = sourceBase.getChildFile("metadata");
    const auto sourceCovers = sourceBase.getChildFile("covers");
    const auto destinationMetadata = destinationBase.getChildFile("metadata");
    const auto destinationCovers = destinationBase.getChildFile("covers");
    std::set<juce::String> mediaIds;

    for (const auto& item : items)
    {
        const auto mediaId = item.source.data.getProperty("mediaId", {}).toString();
        if (mediaId.isNotEmpty())
            mediaIds.insert(mediaId);
    }

    for (const auto& mediaId : mediaIds)
    {
        const auto sourceMetadataFile = sourceMetadata.getChildFile(mediaId + ".json");
        if (!sourceMetadataFile.existsAsFile())
            continue;

        const auto destinationMetadataFile = destinationMetadata.getChildFile(mediaId + ".json");
        if (!destinationMetadata.createDirectory()
            || (!destinationMetadataFile.existsAsFile()
                && !sourceMetadataFile.copyFileTo(destinationMetadataFile)))
        {
            error = "Could not copy imported metadata";
            return false;
        }

        juce::var metadata;
        if (juce::JSON::parse(sourceMetadataFile.loadFileAsString(), metadata).failed())
            continue;
        const auto cover = metadata.getProperty("cover", juce::var());
        const auto coverFile = cover.getProperty("file", {}).toString();
        if (coverFile.isEmpty())
            continue;

        const auto sourceCover = sourceCovers.getChildFile(juce::File(coverFile).getFileName());
        const auto destinationCover = destinationCovers.getChildFile(sourceCover.getFileName());
        if (sourceCover.existsAsFile()
            && (!destinationCovers.createDirectory()
                || (!destinationCover.existsAsFile() && !sourceCover.copyFileTo(destinationCover))))
        {
            error = "Could not copy imported cover art";
            return false;
        }
    }
    return true;
}

void broadcastImportManifest(const juce::String& sourceProjectPath, const SourceProjectImport& source,
                             BridgeServer& bridge)
{
    auto* payload = new juce::DynamicObject();
    payload->setProperty("sourceProjectPath", sourceProjectPath);
    payload->setProperty("name", source.name);

    juce::Array<juce::var> stems;
    juce::Array<juce::var> samples;
    for (const auto& [id, item] : source.library)
    {
        auto* entry = new juce::DynamicObject();
        entry->setProperty("id", id);
        entry->setProperty("name", item.data.getProperty("name",
                                                         item.file.getFileNameWithoutExtension()).toString());
        if (item.kind == "stem")
            stems.add(juce::var(entry));
        else
            samples.add(juce::var(entry));
    }
    payload->setProperty("stems", juce::var(stems));
    payload->setProperty("samples", juce::var(samples));

    bridge.broadcast("PROJECT_IMPORT_SOURCE_MANIFEST", juce::var(payload));
}

} // namespace

void handleProjectImportSourceInspect(const juce::var& payload, ProjectState& /* projectState */,
                                      BridgeServer& bridge, const ProjectSession& session)
{
    const auto sourcePath = tryGetRequiredString(payload, "sourceProjectPath").value_or(juce::String{});
    if (sourcePath.isEmpty())
        return;
    if (sourcePath == session.currentPath)
    {
        bridge.broadcast("PROJECT_IMPORT_SOURCE_FAILED",
                         makeResultPayload(false, sourcePath, "Choose a different project to import from"));
        return;
    }

    juce::String error;
    const auto source = loadSourceProjectImport(juce::File(sourcePath), error);
    if (!source)
    {
        bridge.broadcast("PROJECT_IMPORT_SOURCE_FAILED", makeResultPayload(false, sourcePath, error));
        return;
    }
    broadcastImportManifest(sourcePath, *source, bridge);
}

void handleProjectImportAssets(const juce::var& payload, ProjectState& projectState,
                               BridgeServer& bridge, const ProjectSession& session)
{
    const auto sourcePath = tryGetRequiredString(payload, "sourceProjectPath").value_or(juce::String{});
    const auto libraryIds = tryGetStringArray(payload, "libraryItemIds");
    if (sourcePath.isEmpty() || !libraryIds)
        return;
    if (libraryIds->isEmpty())
    {
        bridge.broadcast("PROJECT_IMPORT_COMPLETED",
                         makeResultPayload(false, sourcePath, "Select at least one asset to import"));
        return;
    }
    if (sourcePath == session.currentPath)
    {
        bridge.broadcast("PROJECT_IMPORT_COMPLETED",
                         makeResultPayload(false, sourcePath, "Choose a different project to import from"));
        return;
    }

    juce::String error;
    const auto source = loadSourceProjectImport(juce::File(sourcePath), error);
    if (!source)
    {
        bridge.broadcast("PROJECT_IMPORT_COMPLETED", makeResultPayload(false, sourcePath, error));
        return;
    }

    const auto sourceFile = juce::File(sourcePath);
    const auto& importableLibrary = source->library;
    const auto& importablePatterns = source->scratchPatterns;
    for (const auto& id : *libraryIds)
    {
        if (importableLibrary.find(id) == importableLibrary.end())
        {
            bridge.broadcast("PROJECT_IMPORT_COMPLETED",
                             makeResultPayload(false, sourcePath, "A selected source asset is unavailable"));
            return;
        }
    }
    std::set<juce::String> scratchIds;
    for (const auto& id : *libraryIds)
    {
        const auto patternId = importableLibrary.at(id).data.getProperty("scratchPatternId", {}).toString();
        if (patternId.isEmpty())
            continue;
        if (importablePatterns.find(patternId) == importablePatterns.end())
        {
            bridge.broadcast("PROJECT_IMPORT_COMPLETED",
                             makeResultPayload(false, sourcePath, "A selected scratch source is unavailable"));
            return;
        }
        scratchIds.insert(patternId);
    }

    const auto destinationBase = projectArtifactsBaseDir(session.currentPath, "samples").getParentDirectory();
    const auto stagingRoot = destinationBase.getChildFile(".import-staging-" + juce::Uuid().toString());
    std::vector<StagedLibraryItem> stagedLibrary;
    std::vector<StagedScratchPattern> stagedPatterns;
    std::vector<juce::File> movedDirectories;

    auto fail = [&](const juce::String& message)
    {
        stagingRoot.deleteRecursively();
        for (const auto& directory : movedDirectories)
            directory.deleteRecursively();
        bridge.broadcast("PROJECT_IMPORT_COMPLETED", makeResultPayload(false, sourcePath, message));
    };

    for (const auto& id : *libraryIds)
    {
        const auto& sourceItem = importableLibrary.at(id);
        const auto destinationId = juce::Uuid().toString();
        const auto destinationRoot = projectArtifactsBaseDir(session.currentPath,
                                                              sourceItem.kind == "stem" ? "stems" : "samples");
        const auto stagingDirectory = stagingRoot.getChildFile(sourceItem.kind == "stem" ? "stems" : "samples")
                                                 .getChildFile(destinationId);
        if (!copyDirectoryOrFileToStaging(sourceItem.file, sourceItem.root, stagingDirectory, error))
        {
            fail(error);
            return;
        }
        stagedLibrary.push_back({sourceItem, destinationId, stagingDirectory,
                                 destinationRoot.getChildFile("import-" + destinationId),
                                 destinationRoot.getChildFile("import-" + destinationId)
                                                .getChildFile(sourceItem.file.getFileName())});
    }

    const auto sourceScratches = sourceFile.getParentDirectory().getChildFile("scratches");
    const auto destinationScratches = projectArtifactsBaseDir(session.currentPath, "scratches");
    for (const auto& id : scratchIds)
    {
        const auto destinationId = juce::Uuid().toString();
        const auto stagingDirectory = stagingRoot.getChildFile("scratches").getChildFile(destinationId);
        const auto sourceDirectory = sourceScratches.getChildFile(id);
        if (sourceDirectory.exists() && !sourceDirectory.isDirectory())
        {
            fail("A selected scratch artifact is invalid");
            return;
        }
        if (sourceDirectory.isDirectory() && !sourceDirectory.copyDirectoryTo(stagingDirectory))
        {
            fail("Could not stage scratch artifacts");
            return;
        }
        stagedPatterns.push_back({id, remapScratchPattern(importablePatterns.at(id), destinationId), destinationId,
                                  stagingDirectory, destinationScratches.getChildFile(destinationId)});
    }

    for (const auto& item : stagedLibrary)
    {
        if (!moveStagedDirectory(item.stagingDirectory, item.destinationDirectory))
        {
            fail("Could not copy imported audio into this project");
            return;
        }
        movedDirectories.push_back(item.destinationDirectory);
    }
    for (const auto& pattern : stagedPatterns)
    {
        if (pattern.stagingDirectory.exists() && !moveStagedDirectory(pattern.stagingDirectory, pattern.destinationDirectory))
        {
            fail("Could not copy imported scratch artifacts into this project");
            return;
        }
        if (pattern.destinationDirectory.exists())
            movedDirectories.push_back(pattern.destinationDirectory);
    }

    if (!copyRelevantMedia(stagedLibrary, sourceFile, destinationBase, error))
    {
        fail(error);
        return;
    }

    std::map<juce::String, juce::String> importedPatternIds;
    std::map<juce::String, juce::File> importedPatternDirectories;
    for (const auto& pattern : stagedPatterns)
    {
        importedPatternIds.emplace(pattern.sourceId, pattern.destinationId);
        importedPatternDirectories.emplace(pattern.sourceId, pattern.destinationDirectory);
    }

    for (const auto& item : stagedLibrary)
    {
        if (!addImportedLibraryItem(projectState, item))
        {
            fail("Could not add an imported library item");
            return;
        }
        const auto sourcePatternId = item.source.data.getProperty("scratchPatternId", {}).toString();
        const auto pattern = importedPatternIds.find(sourcePatternId);
        const auto patternDirectory = importedPatternDirectories.find(sourcePatternId);
        const auto sourceSnapshot =
            patternDirectory != importedPatternDirectories.end()
                ? patternDirectory->second.getChildFile("source.wav")
                : juce::File{};
        if (sourcePatternId.isNotEmpty()
            && (pattern == importedPatternIds.end()
                || !sourceSnapshot.existsAsFile()
                || !projectState.setLibraryItemScratchMeta(item.destinationId, pattern->second,
                                                            sourceSnapshot.getFullPathName(),
                                                            /* undoable= */ true)))
        {
            fail("Could not link an imported scratch sample");
            return;
        }
    }
    for (const auto& pattern : stagedPatterns)
    {
        if (!projectState.addScratchPattern(pattern.pattern))
        {
            fail("Could not add an imported scratch pattern");
            return;
        }
    }

    stagingRoot.deleteRecursively();
    bridge.broadcast("PROJECT_STATE", buildProjectStateEnvelope(session, projectState, false));
    bridge.broadcast("PROJECT_IMPORT_COMPLETED", makeResultPayload(true, sourcePath));
    broadcastEditUndoState(projectState, bridge);
}

} // namespace silverdaw
