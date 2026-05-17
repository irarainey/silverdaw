#include "ProjectFile.h"

namespace silverdaw::ProjectFile
{

namespace
{

constexpr const char* kSchemaVersionAttr = "schemaVersion";
constexpr const char* kAppVersionAttr = "appVersion";
constexpr const char* kSavedAtAttr = "savedAt";
constexpr const char* kAppVersionValue = "1.0.0";

/** ISO-8601 (millisecond precision, UTC) timestamp for `savedAt`. */
juce::String isoTimestampNowUtc()
{
    return juce::Time::getCurrentTime().toISO8601(true);
}

} // namespace

juce::Result save(const juce::File& file, const ProjectState& project)
{
    const auto& projectTree = project.getTree();
    if (!projectTree.isValid())
    {
        return juce::Result::fail("Project state has no valid root");
    }

    // Build the outer wrapper: <SilverdawProject schemaVersion=... appVersion=... savedAt=...>
    juce::XmlElement root(kRootElementName);
    root.setAttribute(kSchemaVersionAttr, kCurrentSchemaVersion);
    root.setAttribute(kAppVersionAttr, kAppVersionValue);
    root.setAttribute(kSavedAtAttr, isoTimestampNowUtc());

    // The PROJECT ValueTree is serialised verbatim and attached as the
    // first child. Future state extensions (transport, library, UI) go
    // alongside it as siblings, each in its own element.
    auto projectXml = projectTree.createXml();
    if (projectXml == nullptr)
    {
        return juce::Result::fail("Failed to serialise project tree to XML");
    }
    root.addChildElement(projectXml.release());

    const auto& target = file.getFullPathName();
    if (target.isEmpty())
    {
        return juce::Result::fail("Save target path is empty");
    }

    // Write to a sibling temp file then rename, so a partial write can
    // never destroy the previous good copy on disk.
    const juce::File tempFile = file.getSiblingFile(file.getFileName() + ".tmp");
    if (tempFile.existsAsFile())
    {
        tempFile.deleteFile();
    }

    if (!tempFile.create().wasOk())
    {
        return juce::Result::fail("Cannot create temp file " + tempFile.getFullPathName());
    }

    juce::XmlElement::TextFormat format;
    format.addDefaultHeader = true;
    format.newLineChars = "\n";
    const auto xmlString = root.toString(format);

    if (!tempFile.replaceWithText(xmlString))
    {
        tempFile.deleteFile();
        return juce::Result::fail("Failed to write project XML to " + tempFile.getFullPathName());
    }

    if (file.existsAsFile())
    {
        file.deleteFile();
    }
    if (!tempFile.moveFileTo(file))
    {
        // Leave the temp file behind for diagnostics; the previous good
        // copy (if any) was already deleted, which is unfortunate, but
        // the user can recover by renaming the .tmp manually.
        return juce::Result::fail("Failed to rename temp file to " + file.getFullPathName());
    }

    return juce::Result::ok();
}

LoadResult load(const juce::File& file, ProjectState& project)
{
    LoadResult result;

    if (!file.existsAsFile())
    {
        result.error = "File does not exist: " + file.getFullPathName();
        return result;
    }

    juce::XmlDocument doc(file);
    auto root = doc.getDocumentElement();
    if (root == nullptr)
    {
        result.error = "Malformed project file: " + doc.getLastParseError();
        return result;
    }

    if (!root->hasTagName(kRootElementName))
    {
        result.error = juce::String("Not a Silverdaw project file (root element <")
                       + root->getTagName() + "> expected <" + kRootElementName + ">)";
        return result;
    }

    // Schema version gating. A file from a newer build of Silverdaw is
    // refused; an older version falls through to the migration path
    // (no migrations exist yet — v1 is the only format).
    result.schemaVersion = root->getIntAttribute(kSchemaVersionAttr, 0);
    if (result.schemaVersion <= 0)
    {
        result.error = "Project file is missing a valid schemaVersion attribute";
        return result;
    }
    if (result.schemaVersion > kCurrentSchemaVersion)
    {
        result.error = juce::String("Project was saved by a newer Silverdaw (schemaVersion ")
                       + juce::String(result.schemaVersion) + " > " + juce::String(kCurrentSchemaVersion)
                       + "). Upgrade Silverdaw to open this file.";
        return result;
    }

    // Find the PROJECT element. `getChildByName` returns nullptr if missing.
    // Unknown sibling elements (future Transport / Library / Ui chunks) are
    // ignored at this stage — they get their own loader hooks in later todos.
    const auto* projectXml = root->getChildByName("PROJECT");
    if (projectXml == nullptr)
    {
        result.error = "Project file has no <PROJECT> element";
        return result;
    }

    auto projectTree = juce::ValueTree::fromXml(*projectXml);
    if (!projectTree.isValid())
    {
        result.error = "Failed to decode <PROJECT> element as a ValueTree";
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
