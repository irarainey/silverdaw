#include "AudioEngine.h"
#include "AudioConstants.h"
#include "BridgeAuth.h"
#include "LoudnessAnalyzer.h"
#include "MixdownEngine.h"
#include "PayloadHelpers.h"
#include "PeaksCache.h"
#include "ProjectFile.h"
#include "ProjectState.h"
#include "ToneEq.h"
#include "ValueTreeJson.h"
#include "WarpProcessor.h"

#include <atomic>
#include <array>
#include <chrono>
#include <cmath>
#include <exception>
#include <functional>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>
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

// Author a short, real, decodable WAV so engine.addClip builds the full
// per-track source chain (AudioFormatReaderSource → OffsetSource →
// BufferingAudioSource → AudioTransportSource). A faint sine keeps it from
// being pure silence; content is otherwise irrelevant to these tests.
juce::File writeTestWav(const juce::File& dir, const juce::String& name,
                        double seconds, double sampleRate = 44100.0)
{
    auto file = dir.getChildFile(name);
    juce::WavAudioFormat format;
    std::unique_ptr<juce::FileOutputStream> stream(file.createOutputStream());
    require(stream != nullptr, "wav output stream should open");
    std::unique_ptr<juce::AudioFormatWriter> writer(
        format.createWriterFor(stream.get(), sampleRate, 2, 16, juce::StringPairArray(), 0));
    require(writer != nullptr, "wav writer should create");
    stream.release(); // writer owns the stream now

    const int numSamples = juce::jmax(1, static_cast<int>(seconds * sampleRate));
    juce::AudioBuffer<float> buffer(2, numSamples);
    for (int ch = 0; ch < 2; ++ch)
    {
        auto* data = buffer.getWritePointer(ch);
        for (int i = 0; i < numSamples; ++i)
        {
            data[i] = 0.1F * static_cast<float>(
                          std::sin(2.0 * juce::MathConstants<double>::pi * 220.0 * i / sampleRate));
        }
    }
    require(writer->writeFromAudioSampleBuffer(buffer, 0, numSamples), "wav write should succeed");
    writer.reset(); // flush + close
    return file;
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
    clip.setProperty("libraryItemId", "lib1", nullptr);
    clip.setProperty("offsetMs", 1000.0, nullptr);
    clip.setProperty("inMs", 250.0, nullptr);
    clip.setProperty("durationMs", 4000.0, nullptr);
    clip.setProperty("colorIndex", 3, nullptr);
    track.appendChild(clip, nullptr);

    project.appendChild(track, nullptr);
    // Library holds the single source-of-truth filePath. Clips
    // reference it by id.
    juce::ValueTree library(juce::Identifier{"LIBRARY"});
    juce::ValueTree libItem(juce::Identifier{"ITEM"});
    libItem.setProperty("id", "lib1", nullptr);
    libItem.setProperty("filePath", "C:\\audio\\loop.wav", nullptr);
    libItem.setProperty("kind", "audio-file", nullptr);
    library.appendChild(libItem, nullptr);
    project.appendChild(library, nullptr);
    project.appendChild(juce::ValueTree(juce::Identifier{"MARKERS"}), nullptr);
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

    // Seed a library item; clips reference it by id and resolve the
    // source path via the library — the new schema where filePath
    // lives only on library items, never on individual clips.
    require(state.addLibraryItem("lib1", "C:\\audio\\a.wav", "a.wav"), "library item should add");

    require(state.addClip("t1", "c1", "lib1", 100.0, 1000.0, 25.0, 2),
            "addClip should add under an existing track");
    require(!state.addClip("missing", "c2", "lib1", 0.0, 1000.0),
            "addClip should reject unknown tracks");
    require(!state.addClip("t1", "c1", "lib1", 0.0, 1000.0),
            "addClip should reject duplicate clip ids");
    require(!state.addClip("t1", "c2", "", 0.0, 1000.0),
            "addClip should reject blank libraryItemId");
    requireEqual(state.getClipTrackId("c1"), "t1", "clip should report its owning track");
    requireEqual(state.getClipLibraryItemId("c1"), "lib1", "clip libraryItemId should round-trip");
    requireEqual(state.getClipFilePath("c1"), "C:\\audio\\a.wav",
                 "clip filePath should resolve through its library item");
    requireNear(state.getClipInMs("c1"), 25.0, 0.0001, "clip inMs should round-trip");

    require(state.addTrack("t2"), "second track should add");
    require(state.setClipTrack("c1", "t2"), "clip should move between tracks");
    requireEqual(state.getClipTrackId("c1"), "t2", "clip owner should update after reparent");
    require(state.setClipTrim("c1", 500.0, 100.0, 900.0), "clip trim should update atomically");
    requireNear(state.getClipInMs("c1"), 100.0, 0.0001, "trimmed inMs should update");
    requireNear(state.getClipDurationMs("c1"), 900.0, 0.0001, "trimmed duration should update");
    require(state.setClipColorIndex("c1", -1), "negative color should clear override");
    require(state.setClipName("c1", "  My Chop  "), "setClipName should trim+accept names");
    requireEqual(state.getClipName("c1"), "My Chop", "clip name should round-trip after trim");
    require(state.setClipName("c1", ""), "setClipName with blank should clear");
    requireEqual(state.getClipName("c1"), "", "blank clip name should clear the property");
    require(state.setClipName("c1", "Final"), "setClipName should re-accept a new name");
    // Library-level relink — every clip pointing at this library
    // item picks up the new source path automatically.
    require(state.setLibraryItemFilePath("lib1", "C:\\audio\\relinked.wav"),
            "library relink should update item filePath");
    requireEqual(state.getClipFilePath("c1"), "C:\\audio\\relinked.wav",
                 "clip filePath should follow library item relink");

    const auto removedIds = state.removeTrack("t2");
    require(removedIds.size() == 1 && removedIds[0] == "c1", "removeTrack should return removed clip ids");
    require(!state.removeClip("c1"), "removed clip should no longer exist");

    state.markClean();
    require(!state.isDirty(), "markClean should reset dirty");
    require(dirtyTransitions >= 2 && !lastDirty, "dirty callback should report clean transition");
}

void testProjectStateExportSettingsRoundTrip()
{
    silverdaw::ProjectState state;
    state.markClean();

    require(state.getExportSettingsJson().isEmpty(),
            "fresh project should have empty export settings");

    const juce::String blob =
        R"({"version":1,"format":"flac","bitDepth":24,"tailSeconds":"2.5"})";
    state.setExportSettingsJson(blob);
    requireEqual(state.getExportSettingsJson(), blob,
                 "setExportSettingsJson should round-trip");
    require(state.isDirty(),
            "setExportSettingsJson should mark the project dirty");

    // Should NOT have added an undo step (export prefs are not undoable).
    require(!state.getUndoManager().canUndo(),
            "setExportSettingsJson must not push an undo entry");

    state.markClean();
    state.setExportSettingsJson("");
    require(state.getExportSettingsJson().isEmpty(),
            "empty json should clear the property");
    require(state.isDirty(), "clearing export settings should mark dirty");

    // Round-trip through ValueTreeJson so the .silverdaw save/load path
    // keeps the blob intact.
    state.setExportSettingsJson(blob);
    const auto encoded = silverdaw::ValueTreeJson::toVar(state.getTree());
    const auto decoded = silverdaw::ValueTreeJson::fromVar(encoded);
    requireEqual(decoded.getProperty(juce::Identifier{"exportSettingsJson"}, {}).toString(),
                 blob, "exportSettingsJson should round-trip through ValueTreeJson");
}

