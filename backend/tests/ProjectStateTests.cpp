// ProjectState core: tracks/clips/dirty tracking, view/library/markers,
// export + master-volume round-trips, net-zero dirty, undo drift, and the
// clip-transition derive/serialise/reconcile invariants.

#include "TestRegistry.h"

#include "AudioEngine.h"
#include "AudioConstants.h"
#include "BridgeAuth.h"
#include "BridgeServer.h"
#include "EdgeFadeSnapshot.h"
#include "LibraryAnalysis.h"
#include "LoudnessAnalyzer.h"
#include "Leveler.h"
#include "MixdownEngine.h"
#include "PayloadHelpers.h"
#include "PeaksCache.h"
#include "ProjectFile.h"
#include "ProjectSession.h"
#include "ProjectState.h"
#include "UndoCommands.h"
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

void testProjectStateBarSettingsRoundTrip()
{
    silverdaw::ProjectState state;
    state.markClean();

    require(state.getBarCounterStart() == 1,
            "fresh project should default barCounterStart to 1");
    require(state.getMixdownStartBar() == 1,
            "fresh project should default mixdownStartBar to 1");

    state.setBarCounterStart(-1);
    require(state.getBarCounterStart() == -1, "setBarCounterStart should round-trip");
    require(state.isDirty(), "setBarCounterStart should mark the project dirty");
    require(state.getUndoManager().canUndo(), "setBarCounterStart must push an undo entry");

    state.setMixdownStartBar(4);
    require(state.getMixdownStartBar() == 4, "setMixdownStartBar should round-trip");

    // Default value suppresses the property so legacy projects round-trip byte-clean.
    state.setBarCounterStart(1);
    require(!state.getTree().hasProperty(juce::Identifier{"barCounterStart"}),
            "default barCounterStart should be stored as absent");
    state.setMixdownStartBar(1);
    require(!state.getTree().hasProperty(juce::Identifier{"mixdownStartBar"}),
            "default mixdownStartBar should be stored as absent");

    // The two settings are independent.
    state.setBarCounterStart(-1);
    require(state.getMixdownStartBar() == 1,
            "changing barCounterStart must not change mixdownStartBar");

    // ValueTreeJson round-trip.
    state.setMixdownStartBar(8);
    const auto encoded = silverdaw::ValueTreeJson::toVar(state.getTree());
    const auto decoded = silverdaw::ValueTreeJson::fromVar(encoded);
    require(static_cast<int>(decoded.getProperty(juce::Identifier{"barCounterStart"}, 0)) == -1,
            "barCounterStart should round-trip through ValueTreeJson");
    require(static_cast<int>(decoded.getProperty(juce::Identifier{"mixdownStartBar"}, 0)) == 8,
            "mixdownStartBar should round-trip through ValueTreeJson");

    // Undo restores the prior value.
    state.getUndoManager().beginNewTransaction();
    state.setMixdownStartBar(2);
    state.getUndoManager().undo();
    require(state.getMixdownStartBar() == 8, "undo should restore the prior mixdownStartBar");
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
                                 {}, {}, "clip", "Source chop", "l1", "c1", 500.0, 750.0),
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
    requireEqual(savedItem.getProperty("kind", {}).toString(), "clip", "saved clip kind should round-trip");
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
                                 {}, {}, "clip", "Chop", "src", "clip", 100.0, 500.0),
            "saved clip add should succeed");
    require(state.isDirty(), "clip add should mark dirty");
    require(state.removeLibraryItem("l2"), "clip remove should succeed");
    require(!state.isDirty(), "clip add+remove should return to clean");
}

