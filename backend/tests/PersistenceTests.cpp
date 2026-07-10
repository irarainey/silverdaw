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
#include "PeakJobCoordinator.h"
#include "PayloadHelpers.h"
#include "PeaksCache.h"
#include "WaveformCommands.h"
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

    const auto viewStateResult = silverdaw::ProjectFile::saveViewState(file, -10.0, 240.0, 99.0, "t1", true, true, true);
    require(viewStateResult.wasOk(), "saveViewState should update existing project file");
    silverdaw::ProjectState reloaded;
    require(silverdaw::ProjectFile::load(file, reloaded).ok, "reloading after view-state save should work");
    requireNear(reloaded.getViewScrollX(), 0.0, 0.0001, "saveViewState should clamp negative scroll");
    requireNear(reloaded.getViewPxPerSecond(), 240.0, 0.0001, "saveViewState should persist zoom");
    requireNear(reloaded.getPlayheadMs(), 99.0, 0.0001, "saveViewState should update playhead");
    requireEqual(reloaded.getViewSelectedTrack(), "t1", "saveViewState should persist selected track");
    require(reloaded.getViewFxPanelOpen(), "saveViewState should persist fx-panel-open flag");
    require(reloaded.getMetronomeEnabled(), "saveViewState should persist the metronome toggle (on)");
    require(reloaded.getClipEditorMetronomeEnabled(),
            "saveViewState should persist the clip-editor metronome toggle (on)");

    // Turning the metronomes off via the targeted view-state write must round-trip as off.
    const auto viewStateOff = silverdaw::ProjectFile::saveViewState(file, 0.0, 240.0, 99.0, "t1", true, false, false);
    require(viewStateOff.wasOk(), "saveViewState (metronome off) should update the project file");
    silverdaw::ProjectState reloadedOff;
    require(silverdaw::ProjectFile::load(file, reloadedOff).ok, "reloading after metronome-off save should work");
    require(! reloadedOff.getMetronomeEnabled(), "saveViewState should persist the metronome toggle (off)");
    require(! reloadedOff.getClipEditorMetronomeEnabled(),
            "saveViewState should persist the clip-editor metronome toggle (off)");

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

// A "clean up project files" removal prunes just the removed item from the saved file,
// in place, leaving every other saved item and field intact.
void testProjectFileRemoveLibraryItems()
{
    const auto dir = makeTempDir("prune-library");
    const auto file = dir.getChildFile("mix.silverdaw");

    silverdaw::ProjectState state;
    state.addTrack("t1");
    require(state.addLibraryItem("keep1", "C:\\audio\\a.wav", "a.wav", 1000.0, 48000, 2), "add keep1");
    require(state.addLibraryItem("gone", "C:\\proj\\samples\\S\\s.wav", "s.wav", 500.0, 48000, 2), "add gone");
    require(state.addLibraryItem("keep2", "C:\\audio\\b.wav", "b.wav", 750.0, 48000, 2), "add keep2");
    state.markClean();
    require(silverdaw::ProjectFile::save(file, state).wasOk(), "initial save should succeed");

    // Prune only "gone" from the saved file.
    const auto result = silverdaw::ProjectFile::removeLibraryItems(file, {"gone"});
    require(result.wasOk(), "removeLibraryItems should succeed");

    silverdaw::ProjectState loaded;
    require(silverdaw::ProjectFile::load(file, loaded).ok, "reload after prune should succeed");
    require(!loaded.getLibraryItemFilePath("keep1").isEmpty(), "keep1 should survive the prune");
    require(!loaded.getLibraryItemFilePath("keep2").isEmpty(), "keep2 should survive the prune");
    require(loaded.getLibraryItemFilePath("gone").isEmpty(), "the pruned item should be gone from the file");
    require(loaded.hasTrack("t1"), "unrelated content (the track) must be preserved");

    // No-op cases: absent item and a never-saved file both succeed without error.
    require(silverdaw::ProjectFile::removeLibraryItems(file, {"not-there"}).wasOk(),
            "pruning an absent item is a no-op success");
    const auto missing = dir.getChildFile("missing.silverdaw");
    require(silverdaw::ProjectFile::removeLibraryItems(missing, {"gone"}).wasOk(),
            "pruning an unsaved (missing) file is a no-op success");

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
    outside.setProperty("kind", "source", nullptr);
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
    const auto tempStems = silverdaw::projectArtifactsBaseDir(juce::String{}, "stems");
    requireEqual(tempStems.getFullPathName(),
                 silverdaw::tempArtifactsRoot().getChildFile("stems").getFullPathName(),
                 "unsaved artifacts live under the temp workspace");

    const auto projectDir = makeTempDir("artifacts-base");
    const auto projectFile = projectDir.getChildFile("Mix.silverdaw");
    const auto samples = silverdaw::projectArtifactsBaseDir(projectFile.getFullPathName(), "samples");
    requireEqual(samples.getFullPathName(), projectDir.getChildFile("samples").getFullPathName(),
                 "saved project keeps samples beside the project file");
    projectDir.deleteRecursively();
}

