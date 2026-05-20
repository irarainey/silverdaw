#include "BridgeAuth.h"
#include "PeaksCache.h"
#include "ProjectFile.h"
#include "ProjectState.h"
#include "ValueTreeJson.h"

#include <cmath>
#include <exception>
#include <functional>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include <juce_events/juce_events.h>

namespace
{

using TestFn = std::function<void()>;

struct TestCase
{
    const char* name;
    TestFn fn;
};

void require(bool condition, const char* message)
{
    if (!condition)
    {
        throw std::runtime_error(message);
    }
}

void requireEqual(const juce::String& actual, const juce::String& expected, const char* message)
{
    if (actual != expected)
    {
        throw std::runtime_error(std::string(message) + " (actual='" + actual.toStdString() + "', expected='"
                                 + expected.toStdString() + "')");
    }
}

void requireNear(double actual, double expected, double epsilon, const char* message)
{
    if (std::abs(actual - expected) > epsilon)
    {
        throw std::runtime_error(std::string(message) + " (actual=" + std::to_string(actual)
                                 + ", expected=" + std::to_string(expected) + ")");
    }
}

juce::File makeTempDir(const juce::String& name)
{
    auto dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                   .getChildFile("SilverdawBackendTests")
                   .getChildFile(name + "-" + juce::Uuid().toString());
    const auto created = dir.createDirectory();
    if (created.failed())
    {
        throw std::runtime_error("failed to create temp dir: " + created.getErrorMessage().toStdString());
    }
    return dir;
}

juce::var objectWithToken(const juce::String& token)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("token", token);
    return juce::var(obj);
}

juce::ValueTree makeProjectTree()
{
    juce::ValueTree project(juce::Identifier{"PROJECT"});
    project.setProperty("name", "Roundtrip", nullptr);
    project.setProperty("bpm", 123.45, nullptr);

    juce::ValueTree track(juce::Identifier{"TRACK"});
    track.setProperty("id", "t1", nullptr);
    track.setProperty("name", "Drums", nullptr);
    track.setProperty("gain", 0.75, nullptr);

    juce::ValueTree clip(juce::Identifier{"CLIP"});
    clip.setProperty("id", "c1", nullptr);
    clip.setProperty("filePath", "C:\\audio\\loop.wav", nullptr);
    clip.setProperty("offsetMs", 1000.0, nullptr);
    clip.setProperty("inMs", 250.0, nullptr);
    clip.setProperty("durationMs", 4000.0, nullptr);
    clip.setProperty("colorIndex", 3, nullptr);
    track.appendChild(clip, nullptr);

    project.appendChild(track, nullptr);
    return project;
}

void expectTreeEquivalent(const juce::ValueTree& actual, const juce::ValueTree& expected)
{
    const auto actualJson = juce::JSON::toString(silverdaw::ValueTreeJson::toVar(actual), true);
    const auto expectedJson = juce::JSON::toString(silverdaw::ValueTreeJson::toVar(expected), true);
    requireEqual(actualJson, expectedJson, "ValueTree JSON mismatch");
}