void testProjectStateClipTransitions()
{
    silverdaw::ProjectState state;
    require(state.addTrack("t1"), "addTrack should succeed");
    require(state.addLibraryItem("lib1", "C:\\audio\\a.wav", "a.wav", 8000.0, 48000, 2),
            "addLibraryItem should succeed");
    // Left clip spans [0,1000); right clip spans [800,1800) — a proper
    // tail/head overlap of [800,1000).
    require(state.addClip("t1", "c1", "lib1", 0.0, 1000.0), "addClip c1 should succeed");
    require(state.addClip("t1", "c2", "lib1", 800.0, 1000.0), "addClip c2 should succeed");

    auto* recipeObj = new juce::DynamicObject();
    recipeObj->setProperty("kind", "smooth");
    const juce::var smoothRecipe(recipeObj);

    // ── Creation invariants ──────────────────────────────────────────────
    require(!state.addTransition("t1", "trX", "c1", "c1", smoothRecipe),
            "a clip cannot transition with itself");
    require(!state.addTransition("nope", "trX", "c1", "c2", smoothRecipe),
            "addTransition should reject an unknown track");

    require(state.addTransition("t1", "tr1", "c1", "c2", smoothRecipe),
            "valid tail/head overlap should be accepted");
    require(!state.addTransition("t1", "tr1", "c1", "c2", smoothRecipe),
            "duplicate transition id should be rejected");
    require(!state.addTransition("t1", "tr2", "c1", "c2", smoothRecipe),
            "reusing the left clip's tail in another transition should be rejected");

    // ── Edge-fade derivation ─────────────────────────────────────────────
    const auto leftFade = state.getClipEdgeFade("c1");
    require(leftFade.hasFadeOut && !leftFade.hasFadeIn, "left partner fades OUT only");
    requireNear(leftFade.fadeOutStartMs, 800.0, 1e-6, "left fade-out starts at overlap start");
    requireNear(leftFade.fadeOutEndMs, 1000.0, 1e-6, "left fade-out ends at overlap end");

    const auto rightFade = state.getClipEdgeFade("c2");
    require(rightFade.hasFadeIn && !rightFade.hasFadeOut, "right partner fades IN only");
    requireNear(rightFade.fadeInStartMs, 800.0, 1e-6, "right fade-in starts at overlap start");
    requireNear(rightFade.fadeInEndMs, 1000.0, 1e-6, "right fade-in ends at overlap end");

    // ── Recipe → curve derivation ────────────────────────────────────────
    require(leftFade.fadeOutCurve == silverdaw::EdgeFadeCurve::equalPower,
            "smooth recipe derives an equal-power fade-out leg");
    require(rightFade.fadeInCurve == silverdaw::EdgeFadeCurve::equalPower,
            "smooth recipe derives an equal-power fade-in leg");

    auto* linearObj = new juce::DynamicObject();
    linearObj->setProperty("kind", "linear");
    require(state.setTransitionRecipe("t1", "tr1", juce::var(linearObj)),
            "switching tr1 to the linear recipe should change state");
    require(state.getClipEdgeFade("c1").fadeOutCurve == silverdaw::EdgeFadeCurve::linear,
            "linear recipe derives a linear fade-out leg");
    require(state.getClipEdgeFade("c2").fadeInCurve == silverdaw::EdgeFadeCurve::linear,
            "linear recipe derives a linear fade-in leg");
    {
        auto* smoothObj = new juce::DynamicObject();
        smoothObj->setProperty("kind", "smooth");
        require(state.setTransitionRecipe("t1", "tr1", juce::var(smoothObj)),
                "restoring the smooth recipe should change state back");
        require(state.getClipEdgeFade("c1").fadeOutCurve == silverdaw::EdgeFadeCurve::equalPower,
                "restored smooth recipe derives equal-power again");
    }

    // ── Serialisation ────────────────────────────────────────────────────
    {
        const auto tracks = state.tracksAsJson();
        auto* arr = tracks.getArray();
        require(arr != nullptr && arr->size() == 1, "tracksAsJson should yield one track");
        auto* trackObj = (*arr)[0].getDynamicObject();
        require(trackObj->hasProperty("transitions"), "track with a transition must emit transitions");
        auto* trs = trackObj->getProperty("transitions").getArray();
        require(trs != nullptr && trs->size() == 1, "exactly one transition should serialise");
        auto* trObj = (*trs)[0].getDynamicObject();
        require(trObj->getProperty("leftClipId").toString() == "c1", "leftClipId should round-trip");
        require(trObj->getProperty("rightClipId").toString() == "c2", "rightClipId should round-trip");
        auto* recipe = trObj->getProperty("recipe").getDynamicObject();
        require(recipe != nullptr && recipe->getProperty("kind").toString() == "smooth",
                "recipe kind should serialise as smooth");
    }

    // ── Containment is rejected ──────────────────────────────────────────
    // c3 sits fully inside c1 ([200,400) ⊂ [0,1000)) — not a tail/head shape.
    require(state.addClip("t1", "c3", "lib1", 200.0, 200.0), "addClip c3 should succeed");
    require(!state.addTransition("t1", "trC", "c1", "c3", smoothRecipe),
            "a contained clip is not a valid tail/head transition");
    require(state.removeClip("c3"), "cleanup c3");

    // ── Third-clip intrusion is rejected ─────────────────────────────────
    require(state.addClip("t1", "c4", "lib1", 850.0, 50.0), "addClip c4 should succeed");
    require(!state.addTransition("t1", "trI", "c1", "c2", smoothRecipe),
            "a third clip intruding the overlap blocks (a new) transition");
    // The pre-existing tr1 now has an intruder too → reconcile must drop it.
    require(state.reconcileTransitions(false), "reconcile should remove the intruded transition");
    require(!state.getClipEdgeFade("c1").any(), "left partner fade cleared after reconcile");
    require(state.removeClip("c4"), "cleanup c4");

    // ── Reconcile on geometry change ─────────────────────────────────────
    require(state.addTransition("t1", "tr3", "c1", "c2", smoothRecipe),
            "transition should be re-addable once the intruder is gone");
    // Move c2 fully past c1 ([1200,2200)) so the overlap vanishes.
    require(state.setClipTrim("c2", 1200.0, 0.0, 1000.0), "relocate c2 beyond c1");
    require(state.reconcileTransitions(true), "reconcile should drop the now-non-overlapping transition");
    require(!state.getClipEdgeFade("c1").any() && !state.getClipEdgeFade("c2").any(),
            "both partner fades cleared once the transition is gone");
    require(!state.hasAnyTransition(), "no transitions should remain");
}

