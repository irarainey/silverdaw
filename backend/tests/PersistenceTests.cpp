// Persistence: ValueTree <-> JSON conversion, project file save/load with
// view-state, and the peaks cache binary round-trip + validation.

#include "TestRegistry.h"

#include "AudioEngine.h"
#include "AudioConstants.h"
#include "BridgeAuth.h"
#include "EdgeFadeSnapshot.h"
#include "LoudnessAnalyzer.h"
#include "Leveler.h"
#include "MixdownEngine.h"
#include "PayloadHelpers.h"
#include "PeaksCache.h"
#include "DecodedCache.h"
#include "ProjectFile.h"
#include "ProjectSession.h"
#include "ProjectState.h"
#include "SharedFx.h"
#include "ToneEq.h"
#include "ValueTreeJson.h"
#include "WarpProcessor.h"

#include <atomic>
#include <array>
#include <chrono>
#include <cmath>
#include <exception>
#include <limits>
#include <string>
#include <thread>
#include <vector>

#include <juce_events/juce_events.h>

namespace silverdaw::tests
{
namespace
{

void testValueTreeJsonRoundTripAndValidation()
{
    const auto tree = makeProjectTree();
    const auto encoded = silverdaw::ValueTreeJson::toVar(tree);
    require(encoded.isObject(), "toVar should encode a valid ValueTree as an object");
    const auto decoded = silverdaw::ValueTreeJson::fromVar(encoded);
    expectTreeEquivalent(decoded, tree);

    require(silverdaw::ValueTreeJson::toVar(juce::ValueTree()).isVoid(),
            "toVar should return void for invalid trees");
    require(!silverdaw::ValueTreeJson::fromVar(juce::var()).isValid(),
            "fromVar should reject non-object values");

    auto* missingType = new juce::DynamicObject();
    missingType->setProperty("id", "x");
    require(!silverdaw::ValueTreeJson::fromVar(juce::var(missingType)).isValid(),
            "fromVar should reject objects without $type");

    auto* invalidType = new juce::DynamicObject();
    invalidType->setProperty(silverdaw::ValueTreeJson::kTypeKey, "not valid");
    require(!silverdaw::ValueTreeJson::fromVar(juce::var(invalidType)).isValid(),
            "fromVar should reject invalid identifiers");
}

void testProjectFileSaveLoadAndViewState()
{
    const auto dir = makeTempDir("project-file");
    const auto file = dir.getChildFile("mix.silverdaw");

    silverdaw::ProjectState state;
    state.replaceTree(makeProjectTree());
    state.setViewScrollX(12.0);
    state.setPlayheadMs(34.0);
    state.setViewSelectedTrack("t1");
    state.setViewFxPanelOpen(true);
    // Rename a clip and confirm the user-facing name survives the
    // ValueTree JSON round-trip — this is the persistence the timeline
    // inline-rename relies on.
    require(state.setClipName("c1", "Verse chop"), "setClipName before save should succeed");
    state.markClean();

    const auto saveResult = silverdaw::ProjectFile::save(file, state);
    require(saveResult.wasOk(), "ProjectFile::save should succeed");
    require(file.existsAsFile(), "ProjectFile::save should create target file");

    juce::var savedRoot;
    require(juce::JSON::parse(file.loadFileAsString(), savedRoot).wasOk(), "saved project should parse");
    require(static_cast<int>(savedRoot.getProperty("schemaVersion", 0))
                == silverdaw::ProjectFile::kCurrentSchemaVersion,
            "saved project should include current schema");
    require(savedRoot.getProperty("savedAt", {}).isString(), "saved project should include savedAt");

    silverdaw::ProjectState loaded;
    const auto loadResult = silverdaw::ProjectFile::load(file, loaded);
    require(loadResult.ok, "ProjectFile::load should succeed");
    require(loadResult.schemaVersion == silverdaw::ProjectFile::kCurrentSchemaVersion,
            "load should report schema");
    expectTreeEquivalent(loaded.getTree(), state.getTree());
    require(!loaded.isDirty(), "loaded project should be clean");
    requireEqual(loaded.getClipName("c1"), "Verse chop", "clip name should persist through save/load");
    requireEqual(loaded.getViewSelectedTrack(), "t1", "selected track should persist through save/load");
    require(loaded.getViewFxPanelOpen(), "fx-panel-open flag should persist through save/load");

    const auto viewStateResult = silverdaw::ProjectFile::saveViewState(file, -10.0, 240.0, 99.0, "t1", true);
    require(viewStateResult.wasOk(), "saveViewState should update existing project file");
    silverdaw::ProjectState reloaded;
    require(silverdaw::ProjectFile::load(file, reloaded).ok, "reloading after view-state save should work");
    requireNear(reloaded.getViewScrollX(), 0.0, 0.0001, "saveViewState should clamp negative scroll");
    requireNear(reloaded.getViewPxPerSecond(), 240.0, 0.0001, "saveViewState should persist zoom");
    requireNear(reloaded.getPlayheadMs(), 99.0, 0.0001, "saveViewState should update playhead");
    requireEqual(reloaded.getViewSelectedTrack(), "t1", "saveViewState should persist selected track");
    require(reloaded.getViewFxPanelOpen(), "saveViewState should persist fx-panel-open flag");

    const auto missing = dir.getChildFile("missing.silverdaw");
    silverdaw::ProjectState untouched;
    untouched.addTrack("keep");
    untouched.markClean();
    const auto missingLoad = silverdaw::ProjectFile::load(missing, untouched);
    require(!missingLoad.ok && missingLoad.error.isNotEmpty(), "missing project load should fail with error");
    require(untouched.hasTrack("keep"), "failed load should leave project untouched");

    const auto badFile = dir.getChildFile("bad.silverdaw");
    require(badFile.replaceWithText("{ bad json"), "bad test file should write");
    const auto badLoad = silverdaw::ProjectFile::load(badFile, untouched);
    require(!badLoad.ok && badLoad.error.containsIgnoreCase("Malformed"), "malformed project should fail");

    dir.deleteRecursively();
}

// Project-internal artifact paths (inside the folder) save relative for portability;
// original sources outside the folder stay absolute and resolve unchanged.
void testProjectFilePortablePaths()
{
    const auto dir = makeTempDir("portable-paths");
    const auto file = dir.getChildFile("Mix.silverdaw");

    const juce::String insideAbs = dir.getChildFile("Samples").getChildFile("clip.wav").getFullPathName();
    const juce::String outsideAbs = "C:\\audio\\loop.wav";

    juce::ValueTree project(juce::Identifier{"PROJECT"});
    project.setProperty("name", "Portable", nullptr);

    juce::ValueTree library(juce::Identifier{"LIBRARY"});
    juce::ValueTree inside(juce::Identifier{"ITEM"});
    inside.setProperty("id", "libInside", nullptr);
    inside.setProperty("filePath", insideAbs, nullptr);
    inside.setProperty("kind", "sample", nullptr);
    library.appendChild(inside, nullptr);
    juce::ValueTree outside(juce::Identifier{"ITEM"});
    outside.setProperty("id", "libOutside", nullptr);
    outside.setProperty("filePath", outsideAbs, nullptr);
    outside.setProperty("kind", "audio-file", nullptr);
    library.appendChild(outside, nullptr);
    project.appendChild(library, nullptr);
    project.appendChild(juce::ValueTree(juce::Identifier{"MARKERS"}), nullptr);

    silverdaw::ProjectState state;
    state.replaceTree(project);
    state.markClean();

    require(silverdaw::ProjectFile::save(file, state).wasOk(), "portable save should succeed");

    // JSON escapes backslashes; compare against the escaped form of each path.
    const auto json = file.loadFileAsString();
    require(!json.contains(insideAbs.replace("\\", "\\\\")),
            "internal artifact path should be stored relative, not absolute");
    require(json.contains("Samples"), "internal artifact should keep its relative subfolder");
    require(json.contains(outsideAbs.replace("\\", "\\\\")),
            "external source path should stay absolute on disk");

    silverdaw::ProjectState loaded;
    require(silverdaw::ProjectFile::load(file, loaded).ok, "portable load should succeed");
    requireEqual(loaded.getLibraryItemFilePath("libInside"), insideAbs,
                 "internal artifact path should resolve back to absolute on load");
    requireEqual(loaded.getLibraryItemFilePath("libOutside"), outsideAbs,
                 "external source path should remain absolute on load");

    dir.deleteRecursively();
}

void testProjectArtifactsBaseDir()
{
    // Unsaved -> temp workspace; saved -> a subfolder beside the project file.
    const auto tempStems = silverdaw::projectArtifactsBaseDir(juce::String{}, "Stems");
    requireEqual(tempStems.getFullPathName(),
                 silverdaw::tempArtifactsRoot().getChildFile("Stems").getFullPathName(),
                 "unsaved artifacts live under the temp workspace");

    const auto projectDir = makeTempDir("artifacts-base");
    const auto projectFile = projectDir.getChildFile("Mix.silverdaw");
    const auto samples = silverdaw::projectArtifactsBaseDir(projectFile.getFullPathName(), "Samples");
    requireEqual(samples.getFullPathName(), projectDir.getChildFile("Samples").getFullPathName(),
                 "saved project keeps samples beside the project file");
    projectDir.deleteRecursively();
}

void testMigrateTempArtifactsIntoProject()
{
    const auto projectDir = makeTempDir("migrate-project");
    const auto projectFile = projectDir.getChildFile("Mix.silverdaw");

    // Seed a temp-workspace stem (WAV + sidecar) as if separated before first save.
    const auto tempRoot = silverdaw::tempArtifactsRoot();
    const auto tempStemDir = tempRoot.getChildFile("Stems").getChildFile("song-stems");
    require(tempStemDir.createDirectory().wasOk(), "temp stem dir should create");
    const auto tempStemWav = tempStemDir.getChildFile("vocals.wav");
    require(tempStemWav.replaceWithText("placeholder stem audio"), "temp stem file should write");
    require(tempStemDir.getChildFile("metadata.json").replaceWithText("{}"), "temp sidecar should write");

    const juce::String outsideAbs = "C:\\audio\\loop.wav";

    juce::ValueTree project(juce::Identifier{"PROJECT"});
    project.setProperty("name", "Migrate", nullptr);
    juce::ValueTree library(juce::Identifier{"LIBRARY"});
    juce::ValueTree stem(juce::Identifier{"ITEM"});
    stem.setProperty("id", "libStem", nullptr);
    stem.setProperty("filePath", tempStemWav.getFullPathName(), nullptr);
    stem.setProperty("playbackFilePath", tempStemWav.getFullPathName(), nullptr);
    library.appendChild(stem, nullptr);
    juce::ValueTree outside(juce::Identifier{"ITEM"});
    outside.setProperty("id", "libOutside", nullptr);
    outside.setProperty("filePath", outsideAbs, nullptr);
    library.appendChild(outside, nullptr);
    project.appendChild(library, nullptr);
    project.appendChild(juce::ValueTree(juce::Identifier{"MARKERS"}), nullptr);

    silverdaw::ProjectState state;
    state.replaceTree(project);

    silverdaw::AudioEngine engine;
    engine.initialise({}, {}, nullptr);
    juce::ThreadPool pool;
    silverdaw::DecodedCache decodedCache;

    silverdaw::migrateTempArtifactsIntoProject(projectFile.getFullPathName(), engine, state, pool,
                                               decodedCache);

    const auto movedDir = projectDir.getChildFile("Stems").getChildFile("song-stems");
    require(movedDir.getChildFile("vocals.wav").existsAsFile(), "stem WAV should move beside the project");
    require(movedDir.getChildFile("metadata.json").existsAsFile(),
            "stem sidecar should move with the stem folder");
    require(! tempRoot.isDirectory(), "temp workspace should be purged after migration");
    requireEqual(state.getLibraryItemFilePath("libStem"),
                 movedDir.getChildFile("vocals.wav").getFullPathName(),
                 "stem filePath should be rewritten beside the project");
    requireEqual(state.getLibraryItemPlaybackPath("libStem"),
                 movedDir.getChildFile("vocals.wav").getFullPathName(),
                 "stem playbackFilePath should be rewritten beside the project");
    requireEqual(state.getLibraryItemFilePath("libOutside"), outsideAbs,
                 "external source path should stay absolute through migration");

    engine.shutdown();
    projectDir.deleteRecursively();
}

void testPeaksCacheRoundTripAndValidation()
{
    const auto dir = makeTempDir("peaks-cache");
    const auto source = dir.getChildFile("source.wav");
    require(source.replaceWithText("not real audio, just a cache key source"), "source file should write");

    const silverdaw::PeaksCache cache(dir.getChildFile("cache"));

    silverdaw::waveform::PeaksResult result;
    result.peaksPerSecond = 200;
    result.sampleRate = 44100.0;
    result.peaks = {-0.5F, 0.25F, -1.0F, 1.0F};
    cache.store(source, result);

    const auto cacheFile = cache.getCacheFilePath(source, 200);
    require(cacheFile.existsAsFile(), "cache store should create a cache file");

    const auto loaded = cache.tryLoad(source, 200);
    require(loaded.peaks.size() == result.peaks.size(), "cache load should restore peak count");
    requireNear(loaded.sampleRate, 44100.0, 0.0001, "cache load should restore sample rate");
    require(loaded.peaksPerSecond == 200, "cache load should restore peaks-per-second");
    for (std::size_t i = 0; i < result.peaks.size(); ++i)
    {
        requireNear(loaded.peaks[i], result.peaks[i], 0.0001, "cache load should restore peak data");
    }

    require(cache.tryLoad(source, 100).peaks.empty(), "different peak resolution should miss");

    // Stereo (multi-lane) round-trip: lane 0 summary + lanes 1/2 L/R,
    // stored channel-major. `peakCount` in the header is per-lane.
    silverdaw::waveform::PeaksResult stereo;
    stereo.peaksPerSecond = 200;
    stereo.sampleRate = 48000.0;
    stereo.laneCount = 3;
    // 2 buckets per lane × 3 lanes × (min,max): [summary..][L..][R..]
    stereo.peaks = {-0.1F, 0.1F, -0.2F, 0.2F, // summary
                    -0.5F, 0.5F, -0.6F, 0.6F, // left
                    -0.7F, 0.7F, -0.8F, 0.8F}; // right
    const auto stereoSource = dir.getChildFile("stereo.wav");
    require(stereoSource.replaceWithText("stereo cache key source"), "stereo source should write");
    cache.store(stereoSource, stereo);
    const auto loadedStereo = cache.tryLoad(stereoSource, 200);
    require(loadedStereo.laneCount == 3, "stereo cache load should restore lane count");
    require(loadedStereo.peaks.size() == stereo.peaks.size(), "stereo cache load should restore all lanes");
    require(loadedStereo.bucketsPerLane() == 2, "stereo cache load should report per-lane bucket count");
    for (std::size_t i = 0; i < stereo.peaks.size(); ++i)
    {
        requireNear(loadedStereo.peaks[i], stereo.peaks[i], 0.0001, "stereo cache load should restore lane data");
    }

    const auto corrupt = cache.getCacheFilePath(source, 300);
    require(corrupt.replaceWithData("short", 5), "corrupt cache fixture should write");
    require(cache.tryLoad(source, 300).peaks.empty(), "short cache file should be treated as miss");

    dir.deleteRecursively();
}

} // namespace

void addPersistenceTests(std::vector<TestCase>& tests)
{
    tests.push_back({"ValueTreeJson round-trip and validation", testValueTreeJsonRoundTripAndValidation});
    tests.push_back({"ProjectFile save/load and view-state update", testProjectFileSaveLoadAndViewState});
    tests.push_back({"ProjectFile portable relative paths", testProjectFilePortablePaths});
    tests.push_back({"project artifacts base dir follows the project", testProjectArtifactsBaseDir});
    tests.push_back({"migrate temp artifacts into project folder", testMigrateTempArtifactsIntoProject});
    tests.push_back({"PeaksCache round-trip and validation", testPeaksCacheRoundTripAndValidation});
}

} // namespace silverdaw::tests