void testProjectStateTracksClipsAndDirty()
{
    silverdaw::ProjectState state;
    int dirtyTransitions = 0;
    bool lastDirty = false;
    state.setDirtyChangedCallback(
        [&](bool dirty)
        {
            ++dirtyTransitions;
            lastDirty = dirty;
        });

    require(!state.isDirty(), "fresh project should be clean");
    requireEqual(state.getName(), "Untitled", "fresh project name");

    require(state.addTrack("t1"), "addTrack should accept a new id");
    require(state.hasTrack("t1"), "track should exist after add");
    require(state.isDirty(), "addTrack should mark dirty");
    require(dirtyTransitions == 1 && lastDirty, "dirty callback should fire once");
    require(state.addTrack("t1"), "addTrack should be idempotent");

    require(state.setTrackName("t1", "  Drums  "), "setTrackName should trim valid names");
    require(!state.setTrackName("t1", "   "), "blank track names should be rejected");
    require(state.setTrackGain("t1", 0.5F), "setTrackGain should update an existing track");
    requireNear(state.getTrackGain("t1"), 0.5, 0.0001, "track gain should round-trip");

    require(state.addClip("t1", "c1", "C:\\audio\\a.wav", 100.0, 1000.0, 25.0, 2),
            "addClip should add under an existing track");
    require(!state.addClip("missing", "c2", "C:\\audio\\b.wav", 0.0, 1000.0),
            "addClip should reject unknown tracks");
    require(!state.addClip("t1", "c1", "C:\\audio\\b.wav", 0.0, 1000.0),
            "addClip should reject duplicate clip ids");
    requireEqual(state.getClipTrackId("c1"), "t1", "clip should report its owning track");
    requireEqual(state.getClipFilePath("c1"), "C:\\audio\\a.wav", "clip path should round-trip");
    requireNear(state.getClipInMs("c1"), 25.0, 0.0001, "clip inMs should round-trip");

    require(state.addTrack("t2"), "second track should add");
    require(state.setClipTrack("c1", "t2"), "clip should move between tracks");
    requireEqual(state.getClipTrackId("c1"), "t2", "clip owner should update after reparent");
    require(state.setClipTrim("c1", 500.0, 100.0, 900.0), "clip trim should update atomically");
    requireNear(state.getClipInMs("c1"), 100.0, 0.0001, "trimmed inMs should update");
    requireNear(state.getClipDurationMs("c1"), 900.0, 0.0001, "trimmed duration should update");
    require(state.setClipColorIndex("c1", -1), "negative color should clear override");
    require(state.setClipFilePath("c1", "C:\\audio\\relinked.wav"), "clip relink should update path");

    const auto removedIds = state.removeTrack("t2");
    require(removedIds.size() == 1 && removedIds[0] == "c1", "removeTrack should return removed clip ids");
    require(!state.removeClip("c1"), "removed clip should no longer exist");

    state.markClean();
    require(!state.isDirty(), "markClean should reset dirty");
    require(dirtyTransitions >= 2 && !lastDirty, "dirty callback should report clean transition");
}