// ── Project-BPM seeding (first clip establishes the project tempo) ───────────

silverdaw::BridgeServer makeSilentBridge()
{
    return silverdaw::BridgeServer(
        "test-token", [](silverdaw::BridgeServer&, const juce::String&, const juce::var&) {});
}

// Stages a library source with a known BPM and places one clip from it on a
// track, the minimal state `maybeSeedProjectBpmFor` needs to seed.
void stageSeededSource(silverdaw::ProjectState& state, const juce::String& itemId, double bpm)
{
    require(state.addLibraryItem(itemId, "C:\\audio\\" + itemId + ".wav", itemId + ".wav"),
            "source library item should add");
    require(state.setLibraryItemBpm(itemId, bpm), "source BPM should apply");
    require(state.addTrack("t-" + itemId), "track should add");
    require(state.addClip("t-" + itemId, "c-" + itemId, itemId, 0.0, 1000.0),
            "clip from source should add");
}

void testProjectStateBpmSeededRoundTrip()
{
    silverdaw::ProjectState state;
    require(!state.isBpmSeeded(), "a fresh project is not yet BPM-seeded");
    const bool dirtyBefore = state.isDirty();
    state.setBpmSeeded(true);
    require(state.isBpmSeeded(), "setBpmSeeded(true) should stick");
    require(state.isDirty() == dirtyBefore, "seeding state must not mark the project dirty");

    const auto file = makeTempDir("bpm-seeded").getChildFile("p.silverdaw");
    require(silverdaw::ProjectFile::save(file, state).wasOk(), "save should succeed");

    silverdaw::ProjectState reloaded;
    require(silverdaw::ProjectFile::load(file, reloaded).ok, "load should succeed");
    require(reloaded.isBpmSeeded(), "bpmSeeded should round-trip through save/load");
}