void testProjectStateMasterVolumeRoundTrip()
{
    silverdaw::ProjectState state;
    state.markClean();

    requireNear(static_cast<double>(state.getMasterVolume()), 1.0, 1e-6,
                "fresh project should default to unity master volume");

    state.setMasterVolume(0.5F);
    requireNear(static_cast<double>(state.getMasterVolume()), 0.5, 1e-6,
                "setMasterVolume should round-trip");
    require(state.isDirty(), "setMasterVolume should mark the project dirty");
    require(state.getUndoManager().canUndo(),
            "setMasterVolume must push an undo entry (like TRACK_GAIN)");

    // Clamping
    state.setMasterVolume(2.5F);
    requireNear(static_cast<double>(state.getMasterVolume()), 1.0, 1e-6,
                "values above 1.0 should clamp to unity");
    state.setMasterVolume(-0.3F);
    requireNear(static_cast<double>(state.getMasterVolume()), 0.0, 1e-6,
                "negative values should clamp to zero");

    // Setting back to exactly 1.0 should remove the property so legacy
    // projects round-trip without an extra field.
    state.setMasterVolume(1.0F);
    requireNear(static_cast<double>(state.getMasterVolume()), 1.0, 1e-6,
                "unity should restore default");
    require(!state.getTree().hasProperty(juce::Identifier{"masterVolume"}),
            "exactly-unity master volume should be stored as absent");

    // ValueTreeJson round-trip for non-unity value.
    state.setMasterVolume(0.75F);
    const auto encoded = silverdaw::ValueTreeJson::toVar(state.getTree());
    const auto decoded = silverdaw::ValueTreeJson::fromVar(encoded);
    requireNear(static_cast<double>(decoded.getProperty(juce::Identifier{"masterVolume"}, 1.0)),
                0.75, 1e-6, "masterVolume should round-trip through ValueTreeJson");

    // Undo should restore the previous value AND the live engine
    // re-pull happens through rebuildEngineFromProject (covered at the
    // Main.cpp level — not exercised here).
    state.getUndoManager().beginNewTransaction();
    state.setMasterVolume(0.25F);
    state.getUndoManager().undo();
    requireNear(static_cast<double>(state.getMasterVolume()), 0.75, 1e-6,
                "undo should restore the prior master volume");
}

void testProjectStateSuppressedPropertiesDoNotStickDirtyAcrossUndo()
{
    // Regression: writing playhead / scroll / zoom AFTER markClean used
    // to silently drift the live tree away from cleanSnapshot. The
    // suppression flag kept that write itself from flipping dirty, but
    // the next genuine edit + undo would compare root against the stale
    // snapshot and incorrectly leave dirty=true even though every
    // undoable change had been reverted.
    struct Case
    {
        const char* label;
        std::function<void(silverdaw::ProjectState&)> driftSetter;
    };

    const std::array<Case, 3> cases{{
        {"playhead", [](silverdaw::ProjectState& s) { s.setPlayheadMs(5000.0); }},
        {"viewScrollX", [](silverdaw::ProjectState& s) { s.setViewScrollX(640.0); }},
        {"viewPxPerSecond", [](silverdaw::ProjectState& s) { s.setViewPxPerSecond(180.0); }},
    }};

    for (const auto& c : cases)
    {
        const std::string prefix = std::string("[") + c.label + "] ";
        const std::string msgBaselineClean = prefix + "baseline should be clean";
        const std::string msgSuppNoDirty = prefix + "suppressed setter must not mark dirty";
        const std::string msgSuppNoCb = prefix + "suppressed setter must not fire dirty callback";
        const std::string msgRealEditDirty = prefix + "real edit should mark dirty";
        const std::string msgRealEditCb = prefix + "real edit should fire dirty=true exactly once";
        const std::string msgUndoOk = prefix + "undo should succeed";
        const std::string msgUndoClean = prefix
            + "undo must restore clean even after suppressed drift";
        const std::string msgUndoCb = prefix + "undo should fire dirty=false transition";

        silverdaw::ProjectState state;
        state.addTrack("t1");
        state.markClean();
        require(!state.isDirty(), msgBaselineClean.c_str());

        int transitions = 0;
        bool lastDirty = false;
        state.setDirtyChangedCallback(
            [&](bool d)
            {
                ++transitions;
                lastDirty = d;
            });

        // Drift the suppressed property. Must not toggle dirty and
        // must not fire the dirty-changed callback.
        c.driftSetter(state);
        require(!state.isDirty(), msgSuppNoDirty.c_str());
        require(transitions == 0, msgSuppNoCb.c_str());

        // Genuine undoable edit → dirty true.
        state.getUndoManager().beginNewTransaction();
        state.setBpm(140.0);
        require(state.isDirty(), msgRealEditDirty.c_str());
        require(transitions == 1 && lastDirty, msgRealEditCb.c_str());

        // Undo the real edit → must return to clean despite the drift.
        const bool undone = state.getUndoManager().undo();
        require(undone, msgUndoOk.c_str());
        require(!state.isDirty(), msgUndoClean.c_str());
        require(transitions == 2 && !lastDirty, msgUndoCb.c_str());
    }
}

