// Backend-side deletion of a removed library item's generated stem/sample files.
// Every path is confined to the project's stems/samples artifact trees, and a
// per-source folder is pruned once its last file is gone — so a user's original
// imported source can never be removed.

#include "TestRegistry.h"

#include "AudioEngine.h"
#include "LibraryCommands.h"
#include "ProjectSession.h"

#include <juce_core/juce_core.h>

namespace silverdaw::tests
{
namespace
{

// A shared engine with no preview loaded — releaseReadersForFile is then a no-op, so
// these filesystem tests exercise the delete/prune path directly.
silverdaw::AudioEngine& testEngine()
{
    static silverdaw::AudioEngine engine;
    return engine;
}

// Build a `{ paths: [...] }` envelope payload for handleLibraryDeleteArtifacts.
juce::var pathsPayload(const juce::StringArray& paths)
{
    juce::Array<juce::var> arr;
    for (const auto& p : paths) arr.add(p);
    auto* obj = new juce::DynamicObject();
    obj->setProperty("paths", juce::var(arr));
    return juce::var(obj);
}

void writeStub(const juce::File& f)
{
    f.getParentDirectory().createDirectory();
    const auto created = f.create();
    require(created.wasOk(), "failed to create stub file");
    require(f.existsAsFile(), "stub file should exist after creation");
}

silverdaw::ProjectSession sessionFor(const juce::File& projectDir)
{
    silverdaw::ProjectSession session;
    // The artifact roots derive from the project FILE's parent directory.
    session.currentPath = projectDir.getChildFile("proj.silverdaw").getFullPathName();
    return session;
}

void testDeleteArtifactsPrunesEmptiedFolder()
{
    const auto projectDir = makeTempDir("cleanup-prune");
    const auto session = sessionFor(projectDir);

    const auto stemsRoot = projectDir.getChildFile("stems");
    const auto sourceDir = stemsRoot.getChildFile("Song-stems");
    const auto vocals = sourceDir.getChildFile("vocals.wav");
    const auto drums = sourceDir.getChildFile("drums.wav");
    writeStub(vocals);
    writeStub(drums);

    // First delete: the file is gone but the folder is kept (still holds a stem).
    silverdaw::handleLibraryDeleteArtifacts(pathsPayload({vocals.getFullPathName()}), session, testEngine());
    require(! vocals.existsAsFile(), "vocals.wav should be deleted");
    require(sourceDir.isDirectory(), "per-source folder kept while it still holds a stem");

    // Last delete: the file is gone AND the now-empty folder is pruned; root survives.
    silverdaw::handleLibraryDeleteArtifacts(pathsPayload({drums.getFullPathName()}), session, testEngine());
    require(! drums.existsAsFile(), "drums.wav should be deleted");
    require(! sourceDir.exists(), "emptied per-source folder should be pruned");
    require(stemsRoot.isDirectory(), "the stems root itself must never be removed");

    projectDir.deleteRecursively();
}

void testDeleteArtifactsPrunesWhenAllFilesGoInOneCall()
{
    const auto projectDir = makeTempDir("cleanup-batch");
    const auto session = sessionFor(projectDir);

    const auto samplesRoot = projectDir.getChildFile("samples");
    const auto sourceDir = samplesRoot.getChildFile("My Song");
    const auto a = sourceDir.getChildFile("My Song-sample-001.wav");
    const auto b = sourceDir.getChildFile("My Song-sample-002.wav");
    writeStub(a);
    writeStub(b);

    silverdaw::handleLibraryDeleteArtifacts(pathsPayload({a.getFullPathName(), b.getFullPathName()}), session, testEngine());
    require(! sourceDir.exists(), "folder pruned when its last files are deleted together");
    require(samplesRoot.isDirectory(), "the samples root itself must never be removed");

    projectDir.deleteRecursively();
}

void testDeleteArtifactsKeepsFolderWithForeignFile()
{
    const auto projectDir = makeTempDir("cleanup-foreign");
    const auto session = sessionFor(projectDir);

    const auto sourceDir = projectDir.getChildFile("samples").getChildFile("Mixed");
    const auto ours = sourceDir.getChildFile("ours-sample-001.wav");
    const auto foreign = sourceDir.getChildFile("user-notes.txt");
    writeStub(ours);
    writeStub(foreign);

    silverdaw::handleLibraryDeleteArtifacts(pathsPayload({ours.getFullPathName()}), session, testEngine());
    require(! ours.existsAsFile(), "our sample WAV should be deleted");
    require(foreign.existsAsFile(), "an unrelated file must be preserved");
    require(sourceDir.isDirectory(), "folder kept while it still holds a foreign file");

    projectDir.deleteRecursively();
}

void testDeleteArtifactsRemovesReadOnlyFolder()
{
    const auto projectDir = makeTempDir("cleanup-readonly");
    const auto session = sessionFor(projectDir);

    // A sync client (OneDrive) stamps the per-source folder READ-ONLY, which makes
    // Windows deny RemoveDirectory. The handler must clear that before removing it.
    const auto sourceDir = projectDir.getChildFile("samples").getChildFile("Synced Song");
    const auto wav = sourceDir.getChildFile("Synced Song-sample-001.wav");
    writeStub(wav);
    sourceDir.setReadOnly(true, /*applyRecursively*/ false);

    silverdaw::handleLibraryDeleteArtifacts(pathsPayload({wav.getFullPathName()}), session, testEngine());
    require(! wav.existsAsFile(), "the sample WAV should be deleted");
    require(! sourceDir.exists(), "a read-only per-source folder must still be removed");

    projectDir.deleteRecursively();
}

void testDeleteArtifactsRefusesOutsideRoots()
{
    const auto projectDir = makeTempDir("cleanup-outside");
    const auto session = sessionFor(projectDir);

    // A user's original import living beside the project, NOT under stems/samples.
    const auto original = projectDir.getChildFile("original.wav");
    writeStub(original);

    silverdaw::handleLibraryDeleteArtifacts(pathsPayload({original.getFullPathName()}), session, testEngine());
    require(original.existsAsFile(), "a path outside the artifact roots must never be deleted");

    projectDir.deleteRecursively();
}

} // namespace

void addLibraryCleanupTests(std::vector<TestCase>& tests)
{
    tests.push_back({"delete artifacts prunes an emptied per-source folder", testDeleteArtifactsPrunesEmptiedFolder});
    tests.push_back({"delete artifacts prunes when all files go in one call",
                     testDeleteArtifactsPrunesWhenAllFilesGoInOneCall});
    tests.push_back({"delete artifacts keeps a folder holding a foreign file",
                     testDeleteArtifactsKeepsFolderWithForeignFile});
    tests.push_back({"delete artifacts removes a read-only (synced) folder",
                     testDeleteArtifactsRemovesReadOnlyFolder});
    tests.push_back(
        {"delete artifacts refuses paths outside the artifact roots", testDeleteArtifactsRefusesOutsideRoots});
}

} // namespace silverdaw::tests