void testFirstClipSeedsProjectBpm()
{
    silverdaw::ProjectState state;
    auto bridge = makeSilentBridge();
    stageSeededSource(state, "l1", 128.0);

    silverdaw::maybeSeedProjectBpmFor("l1", state, bridge);
    requireNear(state.getBpm(), 128.0, 1e-6, "first clip should seed the project tempo");
    require(state.isBpmSeeded(), "seeding should set the bpmSeeded flag");
}

void testLowConfidenceFirstClipSeeds()
{
    silverdaw::ProjectState state;
    auto bridge = makeSilentBridge();
    stageSeededSource(state, "l1", 95.0);
    // A merely-uncertain auto-detection must not be treated as a sample.
    require(state.setLibraryItemLowConfidence("l1", true), "low-confidence flag should apply");

    silverdaw::maybeSeedProjectBpmFor("l1", state, bridge);
    requireNear(state.getBpm(), 95.0, 1e-6, "low-confidence first clip should still seed tempo");
    require(state.isBpmSeeded(), "low-confidence seed should set the flag");
}

void testStemBpmsDoNotBlockFirstSeed()
{
    silverdaw::ProjectState state;
    auto bridge = makeSilentBridge();
    stageSeededSource(state, "l1", 102.0);
    // Stems separated from a library-only source already carry a BPM; this must
    // not be mistaken for an earlier seed (the regression this guards against).
    for (const auto* stem : {"l2", "l3", "l4", "l5"})
    {
        require(state.addLibraryItem(stem, juce::String("C:\\audio\\") + stem + ".wav"),
                "stem library item should add");
        require(state.setLibraryItemBpm(stem, 102.0), "stem inherits source BPM");
    }

    silverdaw::maybeSeedProjectBpmFor("l1", state, bridge);
    requireNear(state.getBpm(), 102.0, 1e-6,
                "first dropped clip should seed even when stems already have a BPM");
    require(state.isBpmSeeded(), "seed should set the flag");
}

void testSeededProjectIsNotReSeeded()
{
    silverdaw::ProjectState state;
    auto bridge = makeSilentBridge();
    stageSeededSource(state, "l1", 120.0);
    silverdaw::maybeSeedProjectBpmFor("l1", state, bridge);
    requireNear(state.getBpm(), 120.0, 1e-6, "first seed establishes tempo");

    // A later clip from a different source must not override the project tempo.
    stageSeededSource(state, "l2", 150.0);
    silverdaw::maybeSeedProjectBpmFor("l2", state, bridge);
    requireNear(state.getBpm(), 120.0, 1e-6, "established tempo is preserved against later clips");
}

void testExplicitSampleDoesNotSeed()
{
    silverdaw::ProjectState state;
    auto bridge = makeSilentBridge();
    const double original = state.getBpm();
    stageSeededSource(state, "l1", 175.0);
    require(state.setLibraryItemAudioType("l1", "simple"), "explicit simple classification applies");

    silverdaw::maybeSeedProjectBpmFor("l1", state, bridge);
    requireNear(state.getBpm(), original, 1e-6, "a user-classified sample must not seed the tempo");
    require(!state.isBpmSeeded(), "a blocked seed must leave the project unseeded");
}

void testLibraryItemDurationLookup()
{
    silverdaw::ProjectState state;
    require(state.addLibraryItem("l1", "C:\\audio\\loop.wav", "loop.wav", 4321.0, 48000, 2),
            "library item with a duration should add");
    requireNear(state.getLibraryItemDurationMs("l1"), 4321.0, 1e-6,
                "duration getter should return the stored duration");
    requireNear(state.getLibraryItemDurationMs("missing"), 0.0, 1e-6,
                "duration getter should return 0 for an unknown item");
}