void testProjectStateDerivedLibraryMetadataDoesNotMarkDirty()
{
    // Regression: BPM detection, beat-grid analysis, and decoded-cache
    // path resolution all run in the background after a project is
    // loaded or a clip is added. They mutate library-item properties
    // that are *derived* from the source audio file and can be
    // regenerated at any time, so they must NOT mark the project
    // dirty — otherwise opening a project and pressing Play (which
    // triggers cache resolution) would prompt the user to save.
    silverdaw::ProjectState state;
    require(state.addLibraryItem("l1", "C:\\audio\\loop.wav", "loop.wav", 1000.0, 48000, 2),
            "library add should succeed");
    state.markClean();
    require(!state.isDirty(), "baseline should be clean after markClean");

    int transitions = 0;
    state.setDirtyChangedCallback([&](bool) { ++transitions; });

    // All of these are derived/cache writes — none should toggle dirty.
    require(state.setLibraryItemBpm("l1", 124.5), "bpm setter should find item");
    require(state.setLibraryItemBeats("l1", {0.1, 0.5, 0.9}),
            "beats setter should find item");
    require(state.setLibraryItemBeatAnchor("l1", 0.25),
            "beat anchor setter should find item");
    require(state.setLibraryItemVariableTempo("l1", true),
            "variable tempo setter should find item");
    require(state.setLibraryItemLowConfidence("l1", true),
            "low confidence setter should find item");
    require(state.setLibraryItemPlaybackPath("l1", "C:\\cache\\loop.wav"),
            "playback path setter should find item");
    require(!state.isDirty(),
            "derived library-item metadata writes must not mark the project dirty");
    require(transitions == 0,
            "derived library-item metadata writes must not fire the dirty callback");

    // Property values still round-trip.
    requireNear(state.getLibraryItemBpmForPath("C:\\audio\\loop.wav"), 124.5, 0.0001,
                "bpm should persist on the live tree");
    requireEqual(state.getLibraryItemPlaybackPathForSource("C:\\audio\\loop.wav"),
                 juce::String("C:\\cache\\loop.wav"),
                 "playback path should persist on the live tree");

    // And a genuine edit + undo still returns the project to clean —
    // the snapshot mirror means the derived writes don't leave drift
    // behind for the equivalence check.
    state.getUndoManager().beginNewTransaction();
    state.setBpm(140.0);
    require(state.isDirty(), "real edit should mark dirty");
    require(state.getUndoManager().undo(), "undo should succeed");
    require(!state.isDirty(),
            "undo must restore clean even after background analysis ran");

    // clearLibraryItemAnalysis is also derived — exercising it after
    // markClean must not toggle dirty either.
    state.markClean();
    transitions = 0;
    require(state.clearLibraryItemAnalysis("l1"),
            "clearLibraryItemAnalysis should find item");
    require(!state.isDirty(),
            "clearLibraryItemAnalysis must not mark the project dirty");
    require(transitions == 0,
            "clearLibraryItemAnalysis must not fire the dirty callback");
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
    require(state.addLibraryItem("l2", "C:\\audio\\source.wav", "source.wav", 750.0, 48000, 2,
                                 {}, {}, "saved-clip", "Source chop", "l1", "c1", 500.0, 750.0),
            "saved clip library item should add");
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
    require(library.isArray() && library.getArray()->size() == 2, "libraryAsJson should return two items");
    const auto& firstItem = library.getArray()->getReference(0);
    require(firstItem.getProperty("beats", {}).isArray(), "libraryAsJson should include beats array");
    require(bool(firstItem.getProperty("variableTempo", false)), "libraryAsJson should include variableTempo");
    const auto& savedItem = library.getArray()->getReference(1);
    requireEqual(savedItem.getProperty("kind", {}).toString(), "saved-clip", "saved clip kind should round-trip");
    requireEqual(savedItem.getProperty("name", {}).toString(), "Source chop", "saved clip name should round-trip");
    requireEqual(savedItem.getProperty("sourceItemId", {}).toString(), "l1", "saved clip source should round-trip");
    requireNear(static_cast<double>(savedItem.getProperty("sourceInMs", 0.0)), 500.0, 0.0001,
                "saved clip in point should round-trip");

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

    const auto viewStateResult = silverdaw::ProjectFile::saveViewState(file, -10.0, 99.0, "t1", true);
    require(viewStateResult.wasOk(), "saveViewState should update existing project file");
    silverdaw::ProjectState reloaded;
    require(silverdaw::ProjectFile::load(file, reloaded).ok, "reloading after view-state save should work");
    requireNear(reloaded.getViewScrollX(), 0.0, 0.0001, "saveViewState should clamp negative scroll");
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

void testProjectStateNetZeroDirty()
{
    silverdaw::ProjectState state;
    state.addTrack("t1");
    state.markClean();
    require(!state.isDirty(), "fresh markClean baseline should be clean");

    int transitions = 0;
    bool lastDirty = false;
    state.setDirtyChangedCallback(
        [&](bool d)
        {
            ++transitions;
            lastDirty = d;
        });

    require(state.addLibraryItem("l1", "C:\\audio\\loop.wav", "loop.wav", 1000.0, 48000, 2),
            "library add should succeed");
    require(state.isDirty(), "adding a library item should mark dirty");
    require(transitions == 1 && lastDirty, "dirty callback should fire on add");

    require(state.removeLibraryItem("l1"), "library remove should succeed");
    require(!state.isDirty(), "removing the just-added library item should return to clean");
    require(transitions == 2 && !lastDirty, "dirty callback should fire on net-zero remove");

    require(state.addLibraryItem("l2", "C:\\audio\\saved.wav", "saved.wav", 500.0, 48000, 2,
                                 {}, {}, "saved-clip", "Chop", "src", "clip", 100.0, 500.0),
            "saved clip add should succeed");
    require(state.isDirty(), "saved-clip add should mark dirty");
    require(state.removeLibraryItem("l2"), "saved-clip remove should succeed");
    require(!state.isDirty(), "saved-clip add+remove should return to clean");
}

void testWarpProcessorBasicStretch()
{
    // Smoke test: build a WarpProcessor, feed it a unit-amplitude sine
    // wave at native rate, and verify it produces samples that look
    // like audio (non-zero, finite, within range). This is enough to
    // confirm the Rubber Band integration actually links and runs;
    // detailed correctness tests (steady-state ratio, seek handling,
    // pitch independence) belong in the next pass.
    constexpr double kSampleRate = 48000.0;
    constexpr int kChannels = 2;
    constexpr int kBlockSamples = 512;
    silverdaw::WarpProcessor warp(kChannels, kSampleRate,
                                   RubberBand::RubberBandStretcher::OptionEngineFaster);
    warp.prepareToPlay(kBlockSamples);
    warp.setTempoRatio(1.25); // play 25 % faster
    warp.setPitchScale(1.0);

    std::vector<std::vector<float>> outBuffers(kChannels, std::vector<float>(kBlockSamples, 0.0f));
    std::vector<float*> outPtrs(kChannels);
    for (int c = 0; c < kChannels; ++c) outPtrs[c] = outBuffers[c].data();

    // Source-read callback feeds a 440 Hz sine wave at the requested
    // source position. Phase computed from the absolute sample index so
    // it stays continuous across blocks.
    auto readSource = [&](float* const* dest, juce::int64 sourcePos, int n)
    {
        for (int c = 0; c < kChannels; ++c)
        {
            for (int i = 0; i < n; ++i)
            {
                const double phase = 2.0 * juce::MathConstants<double>::pi * 440.0
                                     * static_cast<double>(sourcePos + i) / kSampleRate;
                dest[c][i] = static_cast<float>(std::sin(phase) * 0.5);
            }
        }
    };

    // Run a few blocks so the stretcher's start-pad + steady-state
    // ramp has time to produce real output.
    int totalProduced = 0;
    bool sawNonZero = false;
    for (int block = 0; block < 8; ++block)
    {
        const int produced = warp.process(outPtrs.data(), kBlockSamples, readSource);
        totalProduced += produced;
        for (int c = 0; c < kChannels; ++c)
        {
            for (int i = 0; i < produced; ++i)
            {
                const float v = outBuffers[c][i];
                require(std::isfinite(v), "warp produced non-finite sample");
                require(std::abs(v) <= 1.5f, "warp produced wildly out-of-range sample");
                if (std::abs(v) > 1e-4f) sawNonZero = true;
            }
        }
    }
    require(sawNonZero, "warp produced no audible output across 8 blocks");
}

void testWarpTimelineDurationMapping()
{
    require(silverdaw::WarpProcessor::timelineSamplesForSourceSamples(4000, 1.0) == 4000,
            "unwarped duration should remain in source samples");

    silverdaw::WarpProcessor faster(2, 48000.0, RubberBand::RubberBandStretcher::OptionEngineFaster);
    faster.prepareToPlay(512);
    faster.setTempoRatio(2.0);
    require(silverdaw::WarpProcessor::timelineSamplesForSourceSamples(4000, faster.getTempoRatio()) == 2000,
            "2x tempo ratio should halve visible timeline duration");

    silverdaw::WarpProcessor slower(2, 48000.0, RubberBand::RubberBandStretcher::OptionEngineFaster);
    slower.prepareToPlay(512);
    slower.setTempoRatio(0.5);
    require(silverdaw::WarpProcessor::timelineSamplesForSourceSamples(4000, slower.getTempoRatio()) == 8000,
            "0.5x tempo ratio should double visible timeline duration");
}

// ─── Bridge payload validation ─────────────────────────────────────────────
//
// Targets the helpers in `PayloadHelpers.h` that every `handle*` dispatch
// site relies on. The regression they protect against is the silent
// coercion of `juce::var::toString()` on a wrong-typed value: before
// F-005, a payload like `{ "libraryItemId": { foo: 1 } }` would have
// stringified the inner object into a JUCE debug string, then failed
// the downstream lookup with no log line.

juce::var makeBridgePayload(std::initializer_list<std::pair<const char*, juce::var>> fields)
{
    auto* obj = new juce::DynamicObject();
    for (const auto& f : fields)
    {
        obj->setProperty(juce::Identifier{f.first}, f.second);
    }
    return juce::var(obj);
}

void testBridgePayloadHelpersRejectMalformed()
{
    using silverdaw::bridge::tryGetNumber;
    using silverdaw::bridge::tryGetRequiredString;
    using silverdaw::bridge::tryGetString;

    // Valid string.
    {
        const auto v = makeBridgePayload({{"libraryItemId", juce::var("lib-1")}});
        const auto got = tryGetRequiredString(v, "libraryItemId");
        require(got.has_value() && *got == "lib-1", "valid string should be accepted");
    }

    // Missing field — rejected.
    {
        const auto v = makeBridgePayload({});
        require(!tryGetString(v, "libraryItemId").has_value(), "missing string field should reject");
        require(!tryGetRequiredString(v, "libraryItemId").has_value(),
                "missing required-string field should reject");
        require(!tryGetNumber(v, "peaksPerSecond").has_value(), "missing number field should reject");
    }

    // Number passed where a string is expected — rejected (NOT coerced).
    // This is the original F-005 regression: `juce::var::toString()` on
    // an int returns "42", which silently became a bogus library id.
    {
        const auto v = makeBridgePayload({{"libraryItemId", juce::var(42)}});
        require(!tryGetString(v, "libraryItemId").has_value(),
                "numeric value should not be coerced into a string");
        require(!tryGetRequiredString(v, "libraryItemId").has_value(),
                "numeric value should not satisfy required-string");
    }

    // Object passed where a string is expected — rejected (NOT coerced
    // via JUCE's debug-stringification of an object).
    {
        auto* nested = new juce::DynamicObject();
        nested->setProperty(juce::Identifier{"x"}, juce::var(1));
        const auto v = makeBridgePayload({{"libraryItemId", juce::var(nested)}});
        require(!tryGetString(v, "libraryItemId").has_value(),
                "object value should not be coerced into a string");
        require(!tryGetRequiredString(v, "libraryItemId").has_value(),
                "object value should not satisfy required-string");
    }

    // Array passed where a string is expected — rejected.
    {
        juce::Array<juce::var> arr;
        arr.add(juce::var("a"));
        arr.add(juce::var("b"));
        const auto v = makeBridgePayload({{"libraryItemId", juce::var(arr)}});
        require(!tryGetString(v, "libraryItemId").has_value(),
                "array value should not be coerced into a string");
    }

    // `tryGetString` accepts the empty string (caller decides if meaningful);
    // `tryGetRequiredString` rejects it.
    {
        const auto v = makeBridgePayload({{"libraryItemId", juce::var("")}});
        const auto opt = tryGetString(v, "libraryItemId");
        require(opt.has_value() && opt->isEmpty(), "empty string should pass tryGetString");
        require(!tryGetRequiredString(v, "libraryItemId").has_value(),
                "empty string should be rejected by tryGetRequiredString");
    }

    // tryGetNumber accepts int / double / int64 alike.
    {
        const auto v1 = makeBridgePayload({{"peaksPerSecond", juce::var(500)}});
        const auto v2 = makeBridgePayload({{"peaksPerSecond", juce::var(500.0)}});
        const auto v3 = makeBridgePayload({{"peaksPerSecond", juce::var(static_cast<juce::int64>(500))}});
        require(tryGetNumber(v1, "peaksPerSecond").value_or(0.0) == 500.0, "int should be accepted as number");
        require(tryGetNumber(v2, "peaksPerSecond").value_or(0.0) == 500.0, "double should be accepted as number");
        require(tryGetNumber(v3, "peaksPerSecond").value_or(0.0) == 500.0, "int64 should be accepted as number");
    }

    // tryGetNumber rejects strings (no implicit numeric parse).
    {
        const auto v = makeBridgePayload({{"peaksPerSecond", juce::var("500")}});
        require(!tryGetNumber(v, "peaksPerSecond").has_value(),
                "string value should not be coerced into a number");
    }

    // tryGetNumber rejects booleans.
    {
        const auto v = makeBridgePayload({{"peaksPerSecond", juce::var(true)}});
        require(!tryGetNumber(v, "peaksPerSecond").has_value(),
                "boolean value should not be coerced into a number");
    }
}

// ─── AudioEngine preview warp stress ──────────────────────────────────────
//
// Targets the message-thread / audio-thread race on the OffsetSource
// warp pointer. The implementation in `AudioEngine.cpp` retires old
// `WarpProcessor`s into `preview.retiredWarps` so the audio thread
// can safely dereference the atomic until `unloadPreview` releases
// them. This test exercises the configuration entry point at a high
// rate, then unloads, asserting the engine survives both phases
// without crashing or leaking unboundedly.
//
// We don't actually open an audio device — `setPreviewWarp` is
// documented as a no-op when no preview is loaded, returning
// `false`. The value here is regression coverage: any future change
// that crashes / asserts on rapid `setPreviewWarp` calls (e.g. a
// dangling-pointer regression in the retire path) will fail this
// test deterministically.

void testAudioEngineSetPreviewWarpUnderRapidCalls()
{
    silverdaw::AudioEngine engine;

    constexpr int kCallCount = 2000; // > 100 Hz over a typical real-time second.
    std::atomic<bool> readerStop{false};
    std::atomic<long> readerLoops{0};

    // Fake "audio thread": continuously reads cheap engine getters that
    // the real audio callback also touches. Any iteration that hits a
    // crash or hang surfaces as a test failure (process abort) /
    // timeout.
    std::thread reader([&]() {
        while (!readerStop.load(std::memory_order_relaxed))
        {
            (void) engine.isPreviewLoaded();
            (void) engine.isPreviewPlaying();
            (void) engine.getPreviewPositionMs();
            (void) engine.getPreviewDurationMs();
            (void) engine.getPreviewGeneration();
            readerLoops.fetch_add(1, std::memory_order_relaxed);
        }
    });

    // Drive setPreviewWarp on the main thread. Each iteration toggles
    // mode + tempo + pitch so the call exercises the same branches
    // the live UI hits while the user drags the warp sliders.
    int okCount = 0;
    int falseCount = 0;
    for (int i = 0; i < kCallCount; ++i)
    {
        const bool enabled = (i & 1) == 0;
        const auto mode = juce::String((i % 3 == 0) ? "rhythmic" : (i % 3 == 1) ? "tonal" : "complex");
        const double tempoRatio = 1.0 + ((i % 11) - 5) * 0.02; // 0.90 .. 1.10
        const double semitones = static_cast<double>(((i % 25) - 12)); // -12 .. +12
        const double cents = static_cast<double>(((i % 201) - 100));   // -100 .. +100
        const bool ok = engine.setPreviewWarp(enabled, mode, tempoRatio, semitones, cents);
        if (ok) ++okCount;
        else ++falseCount;
    }

    readerStop.store(true, std::memory_order_relaxed);
    reader.join();

    require(okCount + falseCount == kCallCount, "every call should return a definite bool");
    // With no preview loaded, setPreviewWarp is documented as no-op
    // returning false. The assertion is intentionally loose — if a
    // future API change permits configuring without a preview, the
    // test still passes (the regression we care about is crashes /
    // UB under rapid invocation, not the return value).
    require(falseCount == kCallCount,
            "setPreviewWarp should no-op (return false) when no preview is loaded");
    require(readerLoops.load(std::memory_order_relaxed) > 0,
            "reader thread should have observed at least one engine state read");
}

// ─── AudioEngine play-prime safety ────────────────────────────────────────
//
// Regression guard for the "first play after load is instant" fix. Each
// track owns its read-ahead BufferingAudioSource explicitly so the engine
// can block-prime it to an exact playhead before opening the master gate
// (AudioEngine::primeTracksForPlayback).
//
// Two things are locked in here:
//  1. The refactored per-track source chain (reader → offset → buffering →
//     transport) builds, seeks, plays, and tears down without crashing —
//     the real risk of owning the buffering source is a lifetime / member
//     destruction-order regression (use-after-free on shutdown).
//  2. Priming is bounded: with no audio device open the buffering sources
//     are never prepared and can never fill, so primeTracksForPlayback must
//     early-return rather than block kPrimePerTrackTimeoutMs per track. The
//     time bound is deliberately loose to stay non-flaky while still
//     catching a regression that drops the no-device guard (which would turn
//     this into a multi-hundred-ms — or, with many tracks, multi-second —
//     stall).
//
// We call initialise() only to register the audio formats addClip needs; the
// test stays correct whether or not a real output device opens on the host.

void testAudioEnginePrimeTracksForPlaybackIsSafeAndBounded()
{
    const auto dir = makeTempDir("prime-tracks");
    silverdaw::AudioEngine engine;
    engine.initialise({}, {}, nullptr); // registers WAV/etc. formats for addClip

    const auto a = writeTestWav(dir, "a.wav", 2.0);
    const auto b = writeTestWav(dir, "b.wav", 2.0);
    require(engine.addClip("t1", "c1", a, 0.0), "addClip c1 should build the owned-buffer chain");
    require(engine.addClip("t1", "c2", b, 500.0), "addClip c2 should build the owned-buffer chain");

    // Prime at the current position. Must be safe and bounded regardless of
    // whether a device is open on this host.
    const auto t0 = juce::Time::getMillisecondCounterHiRes();
    engine.primeTracksForPlayback(silverdaw::kLoadPrimeBudgetMs);
    const auto elapsed = juce::Time::getMillisecondCounterHiRes() - t0;
    require(elapsed < 3000.0, "primeTracksForPlayback must stay bounded (never hang)");

    // Jump-to-start then play-immediately path: seek, prime, play, stop. The
    // chain must survive all of it without crashing.
    engine.setPositionMs(0.0);
    engine.primeTracksForPlayback(silverdaw::kPlayPrimeBudgetMs);
    engine.play();  // play() primes internally before opening the gate
    engine.stop();

    require(engine.removeClip("c1"), "removeClip c1 should succeed");
    require(engine.removeClip("c2"), "removeClip c2 should succeed");

    engine.shutdown();
    dir.deleteRecursively();
}

// ─── ToneEq low-cut direction + shelf range ───────────────────────────────
//
// Regression guard for the per-track Tone EQ. Two defects this locks out:
//  1. "Low Cut" was a high-pass in name only — `designHighPass` used the
//     low-pass cookbook numerator (1 - cos w0), so it actually stripped
//     everything ABOVE the corner and left only sub-bass, sounding like a
//     mute. A real low-cut must pass highs and attenuate lows.
//  2. The shelves/peak must deliver real range at ±15 dB (a flat/​off chain
//     stays bit-transparent for the export-parity guarantee).
//
// We drive a stationary sine through ToneEq and compare steady-state output
// RMS (second half, past filter warm-up) to input RMS.

double toneRms(const juce::AudioBuffer<float>& buf, int startSample, int numSamples)
{
    double sum = 0.0;
    int count = 0;
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
    {
        const float* d = buf.getReadPointer(ch);
        for (int i = 0; i < numSamples; ++i)
        {
            const double v = d[startSample + i];
            sum += v * v;
            ++count;
        }
    }
    return count > 0 ? std::sqrt(sum / count) : 0.0;
}

// Output/input RMS ratio for a stationary sine at `freq` after applying the
// given Tone settings (snapped to steady state).
double toneGainRatio(float bassDb, float midDb, float trebleDb, bool lowCut, bool highCut,
                     double freq)
{
    constexpr double sr = 44100.0;
    silverdaw::ToneEq eq;
    eq.prepare(sr, 2);
    eq.setParams(bassDb, midDb, trebleDb, lowCut, highCut, /*snap*/ true);

    constexpr int n = 16384;
    juce::AudioBuffer<float> buf(2, n);
    for (int ch = 0; ch < 2; ++ch)
    {
        float* d = buf.getWritePointer(ch);
        for (int i = 0; i < n; ++i)
        {
            d[i] = 0.25F * static_cast<float>(
                       std::sin(2.0 * juce::MathConstants<double>::pi * freq * i / sr));
        }
    }
    const double inRms = toneRms(buf, n / 2, n / 2); // input is stationary
    eq.process(buf, 0, n);
    const double outRms = toneRms(buf, n / 2, n / 2); // measure past warm-up
    return inRms > 0.0 ? outRms / inRms : 0.0;
}

void testToneEqLowCutDirectionAndShelfRange()
{
    // Low Cut is a 4th-order (24 dB/oct) high-pass @ 120 Hz: 1 kHz passes
    // ~unchanged while lows are strongly removed. The inverted (low-pass)
    // regression fails the direction guard; a too-gentle 2nd-order voicing
    // fails the 60 Hz slope guard below.
    const double passHigh = toneGainRatio(0.0F, 0.0F, 0.0F, true, false, 1000.0);
    const double cutLow = toneGainRatio(0.0F, 0.0F, 0.0F, true, false, 40.0);
    const double cut60 = toneGainRatio(0.0F, 0.0F, 0.0F, true, false, 60.0);
    require(passHigh > 0.9, "Low Cut must pass 1 kHz roughly unchanged");
    require(cutLow < 0.1, "Low Cut must strongly attenuate 40 Hz");
    // A 2nd-order 120 Hz high-pass leaves 60 Hz near -6 dB (~0.25); the
    // 4th-order slope pushes it well below, so this locks in 24 dB/oct.
    require(cut60 < 0.15, "Low Cut must have a 24 dB/oct slope (60 Hz well below 2nd-order)");
    require(passHigh > cutLow + 0.3, "Low Cut must pass highs more than lows (not inverted)");

    // High Cut is a 4th-order (24 dB/oct) low-pass @ 6 kHz: 1 kHz passes
    // ~unchanged while highs are strongly removed (mirror of Low Cut).
    const double passLow = toneGainRatio(0.0F, 0.0F, 0.0F, false, true, 1000.0);
    const double cutHigh = toneGainRatio(0.0F, 0.0F, 0.0F, false, true, 12000.0);
    const double cut9k = toneGainRatio(0.0F, 0.0F, 0.0F, false, true, 9000.0);
    require(passLow > 0.9, "High Cut must pass 1 kHz roughly unchanged");
    require(cutHigh < 0.1, "High Cut must strongly attenuate 12 kHz");
    // A 2nd-order 6 kHz low-pass leaves 9 kHz near -8 dB (~0.41); the
    // 4th-order slope pushes it well below, so this locks in 24 dB/oct.
    require(cut9k < 0.3, "High Cut must have a 24 dB/oct slope (9 kHz well below 2nd-order)");
    require(passLow > cutHigh + 0.3, "High Cut must pass lows more than highs (not inverted)");

    // Shelves / peak must deliver real range at the full ±15 dB. +15 dB ≈
    // 5.6× linear; assert clearly above unity. The clamp must also hold:
    // an over-range request resolves to the same gain as the +15 dB limit.
    const double bassMax = toneGainRatio(15.0F, 0.0F, 0.0F, false, false, 40.0);
    require(bassMax > 3.0, "Bass +15 dB should strongly boost 40 Hz");
    require(toneGainRatio(-15.0F, 0.0F, 0.0F, false, false, 40.0) < 0.4, "Bass -15 dB should strongly cut 40 Hz");
    require(toneGainRatio(0.0F, 0.0F, 15.0F, false, false, 12000.0) > 3.0, "Treble +15 dB should strongly boost 12 kHz");
    require(toneGainRatio(0.0F, 15.0F, 0.0F, false, false, 1000.0) > 3.0, "Mid +15 dB should strongly boost 1 kHz");
    const double bassOverdriven = toneGainRatio(40.0F, 0.0F, 0.0F, false, false, 40.0);
    require(std::abs(bassOverdriven - bassMax) < 0.05, "Tone gain must clamp at +15 dB");

    // Revoiced corners: Bass shelf (250 Hz) lifts low-mid body at 200 Hz;
    // Treble shelf (4 kHz) adds presence at 5 kHz — neither is parked out
    // at the spectral extremes where the controls felt inert.
    require(toneGainRatio(12.0F, 0.0F, 0.0F, false, false, 200.0) > 1.5, "Bass should act on low-mid body (~200 Hz)");
    require(toneGainRatio(0.0F, 0.0F, 12.0F, false, false, 5000.0) > 1.5, "Treble should act on presence (~5 kHz)");

    // Flat with both cuts off must be transparent (export-parity guarantee).
    const double flat = toneGainRatio(0.0F, 0.0F, 0.0F, false, false, 1000.0);
    require(std::abs(flat - 1.0) < 0.02, "Flat tone with both cuts off should be transparent");
}

// ─── Mixdown snapshot fade parity ─────────────────────────────────────────
//
// Regression guard for the offline-render fade fix. Exported audio must
// carry the same per-clip fades the live engine applies. The live engine
// wires fades into `OffsetSource::setFadesMs`; the offline render reuses
// the identical OffsetSource, but `buildOfflineClip` can only apply the
// fades the snapshot carries. Before the fix, `snapshotProjectForMixdown`
// never read kFadeInMs / kFadeOutMs, so every export rendered with zero
// fades regardless of the user's settings.
//
// This test asserts the snapshot faithfully carries the clip fades from
// ProjectState (the single source of truth the live load path also uses)
// and that clips with no fades default to zero. If a future change drops
// the fade reads from the snapshot, this fails deterministically.

void testMixdownSnapshotCarriesClipFades()
{
    silverdaw::ProjectState state;
    require(state.addTrack("t1"), "addTrack should succeed");
    require(state.addLibraryItem("lib1", "C:\\audio\\a.wav", "a.wav", 5000.0, 48000, 2),
            "addLibraryItem should succeed");
    // Faded clip.
    require(state.addClip("t1", "c-faded", "lib1", 100.0, 1000.0),
            "addClip should succeed for faded clip");
    require(state.setClipFades("c-faded", 250.0, 400.0),
            "setClipFades should succeed");
    // Un-faded clip on the same track — defaults must stay zero.
    require(state.addClip("t1", "c-plain", "lib1", 2000.0, 1000.0),
            "addClip should succeed for plain clip");

    const auto snapshot = silverdaw::snapshotProjectForMixdown(state);

    const silverdaw::MixdownSnapshot::ClipSnapshot* faded = nullptr;
    const silverdaw::MixdownSnapshot::ClipSnapshot* plain = nullptr;
    for (const auto& track : snapshot.tracks)
    {
        for (const auto& clip : track.clips)
        {
            if (clip.id == "c-faded") faded = &clip;
            else if (clip.id == "c-plain") plain = &clip;
        }
    }

    require(faded != nullptr, "faded clip should appear in the mixdown snapshot");
    require(plain != nullptr, "plain clip should appear in the mixdown snapshot");
    requireNear(faded->fadeInMs, 250.0, 0.0001, "snapshot should carry the clip fade-in");
    requireNear(faded->fadeOutMs, 400.0, 0.0001, "snapshot should carry the clip fade-out");
    requireNear(plain->fadeInMs, 0.0, 0.0001, "un-faded clip should default fade-in to zero");
    requireNear(plain->fadeOutMs, 0.0, 0.0001, "un-faded clip should default fade-out to zero");
}

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    // (loudness tests defined inline below to keep diff focused)
    auto testLoudnessAnalyzerSilence = []() {
        silverdaw::LoudnessAnalyzer ana(48000.0);
        const int n = 48000;
        std::vector<float> z(n, 0.0F);
        const float* ch[2] = { z.data(), z.data() };
        ana.process(ch, 2, n);
        const auto r = ana.finalize();
        require(r.silent || r.unmeasurable,
                "silence should be reported silent or unmeasurable");
        require(! std::isfinite(r.integratedLufs), "silent integrated LUFS must be -inf");
    };

    auto testLoudnessAnalyzerSineHits23 = []() {
        // 1 kHz stereo sine, RMS-calibrated to -26 dBFS per channel.
        // Stereo channel summation in BS.1770 (G_L=G_R=1.0) adds +3 dB
        // → integrated should land at ~-23 LUFS.
        silverdaw::LoudnessAnalyzer ana(48000.0);
        const int n = 48000 * 3;
        const double rmsLin = std::pow(10.0, -26.0 / 20.0);
        const double ampLin = rmsLin * std::sqrt(2.0); // sine peak from RMS
        std::vector<float> sine(n);
        const double twoPiF = 2.0 * 3.14159265358979323846 * 1000.0 / 48000.0;
        for (int i = 0; i < n; ++i)
            sine[static_cast<size_t>(i)] = static_cast<float>(ampLin * std::sin(twoPiF * i));
        const float* ch[2] = { sine.data(), sine.data() };
        ana.process(ch, 2, n);
        const auto r = ana.finalize();
        require(! r.silent && ! r.unmeasurable, "loud sine must be measurable");
        require(std::abs(r.integratedLufs - (-23.0)) < 0.5,
                "integrated LUFS for -26 dBFS stereo sine should be ~-23");
        require(r.gatedBlockCount > 0, "should have at least one gated block");
    };

    auto testLoudnessAnalyzerGainShift = []() {
        // computeForLinearGainDb shifts both integrated LUFS and TP by
        // the applied gain (within rounding).
        silverdaw::LoudnessAnalyzer ana(48000.0);
        const int n = 48000 * 3;
        const double rmsLin = std::pow(10.0, -26.0 / 20.0);
        const double ampLin = rmsLin * std::sqrt(2.0);
        std::vector<float> sine(n);
        const double twoPiF = 2.0 * 3.14159265358979323846 * 1000.0 / 48000.0;
        for (int i = 0; i < n; ++i)
            sine[static_cast<size_t>(i)] = static_cast<float>(ampLin * std::sin(twoPiF * i));
        const float* ch[2] = { sine.data(), sine.data() };
        ana.process(ch, 2, n);
        const auto base = ana.finalize();
        const auto plus6 = ana.computeForLinearGainDb(6.0);
        require(std::abs((plus6.integratedLufs - base.integratedLufs) - 6.0) < 0.1,
                "+6 dB gain should shift integrated LUFS by ~+6");
        require(std::abs((plus6.truePeakDbtp - base.truePeakDbtp) - 6.0) < 0.01,
                "+6 dB gain should shift true peak by exactly +6 dB");
    };

    auto testLoudnessAnalyzerSampleRateGuard = []() {
        bool threw = false;
        try { silverdaw::LoudnessAnalyzer bad(96000.0); }
        catch (const juce::String&) { threw = true; }
        require(threw, "LoudnessAnalyzer must reject non-standard sample rates");
    };

    // Phase 5 — per-track send levels. Verifies default-suppression
    // (absent property when value is the default zero), the
    // `bool changed` return contract that lets the dispatcher skip
    // ack/undo on no-ops, clamping to [0, 1], and that subsequent
    // mutation-back-to-default actually *removes* the property so the
    // legacy round-trip stays byte-equivalent.
    auto testProjectStateTrackSendsRoundTrip = []() {
        silverdaw::ProjectState state;
        require(state.addTrack("t-sends"), "addTrack should accept new id");
        const auto track = state.getTree().getChildWithProperty(
            juce::Identifier{"id"}, juce::var("t-sends"));
        require(track.isValid(), "track lookup should succeed");

        const juce::Identifier kSendReverb{"sendReverb"};
        const juce::Identifier kSendDelay{"sendDelay"};

        require(!track.hasProperty(kSendReverb),
                "default sendReverb should be absent on a fresh track");
        require(!track.hasProperty(kSendDelay),
                "default sendDelay should be absent on a fresh track");

        const bool noOp = state.setTrackSends("t-sends", 0.0F, 0.0F);
        require(!noOp, "setTrackSends 0/0 on a fresh track should be a no-op");
        require(!track.hasProperty(kSendReverb),
                "no-op send write must not create properties");

        const bool changed = state.setTrackSends("t-sends", 0.4F, 0.7F);
        require(changed, "non-default sends should report changed=true");
        requireNear(state.getTrackReverbSend("t-sends"), 0.4, 0.0001,
                    "reverbSend round-trip");
        requireNear(state.getTrackDelaySend("t-sends"), 0.7, 0.0001,
                    "delaySend round-trip");

        const bool repeat = state.setTrackSends("t-sends", 0.4F, 0.7F);
        require(!repeat, "repeated same-value send write should be a no-op");

        const bool clamped = state.setTrackSends("t-sends", 5.0F, 0.7F);
        require(clamped, "above-range reverb should clamp and report changed");
        requireNear(state.getTrackReverbSend("t-sends"), 1.0, 0.0001,
                    "reverbSend should clamp to 1.0");

        const bool cleared = state.setTrackSends("t-sends", 0.0F, 0.0F);
        require(cleared, "reset to default should report changed=true");
        require(!track.hasProperty(kSendReverb),
                "default-suppression: zero must remove sendReverb property");
        require(!track.hasProperty(kSendDelay),
                "default-suppression: zero must remove sendDelay property");

        require(!state.setTrackSends("missing", 0.1F, 0.2F),
                "setTrackSends should reject unknown trackId");
    };

    auto testProjectStateClipEnvelopeNormalisation = []() {
        silverdaw::ProjectState state;
        require(state.addTrack("t-env"), "addTrack should succeed");
        require(state.addClip("t-env", "c-env", "lib-x", 0.0, 5000.0),
                "addClip should succeed");

        const auto clip = state.getTree().getChildWithProperty(
                                       juce::Identifier{"id"}, juce::var("t-env"))
                              .getChildWithProperty(juce::Identifier{"id"}, juce::var("c-env"));
        require(clip.isValid(), "clip lookup should succeed");
        const juce::Identifier kEnvelopePoints{"envelopePoints"};

        require(!clip.hasProperty(kEnvelopePoints),
                "fresh clip should not carry envelopePoints");
        require(!state.setClipEnvelope("c-env", {}),
                "empty envelope on a fresh clip is a no-op");

        const auto makePoint = [](double timeMs, double gain) {
            auto* obj = new juce::DynamicObject();
            obj->setProperty("timeMs", timeMs);
            obj->setProperty("gain", gain);
            return juce::var(obj);
        };

        juce::Array<juce::var> unsorted;
        unsorted.add(makePoint(200.0, 0.5));
        unsorted.add(makePoint(0.0, 1.0));
        unsorted.add(makePoint(100.0, 0.75));
        require(state.setClipEnvelope("c-env", unsorted),
                "sort-and-store should report changed");

        const auto stored = state.getClipEnvelope("c-env");
        require(stored.size() == 3, "stored envelope should have 3 points");
        const auto t0 = static_cast<double>(stored.getReference(0).getProperty("timeMs", juce::var{}));
        const auto t1 = static_cast<double>(stored.getReference(1).getProperty("timeMs", juce::var{}));
        const auto t2 = static_cast<double>(stored.getReference(2).getProperty("timeMs", juce::var{}));
        requireNear(t0, 0.0, 0.0001, "points sorted ascending t0");
        requireNear(t1, 100.0, 0.0001, "points sorted ascending t1");
        requireNear(t2, 200.0, 0.0001, "points sorted ascending t2");

        juce::Array<juce::var> dup;
        dup.add(makePoint(50.0, 1.0));
        dup.add(makePoint(50.0, 0.5));
        require(!state.setClipEnvelope("c-env", dup),
                "duplicate timeMs must be rejected (no mutation)");
        require(state.getClipEnvelope("c-env").size() == 3,
                "rejected duplicate must leave prior envelope intact");

        juce::Array<juce::var> empty;
        require(state.setClipEnvelope("c-env", empty),
                "clearing a populated envelope should report changed");
        require(!clip.hasProperty(kEnvelopePoints),
                "empty envelope must remove the property entirely");
    };

    auto testProjectStateDelayNoteValueGuard = []() {
        silverdaw::ProjectState state;

        require(!state.setProjectDelay("1/8", 0.0F, 0.0F, 0.0F),
                "default 1/8 + zeros must be a no-op");

        require(state.setProjectDelay("1/4", 0.3F, 0.5F, 0.2F),
                "valid noteValue + non-default scalars should persist");
        requireEqual(state.getProjectDelayNoteValue(), juce::String{"1/4"},
                     "noteValue round-trip");

        require(!state.setProjectDelay(" 1/8 ", 0.3F, 0.5F, 0.2F),
                "whitespace variants must be rejected without mutation");
        require(!state.setProjectDelay("1/2", 0.3F, 0.5F, 0.2F),
                "unknown noteValue must be rejected without mutation");
        requireEqual(state.getProjectDelayNoteValue(), juce::String{"1/4"},
                     "rejected writes must leave noteValue untouched");
    };

    auto testProjectStateTrackToneJsonRoundTrip = []() {
        silverdaw::ProjectState state;
        require(state.addTrack("t-tone"), "addTrack should succeed");

        const auto findTrackJson = [](const juce::var& tracks,
                                      const juce::String& id) -> juce::var {
            if (auto* arr = tracks.getArray())
            {
                for (const auto& tv : *arr)
                {
                    if (tv.getProperty("id", {}).toString() == id) return tv;
                }
            }
            return {};
        };

        // Fresh track: tone fields are at their defaults and must be
        // absent from the snapshot so saved files / acks stay tidy.
        {
            const auto json = findTrackJson(state.tracksAsJson(), "t-tone");
            require(json.isObject(), "fresh track should appear in tracksAsJson");
            require(!json.hasProperty("toneBassDb"), "default bass must be omitted");
            require(!json.hasProperty("toneMidDb"), "default mid must be omitted");
            require(!json.hasProperty("toneTrebleDb"), "default treble must be omitted");
            require(!json.hasProperty("toneLowCut"), "default lowCut must be omitted");
        }

        // Set a non-default tone and confirm every field round-trips
        // through the snapshot the renderer reads on PROJECT_STATE.
        require(state.setTrackTone("t-tone", 3.5F, -2.0F, 6.0F, true, true),
                "non-default tone should report changed");
        {
            const auto json = findTrackJson(state.tracksAsJson(), "t-tone");
            require(json.isObject(), "track should appear in tracksAsJson");
            requireNear(static_cast<double>(json.getProperty("toneBassDb", 0.0)), 3.5, 0.0001,
                        "bass should round-trip through tracksAsJson");
            requireNear(static_cast<double>(json.getProperty("toneMidDb", 0.0)), -2.0, 0.0001,
                        "mid should round-trip through tracksAsJson");
            requireNear(static_cast<double>(json.getProperty("toneTrebleDb", 0.0)), 6.0, 0.0001,
                        "treble should round-trip through tracksAsJson");
            require(static_cast<bool>(json.getProperty("toneLowCut", false)),
                    "lowCut=true should round-trip through tracksAsJson");
            require(static_cast<bool>(json.getProperty("toneHighCut", false)),
                    "highCut=true should round-trip through tracksAsJson");
        }

        // Reset to defaults: the snapshot must drop the fields again.
        require(state.setTrackTone("t-tone", 0.0F, 0.0F, 0.0F, false, false),
                "reset to default should report changed");
        {
            const auto json = findTrackJson(state.tracksAsJson(), "t-tone");
            require(json.isObject(), "track should still appear in tracksAsJson");
            require(!json.hasProperty("toneBassDb"), "reset bass must be omitted");
            require(!json.hasProperty("toneMidDb"), "reset mid must be omitted");
            require(!json.hasProperty("toneTrebleDb"), "reset treble must be omitted");
            require(!json.hasProperty("toneLowCut"), "reset lowCut must be omitted");
            require(!json.hasProperty("toneHighCut"), "reset highCut must be omitted");
        }
    };

    const std::vector<TestCase> tests{
        {"ProjectState tracks, clips, and dirty tracking", testProjectStateTracksClipsAndDirty},
        {"ProjectState view, library, markers, and replaceTree", testProjectStateViewLibraryMarkersAndReplace},
        {"ProjectState export-settings JSON round-trip", testProjectStateExportSettingsRoundTrip},
        {"ProjectState master volume round-trip", testProjectStateMasterVolumeRoundTrip},
        {"ValueTreeJson round-trip and validation", testValueTreeJsonRoundTripAndValidation},
        {"ProjectFile save/load and view-state update", testProjectFileSaveLoadAndViewState},
        {"PeaksCache round-trip and validation", testPeaksCacheRoundTripAndValidation},
        {"Bridge auth token validation", testBridgeAuthTokenValidation},
        {"ProjectState net-zero edits return to clean", testProjectStateNetZeroDirty},
        {"ProjectState suppressed property drift clears on undo",
         testProjectStateSuppressedPropertiesDoNotStickDirtyAcrossUndo},
        {"ProjectState derived library metadata does not mark dirty",
         testProjectStateDerivedLibraryMetadataDoesNotMarkDirty},
        {"WarpProcessor basic real-time stretch", testWarpProcessorBasicStretch},
        {"Warp timeline duration mapping", testWarpTimelineDurationMapping},
        {"Bridge payload helpers reject malformed values",
         testBridgePayloadHelpersRejectMalformed},
        {"AudioEngine setPreviewWarp survives rapid concurrent calls",
         testAudioEngineSetPreviewWarpUnderRapidCalls},
        {"AudioEngine primeTracksForPlayback is safe and bounded",
         testAudioEnginePrimeTracksForPlaybackIsSafeAndBounded},
        {"ToneEq low-cut is a high-pass and shelves have ±15 dB range",
         testToneEqLowCutDirectionAndShelfRange},
        {"LoudnessAnalyzer reports silent for digital silence", testLoudnessAnalyzerSilence},
        {"LoudnessAnalyzer measures -26 dBFS stereo sine as ~-23 LUFS",
         testLoudnessAnalyzerSineHits23},
        {"LoudnessAnalyzer computeForLinearGainDb shifts LUFS & TP by gain",
         testLoudnessAnalyzerGainShift},
        {"LoudnessAnalyzer rejects non-standard sample rates",
         testLoudnessAnalyzerSampleRateGuard},
        {"ProjectState per-track sends round-trip + default suppression",
         testProjectStateTrackSendsRoundTrip},
        {"ProjectState clip envelope sort / dedupe / clear",
         testProjectStateClipEnvelopeNormalisation},
        {"ProjectState project delay noteValue guard",
         testProjectStateDelayNoteValueGuard},
        {"ProjectState per-track tone round-trips through tracksAsJson",
         testProjectStateTrackToneJsonRoundTrip},
        {"Mixdown snapshot carries per-clip fades",
         testMixdownSnapshotCarriesClipFades},
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
