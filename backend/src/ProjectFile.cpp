#include "ProjectFile.h"

#include "ValueTreeJson.h"

namespace silverdaw::ProjectFile
{

namespace
{

constexpr const char* kSchemaVersionKey = "schemaVersion";
constexpr const char* kAppVersionKey = "appVersion";
constexpr const char* kSavedAtKey = "savedAt";
constexpr const char* kProjectKey = "project";
constexpr const char* kAppVersionValue = "1.0.0";

/** ISO-8601 (millisecond precision, UTC) timestamp for `savedAt`. */
juce::String isoTimestampNowUtc()
{
    return juce::Time::getCurrentTime().toISO8601(true);
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

    // Build the outer wrapper:
    //   { schemaVersion, appVersion, savedAt, project: <tree-as-json> }
    auto* rootObj = new juce::DynamicObject();
    rootObj->setProperty(kSchemaVersionKey, kCurrentSchemaVersion);
    rootObj->setProperty(kAppVersionKey, kAppVersionValue);
    rootObj->setProperty(kSavedAtKey, isoTimestampNowUtc());

    const auto projectVar = ValueTreeJson::toVar(projectTree);
    if (projectVar.isVoid())
    {
        return juce::Result::fail("Failed to serialise project tree to JSON");
    }
    rootObj->setProperty(kProjectKey, projectVar);

    return writeProjectJsonAtomically(file, juce::var(rootObj));
}

juce::Result saveViewState(const juce::File& file, double viewScrollX, double playheadMs)
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
    projectObj->setProperty("playheadMs", juce::jmax(0.0, playheadMs));
    rootObj->setProperty(kProjectKey, projectVar);

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

    // Schema version gating. A file from a newer build of Silverdaw is
    // refused; an older version falls through to the migration path
    // (no migrations exist yet — v1 is the only format).
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

    // Find the "project" sub-object. Unknown sibling keys (future
    // transport / library / UI chunks) are ignored at this stage —
    // they get their own loader hooks in later todos.
    const auto projectVar = rootObj->getProperty(kProjectKey);
    if (!projectVar.isObject())
    {
        result.error = "Project file has no \"project\" object";
        return result;
    }

    auto projectTree = ValueTreeJson::fromVar(projectVar);
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