void testProjectStateRenameIsNotUndoable()
{
    silverdaw::ProjectState state;
    state.markClean();

    // Make a normal undoable edit so there is undo history to walk.
    state.getUndoManager().beginNewTransaction();
    require(state.addTrack("t1"), "addTrack should succeed");
    require(state.getUndoManager().canUndo(), "addTrack must push an undo entry");

    // Renaming marks the project dirty but must not enter the undo stack.
    state.getUndoManager().beginNewTransaction();
    state.setName("My Mashup");
    requireEqual(state.getName(), "My Mashup", "setName should update the project name");
    require(state.isDirty(), "setName should mark the project dirty");

    // Undo should revert the track edit, leaving the renamed name untouched.
    require(state.getUndoManager().undo(), "undo should walk the prior transaction");
    requireEqual(state.getName(), "My Mashup",
                 "undo after a rename must not revert the project name");
    require(!state.hasTrack("t1"), "undo should have removed the track");
}

// An explicit EDIT_GROUP_BEGIN/END bracket must fold every undoable command in between into ONE
// transaction, so a single Undo reverses the whole compound action (split/duplicate/paste/etc.).
void testUndoGroupCollapsesCompoundEditToOneStep()
{
    silverdaw::ProjectState state;
    state.markClean();

    // Prior, separate edit so there is history to leave untouched.
    state.getUndoManager().beginNewTransaction("baseline");
    require(state.addTrack("t-base"), "baseline addTrack should succeed");

    // Simulate a compound action: several undoable mutations bracketed in one group. The
    // per-command begin (as the dispatcher would call it) must be suppressed inside the group.
    silverdaw::beginUndoGroup("Split clip", state);
    silverdaw::beginUndoTransactionIfNeeded("CLIP_ADD", juce::var(), state);
    require(state.addTrack("t-a"), "first grouped mutation should succeed");
    silverdaw::beginUndoTransactionIfNeeded("CLIP_RENAME", juce::var(), state);
    require(state.addTrack("t-b"), "second grouped mutation should succeed");
    silverdaw::endUndoGroup();

    requireEqual(state.getUndoManager().getUndoDescription(), juce::String("Split clip"),
                 "the group transaction carries the supplied label");

    // A single undo must revert the ENTIRE group, not just the last mutation.
    state.getUndoManager().beginNewTransaction();
    require(state.getUndoManager().undo(), "undo should walk the grouped transaction");
    require(!state.hasTrack("t-a"), "group undo must revert the first mutation");
    require(!state.hasTrack("t-b"), "group undo must revert the second mutation");
    require(state.hasTrack("t-base"), "group undo must NOT revert the baseline edit");

    // And it is exactly one step: the next undo reaches the baseline.
    state.getUndoManager().beginNewTransaction();
    require(state.getUndoManager().undo(), "a second undo walks the baseline transaction");
    require(!state.hasTrack("t-base"), "second undo reverts the baseline");
}

// Nested groups (a wrapped action that itself calls another wrapped action) still collapse to one
// transaction via the depth counter.
void testNestedUndoGroupsCollapseToOneStep()
{
    silverdaw::ProjectState state;
    state.markClean();

    silverdaw::beginUndoGroup("Outer", state);
    require(state.addTrack("n-1"), "outer mutation should succeed");
    silverdaw::beginUndoGroup("Inner", state);
    require(state.addTrack("n-2"), "inner mutation should succeed");
    silverdaw::endUndoGroup();
    // Still inside the outer group: this must not open a second transaction.
    require(state.addTrack("n-3"), "post-inner mutation should succeed");
    silverdaw::endUndoGroup();

    state.getUndoManager().beginNewTransaction();
    require(state.getUndoManager().undo(), "one undo reverses the whole nested group");
    require(!state.hasTrack("n-1") && !state.hasTrack("n-2") && !state.hasTrack("n-3"),
            "nested group undo reverts every mutation in one step");
}

