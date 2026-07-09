#include "ProjectFile.h"

#include "ValueTreeJson.h"
#include "Version.h"

namespace silverdaw::ProjectFile
{

namespace
{

constexpr const char* kSchemaVersionKey = "schemaVersion";
constexpr const char* kAppVersionKey = "appVersion";
constexpr const char* kSavedAtKey = "savedAt";
constexpr const char* kProjectKey = "project";
constexpr const char* kAppVersionValue = silverdaw::kBackendVersion;

/** ISO-8601 (millisecond precision, UTC) timestamp for `savedAt`. */
juce::String isoTimestampNowUtc()
{
    return juce::Time::getCurrentTime().toISO8601(true);
}

// Properties whose string value is a filesystem path that should travel with the
// project. The rewrite is location-based: a path inside the project folder is
// stored relative to it (so the folder is portable across machines / sync roots);
// anything outside — original source files and machine-local caches — stays
// absolute. Applied only at the on-disk JSON boundary; the in-memory tree and the
// bridge snapshot always hold absolute paths.
const juce::StringArray kPortablePathKeys{"filePath", "playbackFilePath"};

juce::String toPortablePath(const juce::String& stored, const juce::File& projectDir)
{
    if (stored.isEmpty() || !juce::File::isAbsolutePath(stored))
    {
        return stored;
    }
    const juce::String rel = juce::File(stored).getRelativePathFrom(projectDir);
    // Cross-drive targets come back absolute; targets that escape the project
    // folder start with ".." — both keep their absolute path.
    if (juce::File::isAbsolutePath(rel) || rel.startsWith(".."))
    {
        return stored;
    }
    return rel;
}

juce::String fromPortablePath(const juce::String& stored, const juce::File& projectDir)
{
    if (stored.isEmpty() || juce::File::isAbsolutePath(stored))
    {
        return stored;
    }
    return projectDir.getChildFile(stored).getFullPathName();
}

// Recursively rewrite portable path properties throughout the serialised project
// var. `forSave` chooses the direction (absolute→relative vs relative→absolute).
void rewritePortablePaths(juce::var& node, const juce::File& projectDir, bool forSave)
{
    if (auto* arr = node.getArray())
    {
        for (auto& element : *arr)
        {
            rewritePortablePaths(element, projectDir, forSave);
        }
        return;
    }

    auto* obj = node.getDynamicObject();
    if (obj == nullptr)
    {
        return;
    }

    auto& props = obj->getProperties();
    for (int i = 0; i < props.size(); ++i)
    {
        const auto name = props.getName(i);
        if (kPortablePathKeys.contains(name.toString()))
        {
            const juce::String stored = props.getValueAt(i).toString();
            const juce::String converted =
                forSave ? toPortablePath(stored, projectDir) : fromPortablePath(stored, projectDir);
            if (converted != stored)
            {
                obj->setProperty(name, converted);
            }
        }
        else
        {
            // Child objects/arrays are reference-counted, so mutating through this
            // copy updates the shared underlying node in place.
            juce::var child = props.getValueAt(i);
            rewritePortablePaths(child, projectDir, forSave);
        }
    }
}

juce::Result writeProjectJsonAtomically(const juce::File& file, const juce::var& rootVar)
{
    const auto& target = file.getFullPathName();
    if (target.isEmpty())
    {
        return juce::Result::fail("Save target path is empty");
    }

    const juce::File tempFile = file.getSiblingFile(file.getFileName() + ".tmp");
    if (tempFile.existsAsFile())
    {
        tempFile.deleteFile();
    }

    if (!tempFile.create().wasOk())
    {
        return juce::Result::fail("Cannot create temp file " + tempFile.getFullPathName());
    }

    const auto jsonString = juce::JSON::toString(rootVar);
    if (!tempFile.replaceWithText(jsonString))
    {
        tempFile.deleteFile();
        return juce::Result::fail("Failed to write project JSON to " + tempFile.getFullPathName());
    }

    if (file.existsAsFile())
    {
        file.deleteFile();
    }
    if (!tempFile.moveFileTo(file))
    {
        return juce::Result::fail("Failed to rename temp file to " + file.getFullPathName());
    }

    return juce::Result::ok();
}

} // namespace

juce::Result save(const juce::File& file, const ProjectState& project)
{
    const auto& projectTree = project.getTree();
    if (!projectTree.isValid())
    {
        return juce::Result::fail("Project state has no valid root");
    }

    auto* rootObj = new juce::DynamicObject();
    rootObj->setProperty(kSchemaVersionKey, kCurrentSchemaVersion);
    rootObj->setProperty(kAppVersionKey, kAppVersionValue);
    rootObj->setProperty(kSavedAtKey, isoTimestampNowUtc());

    const auto projectVar = ValueTreeJson::toVar(projectTree);
    if (projectVar.isVoid())
    {
        return juce::Result::fail("Failed to serialise project tree to JSON");
    }
    // Store project-internal artifact paths relative to the project folder so the
    // whole folder is portable; sources and machine-local caches stay absolute.
    juce::var portableVar = projectVar;
    rewritePortablePaths(portableVar, file.getParentDirectory(), /*forSave=*/true);
    rootObj->setProperty(kProjectKey, portableVar);

    return writeProjectJsonAtomically(file, juce::var(rootObj));
}

juce::Result saveViewState(const juce::File& file, double viewScrollX, double viewPxPerSecond,
                           double playheadMs, const juce::String& selectedTrackId, bool fxPanelOpen,
                           bool metronomeEnabled, bool clipEditorMetronomeEnabled)
{
    if (!file.existsAsFile())
    {
        return juce::Result::fail("File does not exist: " + file.getFullPathName());
    }

    juce::var rootVar;
    const auto parseResult = juce::JSON::parse(file.loadFileAsString(), rootVar);
    if (parseResult.failed())
    {
        return juce::Result::fail("Malformed project file: " + parseResult.getErrorMessage());
    }

    auto* rootObj = rootVar.getDynamicObject();
    if (rootObj == nullptr)
    {
        return juce::Result::fail("Project file is not a JSON object");
    }

    auto projectVar = rootObj->getProperty(kProjectKey);
    auto* projectObj = projectVar.getDynamicObject();
    if (projectObj == nullptr)
    {
        return juce::Result::fail("Project file has no \"project\" object");
    }

    rootObj->setProperty(kSavedAtKey, isoTimestampNowUtc());
    projectObj->setProperty("viewScrollX", juce::jmax(0.0, viewScrollX));
    projectObj->setProperty("viewPxPerSecond", juce::jmax(1.0, viewPxPerSecond));
    projectObj->setProperty("playheadMs", juce::jmax(0.0, playheadMs));
    projectObj->setProperty("viewSelectedTrack", selectedTrackId);
    projectObj->setProperty("viewFxPanelOpen", fxPanelOpen);
    // Persist the monitoring metronome toggle alongside view state (it's silent — never dirty —
    // so this targeted write is what keeps it consistent across open/close). Default-off omits the
    // field to match the project round-trip convention.
    if (metronomeEnabled)
        projectObj->setProperty("metronomeEnabled", true);
    else if (projectObj->hasProperty("metronomeEnabled"))
        projectObj->removeProperty("metronomeEnabled");
    if (clipEditorMetronomeEnabled)
        projectObj->setProperty("clipEditorMetronomeEnabled", true);
    else if (projectObj->hasProperty("clipEditorMetronomeEnabled"))
        projectObj->removeProperty("clipEditorMetronomeEnabled");
    rootObj->setProperty(kProjectKey, projectVar);

    return writeProjectJsonAtomically(file, rootVar);
}

juce::Result removeLibraryItems(const juce::File& file, const juce::StringArray& itemIds)
{
    if (itemIds.isEmpty()) return juce::Result::ok();
    // An unsaved project has nothing persisted yet — the item was never written to disk.
    if (!file.existsAsFile()) return juce::Result::ok();

    juce::var rootVar;
    const auto parseResult = juce::JSON::parse(file.loadFileAsString(), rootVar);
    if (parseResult.failed())
    {
        return juce::Result::fail("Malformed project file: " + parseResult.getErrorMessage());
    }

    auto* rootObj = rootVar.getDynamicObject();
    if (rootObj == nullptr)
    {
        return juce::Result::fail("Project file is not a JSON object");
    }

    auto projectVar = rootObj->getProperty(kProjectKey);
    auto* projectObj = projectVar.getDynamicObject();
    if (projectObj == nullptr)
    {
        return juce::Result::fail("Project file has no \"project\" object");
    }

    auto* projectChildren = projectObj->getProperty(ValueTreeJson::kChildrenKey).getArray();
    if (projectChildren == nullptr) return juce::Result::ok(); // no children => no library

    // Locate the LIBRARY child node.
    juce::DynamicObject* libraryObj = nullptr;
    for (auto& childVar : *projectChildren)
    {
        auto* childObj = childVar.getDynamicObject();
        if (childObj != nullptr
            && childObj->getProperty(ValueTreeJson::kTypeKey).toString() == "LIBRARY")
        {
            libraryObj = childObj;
            break;
        }
    }
    if (libraryObj == nullptr) return juce::Result::ok();

    auto* items = libraryObj->getProperty(ValueTreeJson::kChildrenKey).getArray();
    if (items == nullptr) return juce::Result::ok();

    bool removedAny = false;
    for (int i = items->size(); --i >= 0;)
    {
        auto* itemObj = items->getReference(i).getDynamicObject();
        if (itemObj == nullptr) continue;
        if (itemIds.contains(itemObj->getProperty("id").toString()))
        {
            items->remove(i);
            removedAny = true;
        }
    }
    if (!removedAny) return juce::Result::ok(); // already gone — leave the file untouched

    rootObj->setProperty(kSavedAtKey, isoTimestampNowUtc());
    return writeProjectJsonAtomically(file, rootVar);
}

LoadResult load(const juce::File& file, ProjectState& project)
{
    LoadResult result;

    if (!file.existsAsFile())
    {
        result.error = "File does not exist: " + file.getFullPathName();
        return result;
    }

    const auto jsonText = file.loadFileAsString();
    if (jsonText.isEmpty())
    {
        result.error = "Project file is empty: " + file.getFullPathName();
        return result;
    }

    juce::var rootVar;
    const auto parseResult = juce::JSON::parse(jsonText, rootVar);
    if (parseResult.failed())
    {
        result.error = "Malformed project file: " + parseResult.getErrorMessage();
        return result;
    }

    auto* rootObj = rootVar.getDynamicObject();
    if (rootObj == nullptr)
    {
        result.error = "Project file is not a JSON object";
        return result;
    }

    // Refuse newer schemas so incompatible fields are not silently dropped.
    const auto schemaVar = rootObj->getProperty(kSchemaVersionKey);
    result.schemaVersion = static_cast<int>(schemaVar);
    if (result.schemaVersion <= 0)
    {
        result.error = "Project file is missing a valid schemaVersion";
        return result;
    }
    if (result.schemaVersion > kCurrentSchemaVersion)
    {
        result.error = juce::String("Project was saved by a newer Silverdaw (schemaVersion ")
                       + juce::String(result.schemaVersion) + " > " + juce::String(kCurrentSchemaVersion)
                       + "). Upgrade Silverdaw to open this file.";
        return result;
    }

    // Unknown compatible sibling keys are ignored for forward compatibility.
    const auto projectVar = rootObj->getProperty(kProjectKey);
    if (!projectVar.isObject())
    {
        result.error = "Project file has no \"project\" object";
        return result;
    }

    // Resolve project-internal artifact paths (stored relative to the folder) back
    // to absolute against this file's location before decoding the tree.
    juce::var resolvedVar = projectVar;
    rewritePortablePaths(resolvedVar, file.getParentDirectory(), /*forSave=*/false);

    auto projectTree = ValueTreeJson::fromVar(resolvedVar);
    if (!projectTree.isValid())
    {
        result.error = "Failed to decode \"project\" object as a ValueTree";
        return result;
    }

    auto replaceResult = project.replaceTree(projectTree);
    if (!replaceResult.wasOk())
    {
        result.error = replaceResult.getErrorMessage();
        return result;
    }

    result.ok = true;
    return result;
}

} // namespace silverdaw::ProjectFile