void testMigrateTempArtifactsIntoProject()
{
    const auto projectDir = makeTempDir("migrate-project");
    const auto projectFile = projectDir.getChildFile("Mix.silverdaw");

    // Seed a temp-workspace stem (WAV + sidecar) as if separated before first save.
    const auto tempRoot = silverdaw::tempArtifactsRoot();
    const auto tempStemDir = tempRoot.getChildFile("stems").getChildFile("song-stems");
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

    const auto movedDir = projectDir.getChildFile("stems").getChildFile("song-stems");
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

void testPeakJobCoordinatorCoalescesAndFansOut()
{
    silverdaw::PeakJobCoordinator coordinator;
    const juce::File source("C:\\audio\\loop.wav");

    const auto first = coordinator.addWaiter(
        source, 500, {silverdaw::PeakResponseTarget::timelineClip, "clip-1"});
    const auto second = coordinator.addWaiter(
        source, 500, {silverdaw::PeakResponseTarget::timelineClip, "clip-2"});
    const auto duplicate = coordinator.addWaiter(
        source, 500, {silverdaw::PeakResponseTarget::timelineClip, "clip-1"});
    const auto editor = coordinator.addWaiter(
        source, 500, {silverdaw::PeakResponseTarget::clipEditor, "library-1"});
    const auto highResolution = coordinator.addWaiter(
        source, 2000, {silverdaw::PeakResponseTarget::clipEditor, "library-1"});

    require(first.startsJob, "first source-resolution waiter should start a job");
    require(! second.startsJob && ! duplicate.startsJob && ! editor.startsJob,
            "matching source-resolution waiters should coalesce");
    require(highResolution.startsJob, "different peak resolution should start a separate job");

    const auto waiters = coordinator.takeWaiters(first.key);
    require(waiters.size() == 3, "coalesced job should retain distinct timeline and editor waiters");
    require(waiters[0].id == "clip-1" && waiters[1].id == "clip-2" && waiters[2].id == "library-1",
            "coalesced waiters should retain request order");

    const auto retry = coordinator.addWaiter(
        source, 500, {silverdaw::PeakResponseTarget::timelineClip, "clip-3"});
    require(retry.startsJob, "completed source-resolution key should permit a later retry");
    coordinator.takeWaiters(retry.key);
    coordinator.takeWaiters(highResolution.key);
}

void testClipAddWaveformRequestDefaultsToEnabled()
{
    auto* object = new juce::DynamicObject();
    juce::var payload(object);
    require(silverdaw::clipAddRequestsWaveform(payload), "missing requestWaveform defaults to true");

    object->setProperty("requestWaveform", false);
    require(!silverdaw::clipAddRequestsWaveform(payload), "explicit false skips waveform request");

    object->setProperty("requestWaveform", true);
    require(silverdaw::clipAddRequestsWaveform(payload), "explicit true requests waveform");

    object->setProperty("requestWaveform", "false");
    require(silverdaw::clipAddRequestsWaveform(payload), "invalid non-boolean value keeps safe default");
}

void testPeaksCacheConcurrentStoresRemainValid()
{
    const auto dir = makeTempDir("peaks-cache-concurrent");
    const auto source = dir.getChildFile("source.wav");
    require(source.replaceWithText("concurrent cache key source"), "concurrent source file should write");
    const silverdaw::PeaksCache cache(dir.getChildFile("cache"));

    silverdaw::waveform::PeaksResult result;
    result.peaksPerSecond = 500;
    result.sampleRate = 48000.0;
    result.laneCount = 3;
    result.peaks.resize(12000);
    for (std::size_t i = 0; i < result.peaks.size(); ++i)
    {
        result.peaks[i] = static_cast<float>(i % 101) / 100.0F;
    }

    std::atomic<bool> start{false};
    std::vector<std::thread> writers;
    for (int i = 0; i < 4; ++i)
    {
        writers.emplace_back([&]()
        {
            while (! start.load(std::memory_order_acquire))
            {
                std::this_thread::yield();
            }
            cache.store(source, result);
        });
    }
    start.store(true, std::memory_order_release);
    for (auto& writer : writers)
    {
        writer.join();
    }

    const auto loaded = cache.tryLoad(source, result.peaksPerSecond);
    require(loaded.peaks == result.peaks, "concurrent cache stores should leave one complete valid entry");
    const auto tempFiles = dir.getChildFile("cache").findChildFiles(juce::File::findFiles, false, "*.tmp");
    require(tempFiles.isEmpty(), "concurrent cache stores should not leave temporary files");
    dir.deleteRecursively();
}

void testLegacySampleModeMigratesToAudioType()
{
    juce::ValueTree project(juce::Identifier{"PROJECT"});
    project.setProperty("name", "Legacy", nullptr);

    juce::ValueTree library(juce::Identifier{"LIBRARY"});
    juce::ValueTree simple(juce::Identifier{"ITEM"});
    simple.setProperty("id", "legacySimple", nullptr);
    simple.setProperty("filePath", "C:\\audio\\fx.wav", nullptr);
    simple.setProperty("kind", "audio-file", nullptr);
    simple.setProperty("sampleMode", "sample", nullptr);
    library.appendChild(simple, nullptr);
    juce::ValueTree music(juce::Identifier{"ITEM"});
    music.setProperty("id", "legacyMusic", nullptr);
    music.setProperty("filePath", "C:\\audio\\loop.wav", nullptr);
    music.setProperty("kind", "audio-file", nullptr);
    music.setProperty("sampleMode", "music", nullptr);
    library.appendChild(music, nullptr);
    project.appendChild(library, nullptr);
    project.appendChild(juce::ValueTree(juce::Identifier{"MARKERS"}), nullptr);

    silverdaw::ProjectState state;
    state.replaceTree(project);

    const auto json = state.libraryAsJson();
    require(json.isArray() && json.getArray()->size() == 2, "migrated library should expose two items");
    for (const auto& item : *json.getArray())
    {
        const auto id = item.getProperty("id", {}).toString();
        require(!item.hasProperty("sampleMode"), "legacy sampleMode must not survive migration");
        if (id == "legacySimple")
            requireEqual(item.getProperty("audioType", {}).toString(), juce::String("simple"),
                         "legacy sampleMode 'sample' migrates to audioType 'simple'");
        else if (id == "legacyMusic")
            requireEqual(item.getProperty("audioType", {}).toString(), juce::String("music"),
                         "legacy sampleMode 'music' migrates to audioType 'music'");
    }
}

void testLegacyLibraryKindMigrates()
{
    juce::ValueTree project(juce::Identifier{"PROJECT"});
    project.setProperty("name", "LegacyKinds", nullptr);

    juce::ValueTree library(juce::Identifier{"LIBRARY"});
    // Legacy import with no source link → source.
    juce::ValueTree source(juce::Identifier{"ITEM"});
    source.setProperty("id", "legacySource", nullptr);
    source.setProperty("filePath", "C:\\audio\\song.wav", nullptr);
    source.setProperty("kind", "audio-file", nullptr);
    library.appendChild(source, nullptr);
    // Legacy saved-from-clip file (audio-file WITH a source link) → sample.
    juce::ValueTree sample(juce::Identifier{"ITEM"});
    sample.setProperty("id", "legacySample", nullptr);
    sample.setProperty("filePath", "C:\\proj\\samples\\hit.wav", nullptr);
    sample.setProperty("kind", "audio-file", nullptr);
    sample.setProperty("sourceItemId", "legacySource", nullptr);
    library.appendChild(sample, nullptr);
    // Legacy reusable clip → clip.
    juce::ValueTree clip(juce::Identifier{"ITEM"});
    clip.setProperty("id", "legacyClip", nullptr);
    clip.setProperty("filePath", "C:\\audio\\song.wav", nullptr);
    clip.setProperty("kind", "saved-clip", nullptr);
    clip.setProperty("sourceItemId", "legacySource", nullptr);
    library.appendChild(clip, nullptr);
    // Item with an absent kind → source.
    juce::ValueTree kindless(juce::Identifier{"ITEM"});
    kindless.setProperty("id", "legacyKindless", nullptr);
    kindless.setProperty("filePath", "C:\\audio\\other.wav", nullptr);
    library.appendChild(kindless, nullptr);
    project.appendChild(library, nullptr);
    project.appendChild(juce::ValueTree(juce::Identifier{"MARKERS"}), nullptr);

    silverdaw::ProjectState state;
    state.replaceTree(project);

    const auto json = state.libraryAsJson();
    require(json.isArray() && json.getArray()->size() == 4, "migrated library should expose four items");
    for (const auto& item : *json.getArray())
    {
        const auto id = item.getProperty("id", {}).toString();
        const auto kind = item.getProperty("kind", {}).toString();
        if (id == "legacySource")
            requireEqual(kind, juce::String("source"), "legacy audio-file with no source link migrates to source");
        else if (id == "legacySample")
            requireEqual(kind, juce::String("sample"), "legacy audio-file with a source link migrates to sample");
        else if (id == "legacyClip")
            requireEqual(kind, juce::String("clip"), "legacy saved-clip migrates to clip");
        else if (id == "legacyKindless")
            requireEqual(kind, juce::String("source"), "absent kind migrates to source");
    }
}

} // namespace