// Faithful replay of the renderer "Duplicate clip" message sequence: a single group containing
// CLIP_ADD (new clip) + a no-op TRACK_GAIN (re-push of the unchanged track gain) + CLIP_RENAME.
// Regression guard for the bug where a duplicated, named clip needed several undos because the
// trailing CLIP_RENAME landed in its own transaction at the top of the stack.
void testDuplicateClipGroupUndoesInOneStep()
{
    silverdaw::ProjectState state;
    require(state.addTrack("t1"), "track add should succeed");
    // The source clip is its own prior edit, so it must survive the duplicate's undo.
    state.getUndoManager().beginNewTransaction("Add source clip");
    require(state.addClip("t1", "src", "lib1", 0.0, 1000.0, 0.0, -1), "source clip add should succeed");
    const float gain = state.getEffectiveTrackGain("t1");

    // Duplicate: one group, dispatcher's per-command begin suppressed throughout.
    silverdaw::beginUndoGroup("Duplicate clip", state);
    silverdaw::beginUndoTransactionIfNeeded("CLIP_ADD", juce::var(), state);
    require(state.addClip("t1", "dup", "lib1", 1000.0, 1000.0, 0.0, -1), "duplicate clip add should succeed");
    silverdaw::beginUndoTransactionIfNeeded("TRACK_GAIN", juce::var(), state);
    state.setTrackGain("t1", gain); // unchanged value → JUCE records no action
    silverdaw::beginUndoTransactionIfNeeded("CLIP_RENAME", juce::var(), state);
    require(state.setClipName("dup", "My Clip"), "duplicate rename should succeed");
    silverdaw::endUndoGroup();

    // A single undo must remove the duplicate (and its name) while keeping the source.
    state.getUndoManager().beginNewTransaction();
    require(state.getUndoManager().undo(), "one undo should reverse the whole duplicate group");
    const auto idsAfter = silverdaw::collectClipIds(state);
    require(!idsAfter.contains("dup"), "duplicate clip must be gone after one undo");
    require(idsAfter.contains("src"), "the source clip must survive the duplicate's undo");
}

} // namespace

void addProjectStateTests(std::vector<TestCase>& tests)
{
    tests.push_back({"ProjectState tracks, clips, and dirty tracking", testProjectStateTracksClipsAndDirty});
    tests.push_back({"ProjectState view, library, markers, and replaceTree", testProjectStateViewLibraryMarkersAndReplace});
    tests.push_back({"ProjectState export-settings JSON round-trip", testProjectStateExportSettingsRoundTrip});
    tests.push_back({"ProjectState master volume round-trip", testProjectStateMasterVolumeRoundTrip});
    tests.push_back({"ProjectState bar settings round-trip", testProjectStateBarSettingsRoundTrip});
    tests.push_back({"ProjectState net-zero edits return to clean", testProjectStateNetZeroDirty});
    tests.push_back({"ProjectState suppressed property drift clears on undo", testProjectStateSuppressedPropertiesDoNotStickDirtyAcrossUndo});
    tests.push_back({"ProjectState derived library metadata does not mark dirty", testProjectStateDerivedLibraryMetadataDoesNotMarkDirty});
    tests.push_back({"ProjectState clip transitions: derive, serialise, invariants, reconcile", testProjectStateClipTransitions});
    tests.push_back({"ProjectState bpmSeeded flag persists across save/load", testProjectStateBpmSeededRoundTrip});
    tests.push_back({"First on-track clip seeds project BPM", testFirstClipSeedsProjectBpm});
    tests.push_back({"Low-confidence first clip still seeds project BPM", testLowConfidenceFirstClipSeeds});
    tests.push_back({"Pre-existing library BPMs do not block the first seed", testStemBpmsDoNotBlockFirstSeed});
    tests.push_back({"Seeded project BPM is not overridden by later clips", testSeededProjectIsNotReSeeded});
    tests.push_back({"User-classified sample does not seed project BPM", testExplicitSampleDoesNotSeed});
    tests.push_back({"Library item duration lookup by id", testLibraryItemDurationLookup});
    tests.push_back({"ProjectState rename is not undoable", testProjectStateRenameIsNotUndoable});
    tests.push_back({"Undo group collapses a compound edit to one step", testUndoGroupCollapsesCompoundEditToOneStep});
    tests.push_back({"Nested undo groups collapse to one step", testNestedUndoGroupsCollapseToOneStep});
    tests.push_back({"Duplicate-clip group undoes in one step", testDuplicateClipGroupUndoesInOneStep});
}

} // namespace silverdaw::tests