void testProjectStateViewLibraryMarkersAndReplace()
{
    silverdaw::ProjectState state;
    state.addTrack("t1");
    state.markClean();

    state.setViewPxPerSecond(160.0);
    state.setViewScrollX(240.0);
    state.setPlayheadMs(1234.0);
    require(!state.isDirty(), "view state should not mark project dirty");
    requireNear(state.getViewPxPerSecond(), 160.0, 0.0001, "view zoom should store");
    requireNear(state.getViewScrollX(), 240.0, 0.0001, "view scroll should store");
    requireNear(state.getPlayheadMs(), 1234.0, 0.0001, "playhead should store");

    state.setBpm(128.0);
    state.setProjectLengthMs(180000.0);
    require(state.isDirty(), "tempo/length should mark dirty");
    requireNear(state.getBpm(), 128.0, 0.0001, "bpm should store");
    requireNear(state.getProjectLengthMs(), 180000.0, 0.0001, "project length should store");

    require(state.addLibraryItem("l1", "C:\\audio\\source.wav", "source.wav", 2000.0, 48000, 2,
                                 "C:\\cache\\source.wav", "Bb minor"),
            "library item should add");
    require(state.hasLibraryItemForPath("C:\\audio\\source.wav"), "library item should be found by path");
    requireEqual(state.getLibraryItemPlaybackPathForSource("C:\\audio\\source.wav"), "C:\\cache\\source.wav",
                 "library playback path should round-trip");
    require(state.setLibraryItemBpm("l1", 124.5), "library bpm should set");
    require(state.setLibraryItemBeats("l1", {0.25, 0.75, 1.25}), "library beats should set");
    require(state.setLibraryItemBeatAnchor("l1", 0.25), "library beat anchor should set");
    require(state.setLibraryItemVariableTempo("l1", true), "library variable tempo should set");
    requireNear(state.getLibraryItemBpmForPath("C:\\audio\\source.wav"), 124.5, 0.0001,
                "library bpm should be found by source path");

    const auto library = state.libraryAsJson();
    require(library.isArray() && library.getArray()->size() == 1, "libraryAsJson should return one item");
    const auto& firstItem = library.getArray()->getReference(0);
    require(firstItem.getProperty("beats", {}).isArray(), "libraryAsJson should include beats array");
    require(bool(firstItem.getProperty("variableTempo", false)), "libraryAsJson should include variableTempo");

    require(state.addMarker("m2", 2000.0), "marker should add");
    require(state.addMarker("m1", 1000.0), "second marker should add");
    require(!state.moveMarker("m1", -1.0), "negative marker move should fail");
    require(state.moveMarker("m1", 1500.0), "marker should move");
    require(!state.moveMarker("m1", 2000.0), "marker should not move onto occupied marker");
    const auto markers = state.markersAsJson();
    require(markers.isArray() && markers.getArray()->size() == 2, "markersAsJson should return markers");
    require(state.removeMarker("m1"), "marker should remove");

    const auto replacement = makeProjectTree();
    const auto replaceResult = state.replaceTree(replacement);
    require(replaceResult.wasOk(), "replaceTree should accept PROJECT roots");
    require(!state.isDirty(), "replaceTree should leave project clean");
    expectTreeEquivalent(state.getTree(), replacement);

    juce::ValueTree wrongRoot(juce::Identifier{"TRACK"});
    require(state.replaceTree(wrongRoot).failed(), "replaceTree should reject non-PROJECT roots");
}

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

    const auto viewStateResult = silverdaw::ProjectFile::saveViewState(file, -10.0, 99.0);
    require(viewStateResult.wasOk(), "saveViewState should update existing project file");
    silverdaw::ProjectState reloaded;
    require(silverdaw::ProjectFile::load(file, reloaded).ok, "reloading after view-state save should work");
    requireNear(reloaded.getViewScrollX(), 0.0, 0.0001, "saveViewState should clamp negative scroll");
    requireNear(reloaded.getPlayheadMs(), 99.0, 0.0001, "saveViewState should update playhead");

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

    const auto corrupt = cache.getCacheFilePath(source, 300);
    require(corrupt.replaceWithData("short", 5), "corrupt cache fixture should write");
    require(cache.tryLoad(source, 300).peaks.empty(), "short cache file should be treated as miss");

    dir.deleteRecursively();
}

void testBridgeAuthTokenValidation()
{
    using silverdaw::bridge_auth::isTokenValid;

    require(isTokenValid({}, juce::var()), "empty expected token should disable auth");
    require(isTokenValid("abc123", objectWithToken("abc123")), "matching token should pass");
    require(!isTokenValid("abc123", objectWithToken("abc124")), "same-length mismatch should fail");
    require(!isTokenValid("abc123", objectWithToken("abc1234")), "length mismatch should fail");

    auto* missingToken = new juce::DynamicObject();
    missingToken->setProperty("other", "abc123");
    require(!isTokenValid("abc123", juce::var(missingToken)), "missing token should fail");
    require(!isTokenValid("abc123", juce::var()), "non-object payload should fail");
}

} // namespace

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    const std::vector<TestCase> tests{
        {"ProjectState tracks, clips, and dirty tracking", testProjectStateTracksClipsAndDirty},
        {"ProjectState view, library, markers, and replaceTree", testProjectStateViewLibraryMarkersAndReplace},
        {"ValueTreeJson round-trip and validation", testValueTreeJsonRoundTripAndValidation},
        {"ProjectFile save/load and view-state update", testProjectFileSaveLoadAndViewState},
        {"PeaksCache round-trip and validation", testPeaksCacheRoundTripAndValidation},
        {"Bridge auth token validation", testBridgeAuthTokenValidation},
    };

    int failed = 0;
    for (const auto& test : tests)
    {
        try
        {
            test.fn();
            std::cout << "[PASS] " << test.name << '\n';
        }
        catch (const std::exception& ex)
        {
            ++failed;
            std::cerr << "[FAIL] " << test.name << ": " << ex.what() << '\n';
        }
    }

    if (failed > 0)
    {
        std::cerr << failed << " backend test(s) failed\n";
        return 1;
    }

    std::cout << tests.size() << " backend test(s) passed\n";
    return 0;
}