void addPersistenceTests(std::vector<TestCase>& tests)
{
    tests.push_back({"ValueTreeJson round-trip and validation", testValueTreeJsonRoundTripAndValidation});
    tests.push_back({"ProjectFile save/load and view-state update", testProjectFileSaveLoadAndViewState});
    tests.push_back({"ProjectFile prunes library items in place", testProjectFileRemoveLibraryItems});
    tests.push_back({"ProjectFile portable relative paths", testProjectFilePortablePaths});
    tests.push_back({"project artifacts base dir follows the project", testProjectArtifactsBaseDir});
    tests.push_back({"migrate temp artifacts into project folder", testMigrateTempArtifactsIntoProject});
    tests.push_back({"PeaksCache round-trip and validation", testPeaksCacheRoundTripAndValidation});
    tests.push_back({"Peak jobs coalesce and fan out", testPeakJobCoordinatorCoalescesAndFansOut});
    tests.push_back({"CLIP_ADD waveform request defaults to enabled", testClipAddWaveformRequestDefaultsToEnabled});
    tests.push_back({"PeaksCache concurrent stores remain valid", testPeaksCacheConcurrentStoresRemainValid});
    tests.push_back({"legacy sampleMode migrates to audioType", testLegacySampleModeMigratesToAudioType});
    tests.push_back({"legacy library kind migrates to source/sample/clip", testLegacyLibraryKindMigrates});
}

} // namespace silverdaw::tests
