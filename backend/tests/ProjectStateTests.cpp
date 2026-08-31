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
#include "ClipCommands.h"
#include "TempoCorrectionCommands.h"
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
        [&](bool dirty, silverdaw::ProjectState::DirtyReason)
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

    const std::array<Case, 4> cases{{
        {"playhead", [](silverdaw::ProjectState& s) { s.setPlayheadMs(5000.0); }},
        {"viewScrollX", [](silverdaw::ProjectState& s) { s.setViewScrollX(640.0); }},
        {"viewPxPerSecond", [](silverdaw::ProjectState& s) { s.setViewPxPerSecond(180.0); }},
        {"timelineSelection", [](silverdaw::ProjectState& s)
            {
                s.setViewTimelineSelection(
                    silverdaw::ProjectState::TimelineSelectionView{1000.0, 2500.0, true});
            }},
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
            [&](bool d, silverdaw::ProjectState::DirtyReason)
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

    silverdaw::ProjectState selectionState;
    selectionState.setViewTimelineSelection(
        silverdaw::ProjectState::TimelineSelectionView{1000.0, 2500.0, true});
    selectionState.setViewTimelineSelection(std::nullopt);
    require(! selectionState.getTree().hasProperty(
                juce::Identifier{"viewTimelineSelectionStartMs"}),
            "clearing timeline selection should remove its saved start");
    require(! selectionState.getTree().hasProperty(
                juce::Identifier{"viewTimelineSelectionEndMs"}),
            "clearing timeline selection should remove its saved end");
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
    state.setDirtyChangedCallback([&](bool, silverdaw::ProjectState::DirtyReason) { ++transitions; });

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

void testProjectLengthRepairsTimelineSelection()
{
    silverdaw::ProjectState state;
    state.setProjectLengthMs(10000.0);

    state.setViewTimelineSelection(
        silverdaw::ProjectState::TimelineSelectionView{6000.0, 9000.0, true});
    state.setProjectLengthMs(8000.0);
    const auto clamped = state.getViewTimelineSelection();
    require(clamped.has_value(), "shortening across a selection should retain its valid prefix");
    requireNear(clamped->startMs, 6000.0, 0.0001, "selection start should remain unchanged");
    requireNear(clamped->endMs, 8000.0, 0.0001, "selection end should clamp to project length");
    require(clamped->loop, "selection loop state should survive a valid clamp");

    state.setViewTimelineSelection(
        silverdaw::ProjectState::TimelineSelectionView{8000.0, 9000.0, true});
    state.setProjectLengthMs(8000.0);
    require(!state.getViewTimelineSelection().has_value(),
            "shortening to a selection start should clear the empty selection");
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
    require(state.getMarkerCount() == 2, "marker count should reflect stored markers");
    require(state.hasMarkerNear(1000.5), "marker proximity should include its tolerance edge");
    require(!state.hasMarkerNear(1002.0), "marker proximity should reject distant positions");
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

void testProjectStateReanalyseKeepsDerivedKind()
{
    silverdaw::ProjectState state;
    require(state.addLibraryItem("src", "C:\\audio\\song.wav", "song.wav", 300000.0, 48000, 2),
            "source item should add");
    require(state.addLibraryItem("smp", "C:\\proj\\samples\\S\\s.wav", "s.wav", 4500.0, 48000, 2,
                                 {}, {}, "sample", "Drum loop", "src", {}, 15230.0, 4500.0),
            "sample item should add");

    const juce::Identifier libraryId{"LIBRARY"};
    const juce::Identifier kindId{"kind"};
    auto sampleItem = state.getTree().getChildWithName(libraryId).getChildWithProperty(
        juce::Identifier{"id"}, "smp");
    requireEqual(sampleItem.getProperty(kindId).toString(), "sample", "sample kind should store");

    // LIBRARY_REANALYSE re-adds an existing item with no kind; that must not demote it.
    require(state.addLibraryItem("smp", "C:\\proj\\samples\\S\\s.wav", "s.wav", 4500.0, 48000, 2,
                                 "C:\\cache\\s.wav"),
            "reanalyse re-add should succeed");
    requireEqual(sampleItem.getProperty(kindId).toString(), "sample",
                 "reanalyse must not demote a sample to a plain source");
    requireEqual(sampleItem.getProperty(juce::Identifier{"sourceItemId"}).toString(), "src",
                 "reanalyse must keep the sample's provenance link");

    // A new item with no kind still defaults to source.
    require(state.addLibraryItem("plain", "C:\\audio\\b.wav", "b.wav", 1000.0, 48000, 2),
            "plain item should add");
    requireEqual(state.getTree()
                     .getChildWithName(libraryId)
                     .getChildWithProperty(juce::Identifier{"id"}, "plain")
                     .getProperty(kindId)
                     .toString(),
                 "source", "a new item with no kind should default to source");
}

// A one-shot has no pulse: classifying an item simple must strip any tempo grid it
// already had, and later analysis must not be able to put one back. Key is kept —
// a one-shot can be in a key.
void testProjectStateSimpleClassificationHasNoTempo()
{
    silverdaw::ProjectState state;
    const juce::Identifier libraryId{"LIBRARY"};
    const juce::Identifier idId{"id"};
    const juce::Identifier bpmId{"bpm"};
    const juce::Identifier beatsId{"beats"};
    const juce::Identifier anchorId{"beatAnchorSec"};
    const juce::Identifier lowConfId{"lowConfidence"};
    const juce::Identifier keyId{"key"};

    require(state.addLibraryItem("hit", "C:\\audio\\hit.wav", "hit.wav", 900.0, 48000, 2),
            "item should add");
    require(state.setLibraryItemBpm("hit", 120.0), "bpm should apply while unclassified");
    require(state.setLibraryItemBeats("hit", {0.0, 0.5, 1.0}), "beats should apply");
    require(state.setLibraryItemBeatAnchor("hit", 0.25), "anchor should apply");
    require(state.setLibraryItemLowConfidence("hit", true), "low confidence should apply");
    require(state.setLibraryItemKey("hit", "Am"), "key should apply");

    auto item = state.getTree().getChildWithName(libraryId).getChildWithProperty(idId, "hit");
    require(item.hasProperty(bpmId), "bpm should be present before classification");

    require(state.setLibraryItemAudioType("hit", "simple"), "simple classification applies");
    require(!item.hasProperty(bpmId), "classifying simple must strip the bpm");
    require(!item.hasProperty(beatsId), "classifying simple must strip the beats");
    require(!item.hasProperty(anchorId), "classifying simple must strip the beat anchor");
    require(!item.hasProperty(lowConfId), "classifying simple must strip the confidence flag");
    requireEqual(item.getProperty(keyId).toString(), "Am", "classifying simple must keep the key");

    // Reanalysis / detection must not be able to re-add a tempo to a one-shot.
    state.setLibraryItemBpm("hit", 128.0);
    state.setLibraryItemBeats("hit", {0.0, 0.5});
    state.setLibraryItemBeatAnchor("hit", 0.1);
    require(!item.hasProperty(bpmId), "a one-shot must not accept a detected bpm");
    require(!item.hasProperty(beatsId), "a one-shot must not accept detected beats");
    require(!item.hasProperty(anchorId), "a one-shot must not accept a beat anchor");
    require(!state.setLibraryItemManualTempo("hit", 128.0, {0.0}, 0.0),
            "a one-shot must refuse a hand-set tempo");
    require(!item.hasProperty(bpmId), "a refused manual tempo must leave no bpm");

    // Reclassifying as music reopens tempo writes.
    require(state.setLibraryItemAudioType("hit", "music"), "music classification applies");
    require(state.setLibraryItemBpm("hit", 128.0), "a musical item accepts a bpm again");
    require(std::abs(static_cast<double>(item.getProperty(bpmId)) - 128.0) < 1e-9,
            "the reinstated bpm should store");
}

void testProjectStateMusicalLengthOutranksDetectedBpm()
{
    // A clip cut to a number of bars must stay that number of bars however its BPM is
    // later re-detected. Detection on a two-bar excerpt sees only about eight beats and
    // lands a few percent out, which shows up as a clip that no longer warps onto the
    // grid. The recorded beat count is a measurement of the audio, so it wins.
    silverdaw::ProjectState state;

    // 4536.83 ms is exactly 8 beats (two bars) at 105.804 BPM.
    const double durationMs = 4536.83;
    require(state.addLibraryItem("src", "C:\\audio\\track.wav", "track.wav", 268094.0, 44100, 2),
            "source should add");
    require(state.setLibraryItemBpm("src", 105.804), "source bpm should apply");
    require(state.addLibraryItem("cut", "C:\\audio\\cut.wav", "cut.wav", durationMs, 44100, 2,
                                 {}, {}, "sample", {}, "src"),
            "cut should add");

    require(state.setLibraryItemMusicalBeats("cut", 8), "musical length should apply");
    require(state.getLibraryItemMusicalBeats("cut") == 8, "musical length should read back");
    require(std::abs(state.getLibraryItemBpm("cut") - (8.0 * 60000.0 / durationMs)) < 1e-9,
            "the musical length should resolve the source bpm");

    // A mis-detection on the cut's own audio must not move it off the grid.
    require(state.setLibraryItemBpm("cut", 100.768), "detected bpm should apply");
    require(std::abs(state.getLibraryItemBpm("cut") - (8.0 * 60000.0 / durationMs)) < 1e-9,
            "a re-detected bpm must not override the recorded musical length");

    // A hand-set tempo is an explicit instruction and drops the length.
    require(state.setLibraryItemManualTempo("cut", 90.0, {}, 0.0), "manual tempo should apply");
    require(state.getLibraryItemMusicalBeats("cut") == 0, "manual tempo should clear the length");
    require(std::abs(state.getLibraryItemBpm("cut") - 90.0) < 1e-9,
            "a hand-set tempo must win once the length is cleared");

    // A reanalysis, by contrast, keeps it — that is the whole point.
    require(state.setLibraryItemMusicalBeats("cut", 8), "musical length should re-apply");
    require(state.clearLibraryItemAnalysis("cut"), "reanalysis should clear the grid");
    require(state.getLibraryItemMusicalBeats("cut") == 8,
            "a reanalysis must preserve the recorded musical length");

    // A one-shot has no pulse, so it may not hold a musical length either.
    require(state.setLibraryItemAudioType("cut", "simple"), "one-shot classification applies");
    require(state.getLibraryItemMusicalBeats("cut") == 0,
            "classifying as a one-shot should strip the musical length");
    require(state.getLibraryItemBpm("cut") <= 0.0, "a one-shot must resolve no tempo");
}

void testProjectStateRetimesClipsOnTempoChange()
{
    // Changing the project tempo must keep the arrangement's musical shape: a clip on
    // bar 9 stays on bar 9. Without this, warped clips re-stretch in place while their
    // starts stay in milliseconds, so the arrangement drifts apart on every tempo edit.
    silverdaw::ProjectState state;
    require(state.addLibraryItem("src", "C:\\audio\\track.wav", "track.wav", 60000.0, 44100, 2),
            "source should add");
    require(state.addTrack("t1"), "track should add");
    require(state.addClip("t1", "c0", "src", 0.0, 2000.0), "clip at zero should add");
    require(state.addClip("t1", "c1", "src", 4000.0, 2000.0), "clip should add");
    require(state.addClip("t1", "c2", "src", 8000.0, 2000.0), "second clip should add");

    std::vector<std::pair<juce::String, double>> moves;
    const int retimed = state.retimeClipsForTempoChange(
        120.0, 60.0, [&](const juce::String& id, double ms) { moves.emplace_back(id, ms); });

    // Halving the tempo doubles the milliseconds each bar occupies.
    require(retimed == 2, "only the two clips away from zero should move");
    require(moves.size() == 2, "every move should be reported so the engine stays in sync");
    require(std::abs(moves[0].second - 8000.0) < 1e-9, "first clip should scale by oldBpm/newBpm");
    require(std::abs(moves[1].second - 16000.0) < 1e-9, "second clip should scale identically");
    // The musical gap between them is preserved, which is the point.
    require(std::abs((moves[1].second - moves[0].second) - 8000.0) < 1e-9,
            "the gap between clips should scale with the tempo");

    require(state.retimeClipsForTempoChange(60.0, 60.0, nullptr) == 0,
            "an unchanged tempo should move nothing");
    require(state.retimeClipsForTempoChange(0.0, 60.0, nullptr) == 0,
            "an unknown previous tempo should move nothing");
}

void testProjectStateRetimesTrackAutomationOnTempoChange()
{
    // Reported: a tempo change moved the clips but left track automation at its
    // millisecond positions, so a filter sweep written for the drop ended up shaping
    // whatever now happens to sit at that instant. Automation names musical places
    // just as clips and markers do.
    silverdaw::ProjectState state;
    require(state.addTrack("t1"), "track should add");

    const auto makePoint = [](double timeMs, double value) {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("timeMs", timeMs);
        obj->setProperty("value", value);
        return juce::var(obj);
    };
    juce::Array<juce::var> points;
    points.add(makePoint(0.0, 0.2));
    points.add(makePoint(4000.0, 0.6));
    points.add(makePoint(8000.0, 1.0));
    require(state.setTrackAutomation("t1", "filter", points), "automation lane should apply");

    std::vector<std::pair<juce::String, juce::String>> republished;
    // Halving the tempo doubles the milliseconds each bar occupies.
    const int retimed = state.retimeTrackAutomationForTempoChange(
        120.0, 60.0,
        [&](const juce::String& trackId, const juce::String& paramId, const juce::Array<juce::var>&)
        { republished.emplace_back(trackId, paramId); });

    require(retimed == 1, "the one lane holding moved points should be retimed");
    require(republished.size() == 1 && republished[0].first == "t1"
                && republished[0].second == "filter",
            "the changed lane should be reported so the engine snapshot is refreshed");

    const auto stored = state.getTrackAutomation("t1", "filter");
    require(stored.size() == 3, "every breakpoint should survive the retime");
    const auto timeAt = [&](int i) {
        return static_cast<double>(stored.getReference(i).getProperty("timeMs", -1.0));
    };
    const auto valueAt = [&](int i) {
        return static_cast<double>(stored.getReference(i).getProperty("value", -1.0));
    };
    requireNear(timeAt(0), 0.0, 1e-9, "a point on bar 1 stays on bar 1");
    requireNear(timeAt(1), 8000.0, 1e-9, "a breakpoint should scale by oldBpm/newBpm");
    requireNear(timeAt(2), 16000.0, 1e-9, "every breakpoint should scale identically");
    // The shape is a function of the musical position, not of the tempo.
    requireNear(valueAt(0), 0.2, 1e-9, "values must not be touched");
    requireNear(valueAt(1), 0.6, 1e-9, "values must not be touched");
    requireNear(valueAt(2), 1.0, 1e-9, "values must not be touched");

    require(state.retimeTrackAutomationForTempoChange(60.0, 60.0, nullptr) == 0,
            "an unchanged tempo should move nothing");
    require(state.retimeTrackAutomationForTempoChange(0.0, 60.0, nullptr) == 0,
            "an unknown previous tempo should move nothing");
}

void testProjectStateRetimesClipEnvelopesOnTempoChange()
{
    // Reported: a clip's volume shape did not keep its relative position across a
    // tempo change, so it changed the volume at the wrong point in the clip. The
    // breakpoints are post-warp clip-local ms, so they follow the clip's timeline
    // footprint — which is per clip, not the global tempo scale.
    silverdaw::ProjectState state;
    state.setBpm(120.0);
    state.setBpmSeeded(true);
    require(state.addLibraryItem("src", "C:\\audio\\loop.wav", "loop.wav", 8000.0, 44100, 2),
            "source should add");
    require(state.setLibraryItemBpm("src", 120.0), "source BPM should apply");
    require(state.addTrack("t1"), "track should add");

    const auto makePoint = [](double timeMs, double gain) {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("timeMs", timeMs);
        obj->setProperty("gain", gain);
        return juce::var(obj);
    };
    juce::Array<juce::var> shape;
    shape.add(makePoint(0.0, 1.0));
    // A fade written across the second half of the clip.
    shape.add(makePoint(4000.0, 1.0));
    shape.add(makePoint(8000.0, 0.0));

    // Follows the project tempo, so halving it doubles this clip's footprint.
    require(state.addClip("t1", "following", "src", 0.0, 8000.0), "following clip should add");
    require(state.setClipWarp("following", true, std::nullopt, std::nullopt, false, std::nullopt,
                              std::nullopt, std::nullopt),
            "following clip should warp to the project tempo");
    require(state.setClipEnvelope("following", shape), "shape should apply to the following clip");

    // A pinned ratio opts out of project-BPM tracking, so this clip does not re-stretch.
    require(state.addClip("t1", "pinned", "src", 20000.0, 8000.0), "pinned clip should add");
    require(state.setClipWarp("pinned", true, std::nullopt, 1.5, false, std::nullopt, std::nullopt,
                              std::nullopt),
            "pinned clip should hold its own ratio");
    require(state.setClipEnvelope("pinned", shape), "shape should apply to the pinned clip");

    // An unwarped clip plays at its native length whatever the project tempo is.
    require(state.addClip("t1", "dry", "src", 40000.0, 8000.0), "unwarped clip should add");
    require(state.setClipEnvelope("dry", shape), "shape should apply to the unwarped clip");

    const auto before = state.snapshotClipFootprints();
    require(before.size() == 3, "only clips carrying a shape need measuring");

    state.setBpm(60.0);

    std::vector<juce::String> republished;
    const int retimed = state.retimeClipEnvelopesForFootprintChange(
        before, [&](const juce::String& clipId, const juce::Array<juce::var>&)
        { republished.push_back(clipId); });

    require(retimed == 1, "only the clip that actually re-stretched should be retimed");
    require(republished.size() == 1 && republished[0] == "following",
            "the changed clip should be reported so the engine snapshot is refreshed");

    const auto timeAt = [&](const juce::String& clipId, int i) {
        const auto pts = state.getClipEnvelope(clipId);
        return static_cast<double>(pts.getReference(i).getProperty("timeMs", -1.0));
    };
    const auto gainAt = [&](const juce::String& clipId, int i) {
        const auto pts = state.getClipEnvelope(clipId);
        return static_cast<double>(pts.getReference(i).getProperty("gain", -1.0));
    };

    // The clip now occupies 16000 ms, and the fade still starts at its midpoint.
    requireNear(state.getClipEffectiveTiming("following").durationMs, 16000.0, 1e-9,
                "halving the tempo should double a following clip's footprint");
    requireNear(timeAt("following", 0), 0.0, 1e-9, "a breakpoint at the clip start stays there");
    requireNear(timeAt("following", 1), 8000.0, 1e-9,
                "a breakpoint should keep its relative position in the clip");
    requireNear(timeAt("following", 2), 16000.0, 1e-9,
                "the shape should still end at the end of the clip");
    requireNear(gainAt("following", 2), 0.0, 1e-9, "gains must not be touched");

    // Neither of these clips changed length, so their shapes must not move.
    requireNear(timeAt("pinned", 2), 8000.0, 1e-9,
                "a pinned ratio does not re-stretch, so its shape must stay put");
    requireNear(timeAt("dry", 2), 8000.0, 1e-9,
                "an unwarped clip does not re-stretch, so its shape must stay put");

    require(state.retimeClipEnvelopesForFootprintChange({}, nullptr) == 0,
            "no captured footprints should move nothing");
}

void testProjectStateRetimesMarkersOnTempoChange()
{
    // Reported: markers stayed at their millisecond positions across a tempo change,
    // so the arrangement moved out from under them. A marker names a musical place —
    // the drop, the last bar of the intro — so it travels with the material.
    silverdaw::ProjectState state;
    require(state.addMarker("m0", 0.0), "marker at zero should add");
    require(state.addMarker("m1", 4000.0), "marker should add");
    require(state.addMarker("m2", 8000.0), "second marker should add");

    // Halving the tempo doubles the milliseconds each bar occupies.
    require(state.retimeMarkersForTempoChange(120.0, 60.0) == 2,
            "only the two markers away from zero should move");

    const auto markers = state.markersAsJson();
    require(markers.isArray() && markers.getArray()->size() == 3, "all markers should survive");
    auto positionOf = [&](const juce::String& id) {
        for (const auto& entry : *markers.getArray())
            if (entry.getProperty("id", {}).toString() == id)
                return static_cast<double>(entry.getProperty("positionMs", 0.0));
        return -1.0;
    };
    require(std::abs(positionOf("m0")) < 1e-9, "a marker on bar 1 stays on bar 1");
    require(std::abs(positionOf("m1") - 8000.0) < 1e-9, "a marker should scale by oldBpm/newBpm");
    require(std::abs(positionOf("m2") - 16000.0) < 1e-9, "every marker should scale identically");

    require(state.retimeMarkersForTempoChange(60.0, 60.0) == 0,
            "an unchanged tempo should move nothing");
    require(state.retimeMarkersForTempoChange(0.0, 60.0) == 0,
            "an unknown previous tempo should move nothing");
}

void testProjectStateSourceBpmResolverContract()
{
    // The renderer's `libraryItemSourceBpm` must resolve the same original BPM this
    // does, for every case below. A clip has ONE original tempo; when the two
    // processes derived their own, a clip could be drawn stretched while the engine
    // played it unwarped.
    silverdaw::ProjectState state;

    require(state.addLibraryItem("track", "C:\\audio\\track.wav", "track.wav", 60000.0, 48000, 2),
            "source should add");
    require(state.setLibraryItemBpm("track", 105.5), "source bpm should apply");

    // 1. An item's own BPM wins.
    require(std::abs(state.getLibraryItemBpm("track") - 105.5) < 1e-9,
            "own bpm should resolve");

    // 2. A derived item with no BPM of its own inherits from its source.
    require(state.addLibraryItem("stem", "C:\\audio\\stem.wav", "stem.wav", 60000.0, 48000, 2,
                                 {}, {}, "stem", {}, "track"),
            "stem should add");
    require(std::abs(state.getLibraryItemBpm("stem") - 105.5) < 1e-9,
            "a stem with no bpm of its own should inherit its source's");

    // 3. A one-shot has no tempo, even with a musical parent to inherit from.
    require(state.addLibraryItem("hit", "C:\\audio\\hit.wav", "hit.wav", 800.0, 48000, 2,
                                 {}, {}, "sample", {}, "track"),
            "sample should add");
    require(state.setLibraryItemAudioType("hit", "simple"), "simple classification applies");
    require(state.getLibraryItemBpm("hit") <= 0.0,
            "a one-shot must resolve no tempo rather than inheriting one");

    // 4. A one-shot classification is inherited, so a child of a one-shot has none either.
    require(state.addLibraryItem("hitcut", "C:\\audio\\hitcut.wav", "hitcut.wav", 400.0, 48000, 2,
                                 {}, {}, "clip", {}, "hit"),
            "derived clip should add");
    require(state.getLibraryItemBpm("hitcut") <= 0.0,
            "a clip cut from a one-shot must resolve no tempo");

    // 5. An unknown item resolves nothing rather than falling through.
    require(state.getLibraryItemBpm("nope") <= 0.0, "an unknown item should resolve no tempo");
}

void testProjectStateTempoOwnerResolverContract()
{
    // `resolveTempoOwner` answers "whose tempo is this?" as well as "what is it?", and
    // the renderer's `resolveTempoOwner` must agree case for case — a correction is
    // written to the OWNER, so the two processes disagreeing about the owner would
    // write the fix onto the wrong item and leave every sibling on the wrong number
    // (ADR 0027). Each case below is mirrored in the renderer's unit tests.
    using Reason = silverdaw::ProjectState::TempoReason;
    silverdaw::ProjectState state;

    const auto owner = [&state](const char* id) { return state.resolveTempoOwner(id); };

    // 1. An item's own BPM: the item owns its tempo and a correction lands on itself.
    require(state.addLibraryItem("track", "C:\\audio\\track.wav", "track.wav", 60000.0, 48000, 2),
            "source should add");
    require(state.setLibraryItemBpm("track", 98.80), "source bpm should apply");
    requireEqual(owner("track").ownerItemId, "track", "own bpm should be owned by the item");
    require(owner("track").reason == Reason::ownBpm, "own bpm should report ownBpm");
    requireNear(owner("track").bpm, 98.80, 1e-9, "own bpm should resolve");

    // 2. A one-hop derived item does NOT own the tempo it shows — the import does.
    require(state.addLibraryItem("stem", "C:\\audio\\stem.wav", "stem.wav", 60000.0, 48000, 2,
                                 {}, {}, "stem", {}, "track"),
            "stem should add");
    requireEqual(owner("stem").ownerItemId, "track", "a stem's tempo is owned by its source");
    require(owner("stem").reason == Reason::inheritedBpm, "a stem should report inheritedBpm");
    requireNear(owner("stem").bpm, 98.80, 1e-9, "a stem should resolve its source's bpm");

    // 3. Two levels deep. Before the walk followed the chain to its end this resolved to
    //    NO tempo, so a clip cut from a stem warped as if it had none.
    require(state.addLibraryItem("cut", "C:\\audio\\cut.wav", "cut.wav", 8000.0, 48000, 2,
                                 {}, {}, "clip", {}, "stem"),
            "cut should add");
    requireEqual(owner("cut").ownerItemId, "track", "a two-level chain should reach the import");
    require(owner("cut").reason == Reason::inheritedBpm, "a two-level chain should report inheritedBpm");
    requireNear(owner("cut").bpm, 98.80, 1e-9, "a two-level chain should resolve the import's bpm");

    // 4. A recorded musical length is a measurement, and only the queried item's own
    //    length may answer: an ancestor's beat count describes the ancestor's file.
    require(state.setLibraryItemMusicalBeats("cut", 16), "musical length should apply");
    requireEqual(owner("cut").ownerItemId, "cut", "a musical length is owned by the item itself");
    require(owner("cut").reason == Reason::musicalLength, "a musical length should report musicalLength");
    requireNear(owner("cut").bpm, 16.0 * 60000.0 / 8000.0, 1e-9, "a musical length should resolve from beats");

    require(state.addLibraryItem("grandchild", "C:\\audio\\gc.wav", "gc.wav", 4000.0, 48000, 2,
                                 {}, {}, "clip", {}, "cut"),
            "grandchild should add");
    requireEqual(owner("grandchild").ownerItemId, "track",
                 "an ancestor's musical length must not answer for a child");
    require(owner("grandchild").reason == Reason::inheritedBpm,
            "an ancestor's musical length must not be reported as the child's");

    // 5. A one-shot holds no tempo, and the classification is inherited — so neither the
    //    one-shot nor anything cut from it has an owner to correct.
    require(state.addLibraryItem("hit", "C:\\audio\\hit.wav", "hit.wav", 800.0, 48000, 2,
                                 {}, {}, "sample", {}, "track"),
            "sample should add");
    require(state.setLibraryItemAudioType("hit", "simple"), "simple classification applies");
    require(owner("hit").reason == Reason::oneShot, "a one-shot should report oneShot");
    require(owner("hit").ownerItemId.isEmpty(), "a one-shot has no tempo owner");
    require(owner("hit").bpm <= 0.0, "a one-shot must resolve no tempo");

    require(state.addLibraryItem("hitcut", "C:\\audio\\hitcut.wav", "hitcut.wav", 400.0, 48000, 2,
                                 {}, {}, "clip", {}, "hit"),
            "derived clip should add");
    require(owner("hitcut").reason == Reason::oneShot,
            "a clip cut from a one-shot should report oneShot");

    // 6. An item absent from the library, and a dangling link to one, resolve to nothing
    //    rather than falling through to a stale answer.
    require(owner("nope").reason == Reason::none, "an unknown item should report none");
    require(owner("nope").ownerItemId.isEmpty(), "an unknown item has no owner");

    require(state.addLibraryItem("orphan", "C:\\audio\\orphan.wav", "orphan.wav", 5000.0, 48000, 2,
                                 {}, {}, "clip", {}, "missing-parent"),
            "orphan should add");
    require(owner("orphan").reason == Reason::none, "a dangling source link should report none");

    // 7. A hand-edited or corrupted project could close the chain into a loop. Walking it
    //    would hang the message thread, so the cycle has to end the walk rather than the
    //    process. The API cannot build one, so the link is written directly.
    require(state.addLibraryItem("loopA", "C:\\audio\\a.wav", "a.wav", 5000.0, 48000, 2,
                                 {}, {}, "clip", {}, "orphan"),
            "loopA should add");
    require(state.addLibraryItem("loopB", "C:\\audio\\b.wav", "b.wav", 5000.0, 48000, 2,
                                 {}, {}, "clip", {}, "loopA"),
            "loopB should add");
    auto loopA = state.getTree()
                     .getChildWithName(juce::Identifier{"LIBRARY"})
                     .getChildWithProperty(juce::Identifier{"id"}, "loopA");
    require(loopA.isValid(), "loopA should be in the library");
    loopA.setProperty(juce::Identifier{"sourceItemId"}, "loopB", nullptr);
    require(owner("loopB").reason == Reason::none, "a derivation cycle should report none");
    require(owner("loopB").bpm <= 0.0, "a derivation cycle must resolve no tempo");
}

// ─── Tempo correction (ADR 0027) ─────────────────────────────────────────────
//
// A correction says "the detector was wrong", not "play my arrangement faster". The line
// between the two is drawn at persisted position: a correction may re-derive anything a
// tempo implies, but it must never move a clip start, a marker, an automation point or
// the playhead. These tests hold that line, and hold the reporting honest.

// Defined further down with the other bridge-backed helpers.
silverdaw::BridgeServer makeSilentBridge();

namespace
{
juce::var correctTempoPayload(const juce::String& itemId, double bpm, double beatAnchorSec = 0.0)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("itemId", itemId);
    obj->setProperty("bpm", bpm);
    obj->setProperty("beatAnchorSec", beatAnchorSec);
    return juce::var(obj);
}
} // namespace

void testTempoCorrectionNeverMovesPersistedAnchors()
{
    // The reported bug, end to end: a track really at 102.76 is detected as 98.80 and the
    // project is seeded from it. Correcting it must fix both numbers WITHOUT rescaling the
    // arrangement, which is precisely what the project tempo box would have done.
    silverdaw::ProjectState state;
    silverdaw::AudioEngine engine;
    auto bridge = makeSilentBridge();

    state.setBpm(98.80);
    state.setBpmSeeded(true);
    require(state.addLibraryItem("src", "C:\\audio\\song.wav", "song.wav", 268094.0, 44100, 2),
            "source should add");
    require(state.setLibraryItemBpm("src", 98.80), "detected BPM should apply");
    require(state.addTrack("t1"), "track should add");

    // Bar 9 at 98.80 BPM. A tempo CHANGE would move this to 18684 ms; a correction may not.
    const double barNine = 19433.0;
    require(state.addClip("t1", "clip", "src", barNine, 8000.0), "clip should add");
    require(state.setClipWarp("clip", true, std::nullopt, std::nullopt, false, std::nullopt,
                              std::nullopt, std::nullopt),
            "clip should follow the project tempo");
    require(state.addMarker("drop", barNine), "marker should add");

    juce::Array<juce::var> points;
    const auto makeAutomationPoint = [](double timeMs, double value) {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("timeMs", timeMs);
        obj->setProperty("value", value);
        return juce::var(obj);
    };
    points.add(makeAutomationPoint(0.0, 0.2));
    points.add(makeAutomationPoint(barNine, 0.5));
    require(state.setTrackAutomation("t1", "filter", points), "automation should apply");

    silverdaw::handleLibraryItemCorrectTempo(correctTempoPayload("src", 102.76),
                                             engine, state, bridge);

    requireNear(state.getLibraryItemBpm("src"), 102.76, 1e-9, "the source tempo should be corrected");
    requireNear(state.getBpm(), 98.80, 1e-9, "a correction must leave the project tempo alone");

    // The invariant. Every one of these would have moved under `handleProjectSetBpm`.
    const auto clipStart = [&](const juce::String& clipId) {
        double found = -1.0;
        const auto tree = state.getTree();
        for (int t = 0; t < tree.getNumChildren(); ++t)
        {
            const auto track = tree.getChild(t);
            for (int c = 0; c < track.getNumChildren(); ++c)
            {
                const auto clip = track.getChild(c);
                if (clip.getProperty(juce::Identifier{"id"}).toString() == clipId)
                    found = static_cast<double>(clip.getProperty(juce::Identifier{"offsetMs"}, -1.0));
            }
        }
        return found;
    };
    requireNear(clipStart("clip"), barNine, 1e-9, "a correction must not move a clip start");

    const auto markers = state.markersAsJson();
    require(markers.isArray() && markers.getArray()->size() == 1, "the marker should survive");
    requireNear(static_cast<double>(markers.getArray()->getReference(0).getProperty("positionMs", -1.0)),
                barNine, 1e-9, "a correction must not move a marker");

    const auto automation = state.getTrackAutomation("t1", "filter");
    require(automation.size() == 2, "the automation points should survive");
    requireNear(static_cast<double>(automation.getReference(1).getProperty("timeMs", -1.0)), barNine,
                1e-9, "a correction must not move an automation point");

    // What DOES change: the clip was warped by 98.80/98.80 = 1.0 while both numbers were
    // the same wrong number; now the file tells the truth, warping it to the project's
    // 98.80 genuinely slows it. That is warp working as documented, and the user finishes
    // the job in the transport tempo box — which is theirs to set, and which rescales the
    // arrangement precisely because it is a tempo CHANGE rather than a correction.
    requireNear(state.getClipEffectiveTiming("clip").tempoRatio, 98.80 / 102.76, 1e-9,
                "a warped clip must follow the project tempo against its corrected own");
}

void testTempoCorrectionLeavesTheProjectTempoAlone()
{
    // Setting the project tempo from the first clip dropped is merely a convenience, with
    // no linkage and no history (ADR 0027), so the number is the user's rather than the
    // file's. A correction to a file is never evidence about it — not even when the two
    // are equal, which is the case a rule would be most tempted to guess from.
    silverdaw::ProjectState state;
    silverdaw::AudioEngine engine;
    auto bridge = makeSilentBridge();

    state.setBpm(98.80);
    state.setBpmSeeded(true);
    require(state.addLibraryItem("src", "C:\\audio\\song.wav", "song.wav", 268094.0, 44100, 2),
            "source should add");
    require(state.setLibraryItemBpm("src", 98.80), "detected BPM should apply");

    silverdaw::handleLibraryItemCorrectTempo(correctTempoPayload("src", 102.76),
                                             engine, state, bridge);

    requireNear(state.getLibraryItemBpm("src"), 102.76, 1e-9, "the source tempo should be corrected");
    requireNear(state.getBpm(), 98.80, 1e-9,
                "an equal project tempo is not evidence — the project number is the user's");
}

void testTempoCorrectionMustNotSeedAnUnseededProject()
{
    // Seeding would move the project tempo as a side effect of correcting a source, which
    // is the inference ADR 0027 exists to forbid. It stays the job of the first musical
    // clip.
    silverdaw::ProjectState state;
    silverdaw::AudioEngine engine;
    auto bridge = makeSilentBridge();

    const double defaultBpm = state.getBpm();
    require(!state.isBpmSeeded(), "a fresh project starts unseeded");
    require(state.addLibraryItem("src", "C:\\audio\\song.wav", "song.wav", 268094.0, 44100, 2),
            "source should add");
    require(state.setLibraryItemBpm("src", 98.80), "detected BPM should apply");
    require(state.addTrack("t1"), "track should add");
    require(state.addClip("t1", "clip", "src", 0.0, 8000.0), "clip should add");

    silverdaw::handleLibraryItemCorrectTempo(correctTempoPayload("src", 102.76),
                                             engine, state, bridge);

    requireNear(state.getBpm(), defaultBpm, 1e-9,
                "a correction must not seed the project tempo behind the user's back");
    require(!state.isBpmSeeded(), "a correction must leave the project unseeded");
}

void testTempoCorrectionIsRedirectedToTheTempoOwner()
{
    // A stem shows its source's tempo but does not own it. Correcting the stem in place
    // would split it from its siblings and leave the import — and every other stem — on
    // the wrong number.
    silverdaw::ProjectState state;
    silverdaw::AudioEngine engine;
    auto bridge = makeSilentBridge();

    state.setBpm(98.80);
    state.setBpmSeeded(true);
    require(state.addLibraryItem("src", "C:\\audio\\song.wav", "song.wav", 268094.0, 44100, 2),
            "source should add");
    require(state.setLibraryItemBpm("src", 98.80), "detected BPM should apply");
    require(state.addLibraryItem("drums", "C:\\audio\\drums.wav", "drums.wav", 268094.0, 44100, 2,
                                 {}, {}, "stem", {}, "src"),
            "drums stem should add");
    require(state.addLibraryItem("bass", "C:\\audio\\bass.wav", "bass.wav", 268094.0, 44100, 2,
                                 {}, {}, "stem", {}, "src"),
            "bass stem should add");

    // The user acts on the stem they had open.
    silverdaw::handleLibraryItemCorrectTempo(correctTempoPayload("drums", 102.76),
                                             engine, state, bridge);

    requireNear(state.getLibraryItemBpm("src"), 102.76, 1e-9,
                "the correction should be written to the import that owns the tempo");
    requireNear(state.getLibraryItemBpm("bass"), 102.76, 1e-9,
                "every sibling should be fixed by the one correction");
    requireNear(state.getLibraryItemBpm("drums"), 102.76, 1e-9,
                "the stem the user acted on should resolve the corrected tempo");
    const auto stemItem = state.getTree()
                              .getChildWithName(juce::Identifier{"LIBRARY"})
                              .getChildWithProperty(juce::Identifier{"id"}, "drums");
    require(static_cast<double>(stemItem.getProperty(juce::Identifier{"bpm"}, 0.0)) <= 0.0,
            "the stem must not be given a BPM of its own, which would split it from its source");
}

// Regression: `beatAnchorSec` defaulted to 0 and was written to the OWNER, an item the
// caller never named. Correcting a stem without naming a phase therefore snapped the
// import's grid to the start of its file, sliding the markers of every clip ever cut from
// it — while the user believed they had only corrected a number.
void testTempoCorrectionKeepsTheOwnersGridPhaseWhenNoneIsGiven()
{
    silverdaw::ProjectState state;
    silverdaw::AudioEngine engine;
    auto bridge = makeSilentBridge();

    require(state.addLibraryItem("src", "C:\\audio\\song.wav", "song.wav", 268094.0, 44100, 2),
            "source should add");
    require(state.setLibraryItemBpm("src", 98.80), "detected BPM should apply");
    require(state.setLibraryItemBeatAnchor("src", 0.317), "the import should carry a grid phase");
    require(state.addLibraryItem("drums", "C:\\audio\\drums.wav", "drums.wav", 268094.0, 44100, 2,
                                 {}, {}, "stem", {}, "src"),
            "drums stem should add");

    // No `beatAnchorSec`: the user corrected a number and said nothing about phase.
    auto* obj = new juce::DynamicObject();
    obj->setProperty("itemId", "drums");
    obj->setProperty("bpm", 102.76);
    silverdaw::handleLibraryItemCorrectTempo(juce::var(obj), engine, state, bridge);

    requireNear(state.getLibraryItemBpm("src"), 102.76, 1e-9, "the tempo should still be corrected");
    requireNear(state.getLibraryItemBeatAnchorSec("src"), 0.317, 1e-9,
                "omitting the phase must leave the owner's grid phase exactly where it was");
}

// A phase that is not a usable time is a mistake worth reporting, not one to round away
// into a silent grid slide.
void testTempoCorrectionRejectsAnUnusableGridPhase()
{
    silverdaw::ProjectState state;
    silverdaw::AudioEngine engine;
    auto bridge = makeSilentBridge();

    require(state.addLibraryItem("src", "C:\\audio\\song.wav", "song.wav", 268094.0, 44100, 2),
            "source should add");
    require(state.setLibraryItemBpm("src", 98.80), "detected BPM should apply");
    require(state.setLibraryItemBeatAnchor("src", 0.317), "the import should carry a grid phase");

    silverdaw::handleLibraryItemCorrectTempo(correctTempoPayload("src", 102.76, -1.0), engine,
                                             state, bridge);
    requireNear(state.getLibraryItemBpm("src"), 98.80, 1e-9,
                "a negative grid phase should be rejected before anything is written");

    silverdaw::handleLibraryItemCorrectTempo(
        correctTempoPayload("src", 102.76, std::numeric_limits<double>::quiet_NaN()), engine, state,
        bridge);
    requireNear(state.getLibraryItemBpm("src"), 98.80, 1e-9,
                "a grid phase that is not a number should be rejected too");
    requireNear(state.getLibraryItemBeatAnchorSec("src"), 0.317, 1e-9,
                "a rejected correction must leave the grid phase alone");
}

void testTempoCorrectionSupersedesADetectionAlreadyInFlight()
{
    // F1: a detection job runs on a worker thread and applies its result later, on the
    // message thread. If the user corrects the tempo in between, the result that finally
    // lands is stale. Letting it through was silent, unrecoverable data loss: the
    // automatic path writes derived, non-dirtying, NON-UNDOABLE metadata, so the
    // overwritten correction could not be brought back with undo — nothing had been
    // pushed onto the undo stack to undo.
    silverdaw::ProjectState state;
    silverdaw::AudioEngine engine;
    auto bridge = makeSilentBridge();

    require(state.addLibraryItem("src", "C:\\audio\\song.wav", "song.wav", 268094.0, 44100, 2),
            "source should add");
    require(state.setLibraryItemBpm("src", 98.80), "detected BPM should apply");

    // What a job captures when it is enqueued, before any correction exists.
    const auto atEnqueue = silverdaw::getTempoAuthorityGeneration("src");
    require(!silverdaw::tempoDetectionResultIsStale("src", atEnqueue),
            "a job whose item nobody has touched must be allowed to apply its result");

    silverdaw::applyManualTempo("src", 102.76, 0.0, engine, state, bridge);

    require(silverdaw::tempoDetectionResultIsStale("src", atEnqueue),
            "a correction made while the job ran must invalidate that job's result");
    require(!silverdaw::tempoDetectionResultIsStale(
                "src", silverdaw::getTempoAuthorityGeneration("src")),
            "a reanalysis enqueued AFTER the correction is an explicit instruction and still applies");

    // A second correction invalidates the reanalysis in turn.
    const auto afterReanalyseEnqueue = silverdaw::getTempoAuthorityGeneration("src");
    silverdaw::applyManualTempo("src", 90.0, 0.0, engine, state, bridge);
    require(silverdaw::tempoDetectionResultIsStale("src", afterReanalyseEnqueue),
            "the newest correction always wins over a detection enqueued before it");

    // An item nobody has ever corrected is unaffected by another item's corrections.
    require(!silverdaw::tempoDetectionResultIsStale("untouched", 0),
            "generations are per item, so one item's correction must not discard another's analysis");

    requireNear(state.getLibraryItemBpm("src"), 90.0, 1e-9,
                "the hand-set tempo is what the item is left holding");
}

void testTempoCorrectionRederivesFollowersAndReportsExclusions()
{
    // Clips that follow the corrected tempo re-derive; clips the user pinned or unwarped
    // are left alone. Those are exclusions by the user's own earlier choice, not failures,
    // and the command has to be able to say how many there were.
    silverdaw::ProjectState state;
    silverdaw::AudioEngine engine;
    auto bridge = makeSilentBridge();

    state.setBpm(120.0);
    state.setBpmSeeded(true);
    require(state.addLibraryItem("src", "C:\\audio\\loop.wav", "loop.wav", 8000.0, 44100, 2),
            "source should add");
    require(state.setLibraryItemBpm("src", 100.0), "detected BPM should apply");
    require(state.addTrack("t1"), "track should add");

    require(state.addClip("t1", "following", "src", 0.0, 8000.0), "following clip should add");
    require(state.setClipWarp("following", true, std::nullopt, std::nullopt, false, std::nullopt,
                              std::nullopt, std::nullopt),
            "following clip should warp to the project tempo");
    require(state.addClip("t1", "pinned", "src", 20000.0, 8000.0), "pinned clip should add");
    require(state.setClipWarp("pinned", true, std::nullopt, 1.5, false, std::nullopt, std::nullopt,
                              std::nullopt),
            "pinned clip should hold its own ratio");
    require(state.addClip("t1", "dry", "src", 40000.0, 8000.0), "unwarped clip should add");

    requireNear(state.getClipEffectiveTiming("following").tempoRatio, 1.2, 1e-9,
                "the following clip starts at project / detected BPM");

    // Correct the source only: the project stays at 120, so the follower re-warps onto it.
    silverdaw::handleLibraryItemCorrectTempo(correctTempoPayload("src", 80.0),
                                             engine, state, bridge);

    requireNear(state.getClipEffectiveTiming("following").tempoRatio, 1.5, 1e-9,
                "a following clip's ratio should be re-derived from the corrected tempo");
    requireNear(state.getClipEffectiveTiming("pinned").tempoRatio, 1.5, 1e-9,
                "a pinned ratio is explicit user intent and must survive untouched");

    bool sawPinned = false;
    state.forEachWarpClip(
        [&](const silverdaw::ProjectState::WarpClipInfo& info)
        {
            if (info.clipId != "pinned") return;
            sawPinned = true;
            require(info.tempoRatioPinned, "the pinned clip should still be pinned");
            requireNear(info.tempoRatio, 1.5, 1e-9, "the pinned ratio value should be unchanged");
        });
    require(sawPinned, "the pinned clip should remain in project state");
}

void testTempoCorrectionScalesClipEnvelopesWithTheirFootprint()
{
    // A volume shape is clip-local milliseconds measured across the clip's footprint. A
    // correction that changes the ratio changes that footprint, so leaving the shape fixed
    // would make it shape different audio — the one kind of movement the invariant
    // deliberately permits and requires.
    silverdaw::ProjectState state;
    silverdaw::AudioEngine engine;
    auto bridge = makeSilentBridge();

    state.setBpm(120.0);
    state.setBpmSeeded(true);
    require(state.addLibraryItem("src", "C:\\audio\\loop.wav", "loop.wav", 8000.0, 44100, 2),
            "source should add");
    require(state.setLibraryItemBpm("src", 120.0), "detected BPM should apply");
    require(state.addTrack("t1"), "track should add");
    require(state.addClip("t1", "following", "src", 0.0, 8000.0), "clip should add");
    require(state.setClipWarp("following", true, std::nullopt, std::nullopt, false, std::nullopt,
                              std::nullopt, std::nullopt),
            "clip should follow the project tempo");

    const auto makePoint = [](double timeMs, double gain) {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("timeMs", timeMs);
        obj->setProperty("gain", gain);
        return juce::var(obj);
    };
    juce::Array<juce::var> shape;
    shape.add(makePoint(0.0, 1.0));
    shape.add(makePoint(4000.0, 1.0));
    shape.add(makePoint(8000.0, 0.0));
    require(state.setClipEnvelope("following", shape), "shape should apply");

    // Correcting the source to 60 doubles the ratio (120/60), so the clip plays twice as
    // fast and its timeline footprint halves.
    silverdaw::handleLibraryItemCorrectTempo(correctTempoPayload("src", 60.0),
                                             engine, state, bridge);

    requireNear(state.getClipEffectiveTiming("following").tempoRatio, 2.0, 1e-9,
                "the clip should re-warp onto the unchanged project tempo");
    requireNear(state.getClipEffectiveTiming("following").durationMs, 4000.0, 1e-6,
                "a doubled ratio should halve the clip's timeline footprint");
    const auto pts = state.getClipEnvelope("following");
    require(pts.size() == 3, "the shape should keep its breakpoints");
    requireNear(static_cast<double>(pts.getReference(1).getProperty("timeMs", -1.0)), 2000.0, 1e-6,
                "the shape's midpoint should scale with the clip's new footprint");
    requireNear(static_cast<double>(pts.getReference(2).getProperty("timeMs", -1.0)), 4000.0, 1e-6,
                "the shape's end should scale with the clip's new footprint");
    // The shape is a function of position within the clip, not of the tempo.
    requireNear(static_cast<double>(pts.getReference(2).getProperty("gain", -1.0)), 0.0, 1e-9,
                "a footprint change must not touch the shape's values");
}

void testTempoCorrectionRejectsWhatItCannotCorrect()
{
    // A rejected correction must change nothing at all: a half-corrected project is worse
    // than an uncorrected one.
    silverdaw::ProjectState state;
    silverdaw::AudioEngine engine;
    auto bridge = makeSilentBridge();

    state.setBpm(120.0);
    state.setBpmSeeded(true);
    require(state.addLibraryItem("src", "C:\\audio\\loop.wav", "loop.wav", 8000.0, 44100, 2),
            "source should add");
    require(state.setLibraryItemBpm("src", 100.0), "detected BPM should apply");

    // Out of range in both directions: a mistyped digit, not a tempo.
    silverdaw::handleLibraryItemCorrectTempo(correctTempoPayload("src", 5.0), engine,
                                             state, bridge);
    silverdaw::handleLibraryItemCorrectTempo(correctTempoPayload("src", 4000.0),
                                             engine, state, bridge);
    requireNear(state.getLibraryItemBpm("src"), 100.0, 1e-9,
                "an out-of-range tempo must not be applied");
    requireNear(state.getBpm(), 120.0, 1e-9, "a rejected correction must change nothing at all");

    // An item that is not in the library at all.
    silverdaw::handleLibraryItemCorrectTempo(correctTempoPayload("nope", 102.76),
                                             engine, state, bridge);
    requireNear(state.getBpm(), 120.0, 1e-9, "an unknown item must not move the project tempo");

    // A one-shot has no tempo to correct, so the command refuses rather than inventing one.
    require(state.addLibraryItem("hit", "C:\\audio\\hit.wav", "hit.wav", 800.0, 44100, 2, {}, {},
                                 "sample", {}, "src"),
            "one-shot should add");
    require(state.setLibraryItemAudioType("hit", "simple"), "simple classification applies");
    silverdaw::handleLibraryItemCorrectTempo(correctTempoPayload("hit", 102.76),
                                             engine, state, bridge);
    require(state.getLibraryItemBpm("hit") <= 0.0, "a one-shot must not be given a tempo");
    requireNear(state.getLibraryItemBpm("src"), 100.0, 1e-9,
                "refusing a one-shot must not write through to its source");
    requireNear(state.getBpm(), 120.0, 1e-9, "a refused correction must not move the project tempo");
}

void testTempoCorrectionUndoesTheWholeCorrectionInOneStep()
{
    // One action, one undo press. The command writes the tempo AND re-derives every clip
    // that follows it; separate messages in an edit group would give the same key press
    // but could leave a half-corrected project if the second were rejected.
    silverdaw::ProjectState state;
    silverdaw::AudioEngine engine;
    auto bridge = makeSilentBridge();

    state.setBpm(120.0);
    state.setBpmSeeded(true);
    require(state.addLibraryItem("src", "C:\\audio\\loop.wav", "loop.wav", 8000.0, 44100, 2),
            "source should add");
    require(state.setLibraryItemBpm("src", 100.0), "detected BPM should apply");
    require(state.addTrack("t1"), "track should add");
    require(state.addClip("t1", "following", "src", 0.0, 8000.0), "clip should add");
    require(state.setClipWarp("following", true, std::nullopt, std::nullopt, false, std::nullopt,
                              std::nullopt, std::nullopt),
            "clip should follow the project tempo");

    auto& undo = state.getUndoManager();
    undo.beginNewTransaction("Correct tempo");
    silverdaw::handleLibraryItemCorrectTempo(correctTempoPayload("src", 80.0), engine, state,
                                             bridge);
    requireNear(state.getLibraryItemBpm("src"), 80.0, 1e-9, "the source tempo should be corrected");
    requireNear(state.getClipEffectiveTiming("following").tempoRatio, 1.5, 1e-9,
                "the follower should be re-derived");

    require(undo.undo(), "the correction should undo");
    requireNear(state.getLibraryItemBpm("src"), 100.0, 1e-9,
                "undo should restore the source tempo");
    requireNear(state.getClipEffectiveTiming("following").tempoRatio, 1.2, 1e-9,
                "the same single undo should restore every clip the correction re-derived");
}

void testProjectStateRepairsLegacySampleKind()
{
    // Projects saved before the sample `kind` fix hold their samples as plain
    // sources; reopening one must fix it forward rather than leaving the item
    // permanently mis-typed.
    silverdaw::ProjectState state;
    const juce::Identifier libraryId{"LIBRARY"};
    const juce::Identifier idId{"id"};
    const juce::Identifier kindId{"kind"};

    require(state.addLibraryItem("sample-f5f925e3", "C:\\audio\\s.wav", "s.wav", 4536.0, 44100, 2,
                                 {}, {}, "source"),
            "legacy-shaped sample should add");
    require(state.addLibraryItem("l23", "C:\\audio\\t.mp3", "t.mp3", 268094.0, 44100, 2,
                                 {}, {}, "source"),
            "ordinary source should add");

    require(state.repairLegacyLibraryItemKinds() == 1,
            "exactly the sample-prefixed item should be repaired");

    const auto library = state.getTree().getChildWithName(libraryId);
    requireEqual(library.getChildWithProperty(idId, "sample-f5f925e3").getProperty(kindId).toString(),
                 "sample", "a sample-prefixed item should be restored to kind=sample");
    requireEqual(library.getChildWithProperty(idId, "l23").getProperty(kindId).toString(),
                 "source", "an ordinary source must be left alone");

    require(state.repairLegacyLibraryItemKinds() == 0, "repair should be idempotent");
}

void testProjectStateRepairsDemotedStemKind()
{
    // Reanalysing a stem used to re-add it without a kind, demoting it to a plain
    // source. A demoted stem then disappeared from the cross-project import, which
    // only offers stem and sample items. Generated artifacts live under a category
    // folder inside the project folder, so the path restores the kind exactly.
    //
    // Paths are absolute here because that is the only shape this rule ever sees: a
    // load rewrites every stored portable path to an absolute one before the tree is
    // installed, so the repair must decide by containment in the project folder, not
    // by whether the path looks relative.
    silverdaw::ProjectState state;
    const juce::Identifier libraryId{"LIBRARY"};
    const juce::Identifier idId{"id"};
    const juce::Identifier kindId{"kind"};

    const auto projectDir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                                .getChildFile("silverdaw-repair-kinds-test");
    const auto inProject = [&](const juce::String& relative) {
        return projectDir.getChildFile(relative).getFullPathName();
    };

    const juce::String stemDir = "stems/02 T Plays It Cool-stems-2/";
    require(state.addLibraryItem("l20", inProject(stemDir + "T Plays It Cool - drums - 5ccde04d.wav"),
                                 "drums.wav", 268094.0, 44100, 2, {}, {}, "source", {}, "l1"),
            "demoted drums stem should add");
    require(state.addLibraryItem("l21", inProject(stemDir + "T Plays It Cool - bass - 5ccde04d.wav"),
                                 "bass.wav", 268094.0, 44100, 2, {}, {}, "stem", {}, "l1"),
            "intact bass stem should add");
    require(state.addLibraryItem("ch1", inProject("channels/left.wav"), "left.wav", 100.0, 44100, 1,
                                 {}, {}, "source", {}, "l1"),
            "demoted channel split should add");
    require(state.addLibraryItem("sc1", inProject("scratches/bake.wav"), "bake.wav", 100.0, 44100, 2,
                                 {}, {}, "source"),
            "demoted scratch bake should add");
    require(state.addLibraryItem("l1", "C:\\Music\\02 T Plays It Cool.mp3", "t.mp3", 268094.0,
                                 44100, 2, {}, {}, "source"),
            "original source should add");
    require(state.addLibraryItem("ext", "C:\\Music\\stems\\borrowed.wav", "borrowed.wav", 100.0,
                                 44100, 2, {}, {}, "source"),
            "external file under a same-named folder should add");

    require(state.repairLegacyLibraryItemKinds(projectDir) == 3,
            "only the three artifacts inside the project folder should be repaired");

    const auto library = state.getTree().getChildWithName(libraryId);
    const auto kindOf = [&](const char* id) {
        return library.getChildWithProperty(idId, id).getProperty(kindId).toString();
    };
    requireEqual(kindOf("l20"), "stem", "a demoted stem should be restored to kind=stem");
    requireEqual(kindOf("l21"), "stem", "an intact stem must be left alone");
    requireEqual(kindOf("ch1"), "stem", "a channel split reuses the stem kind");
    requireEqual(kindOf("sc1"), "sample", "a scratch bake is a sample");
    requireEqual(kindOf("l1"), "source", "the original source must be left alone");
    requireEqual(kindOf("ext"), "source",
                 "a file outside the project folder must never be reclassified");

    require(state.repairLegacyLibraryItemKinds(projectDir) == 0, "repair should be idempotent");
    require(state.repairLegacyLibraryItemKinds() == 0,
            "with no project folder there is nothing the folder rule can decide");
}

void testProjectStateTempoInheritanceSourceId()
{
    // Automatic detection must never run on a derived item whose source already knows
    // the tempo. A saved sample is often only a couple of bars long — far too short for
    // reliable detection — and the few-percent error it yields is visible as a warped
    // clip that no longer spans a whole number of bars.
    silverdaw::ProjectState state;

    require(state.addLibraryItem("track", "C:\\audio\\track.wav", "track.wav", 60000.0, 48000, 2),
            "source should add");
    require(state.setLibraryItemBpm("track", 105.804), "source bpm should apply");

    // An original has nothing to inherit from: it must be analysed.
    require(state.getTempoInheritanceSourceId("track").isEmpty(),
            "an original must be analysed on its own audio");

    // A saved sample cut from an analysed source inherits instead of detecting.
    require(state.addLibraryItem("sample-a", "C:\\audio\\s.wav", "s.wav", 4536.0, 48000, 2,
                                 {}, {}, "sample", {}, "track"),
            "sample should add");
    require(state.setLibraryItemAudioType("sample-a", "music"), "music classification applies");
    requireEqual(state.getTempoInheritanceSourceId("sample-a"), "track",
                 "a music sample must inherit its source's tempo, not detect its own");

    // A one-shot holds no tempo at all, so there is nothing to inherit.
    require(state.addLibraryItem("sample-b", "C:\\audio\\hit.wav", "hit.wav", 800.0, 48000, 2,
                                 {}, {}, "sample", {}, "track"),
            "one-shot sample should add");
    require(state.setLibraryItemAudioType("sample-b", "simple"), "simple classification applies");
    require(state.getTempoInheritanceSourceId("sample-b").isEmpty(),
            "a one-shot must neither inherit nor detect a tempo");

    // A source with no tempo of its own has nothing to give, so the derived item is analysed.
    require(state.addLibraryItem("quiet", "C:\\audio\\quiet.wav", "quiet.wav", 60000.0, 48000, 2),
            "untimed source should add");
    require(state.addLibraryItem("sample-c", "C:\\audio\\c.wav", "c.wav", 4000.0, 48000, 2,
                                 {}, {}, "sample", {}, "quiet"),
            "sample of an untimed source should add");
    require(state.getTempoInheritanceSourceId("sample-c").isEmpty(),
            "a derived item whose source has no tempo must fall back to detection");
}

void testProjectStateCoverArtHiddenOverride()
{
    silverdaw::ProjectState state;
    require(state.addLibraryItem("l1", "C:\\audio\\a.wav", "a.wav", 1000.0, 48000, 2), "library add should succeed");
    state.markClean();
    require(!state.isDirty(), "baseline should be clean after markClean");

    const juce::Identifier libraryId{"LIBRARY"};
    const juce::Identifier coverHidden{"coverArtHidden"};
    const juce::Identifier coverOverride{"coverArtOverride"};

    // Hiding a tile's cover art is a user override — persisted and marks the project dirty.
    require(state.setLibraryItemCoverArtHidden("l1", true), "set hidden should succeed");
    require(state.isDirty(), "hiding cover art should mark the project dirty");
    require(bool(state.getTree().getChildWithName(libraryId).getChild(0).getProperty(coverHidden)),
            "coverArtHidden property should be set on the item");

    // Clearing removes the flag entirely (suppressed-when-off).
    state.markClean();
    require(state.setLibraryItemCoverArtHidden("l1", false), "clear should succeed");
    require(state.isDirty(), "restoring cover art should mark the project dirty");
    require(!state.getTree().getChildWithName(libraryId).getChild(0).hasProperty(coverHidden),
            "clearing should remove the coverArtHidden property");

    require(!state.setLibraryItemCoverArtHidden("missing", true), "unknown item returns false");

    // Per-item cover override persists (as a string basename) and marks dirty.
    state.markClean();
    require(state.setLibraryItemCoverArtOverride("l1", "override-l1.png"), "set override should succeed");
    require(state.isDirty(), "setting a cover override should mark the project dirty");
    requireEqual(state.getTree().getChildWithName(libraryId).getChild(0).getProperty(coverOverride).toString(),
                 juce::String("override-l1.png"), "coverArtOverride basename should be stored");

    state.markClean();
    require(state.setLibraryItemCoverArtOverride("l1", ""), "clearing override should succeed");
    require(state.isDirty(), "clearing a cover override should mark the project dirty");
    require(!state.getTree().getChildWithName(libraryId).getChild(0).hasProperty(coverOverride),
            "clearing should remove the coverArtOverride property");
    require(!state.setLibraryItemCoverArtOverride("missing", "x.png"), "unknown item returns false");
}

void testProjectStateNonDirtyLibraryRemove()
{
    silverdaw::ProjectState state;
    state.addTrack("t1");
    require(state.addLibraryItem("s1", "C:\\proj\\samples\\Song\\s.wav", "s.wav", 2000.0, 48000, 2),
            "sample library add should succeed");
    require(state.addLibraryItem("s2", "C:\\proj\\samples\\Song2\\s2.wav", "s2.wav", 1000.0, 48000, 2),
            "second sample library add should succeed");
    state.markClean();
    require(!state.isDirty(), "baseline should be clean after markClean");

    int transitions = 0;
    state.setDirtyChangedCallback([&](bool, silverdaw::ProjectState::DirtyReason) { ++transitions; });

    // A "clean up project files" removal deletes the item's file from disk (irreversible),
    // so it must NOT mark the project dirty and must not fire the dirty callback.
    require(state.removeLibraryItemNonDirty("s1"), "non-dirty library remove should succeed");
    require(state.getLibraryItemFilePath("s1").isEmpty(), "the item should be gone from the library");
    require(!state.isDirty(), "a cleanup removal must not mark the project dirty");
    require(transitions == 0, "a cleanup removal must not fire the dirty callback");

    // A NORMAL removal (cleanup preference off) of a previously-saved item MUST still mark
    // the project dirty — it is an ordinary unsaved edit.
    require(state.removeLibraryItem("s2"), "normal library remove should succeed");
    require(state.isDirty(), "a normal removal of a saved item must mark the project dirty");
    require(transitions == 1, "the normal removal should fire the dirty callback once");

    require(!state.removeLibraryItemNonDirty("missing"), "removing an absent item returns false");
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
        [&](bool d, silverdaw::ProjectState::DirtyReason)
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

// Background analysis landing after a save changes real, persisted content (the seeded
// project tempo, the late auto-warp), so it must still dirty — mirroring it into the
// clean snapshot would claim "saved" for content that is not on disk. What it must NOT
// do is look like a phantom edit, so the transition is attributed and the renderer
// explains it.
void testProjectStateAttributesBackgroundAnalysisDirty()
{
    silverdaw::ProjectState state;
    state.markClean();

    std::vector<std::pair<bool, silverdaw::ProjectState::DirtyReason>> events;
    state.setDirtyChangedCallback([&](bool d, silverdaw::ProjectState::DirtyReason reason)
                                  { events.emplace_back(d, reason); });

    state.setBpm(120.0);
    require(events.size() == 1, "a user tempo edit should fire one transition");
    require(events[0].first, "a user tempo edit should mark dirty");
    require(events[0].second == silverdaw::ProjectState::DirtyReason::UserEdit,
            "an unscoped edit should be attributed to the user");

    state.markClean();
    events.clear();

    {
        const silverdaw::ProjectState::BackgroundDirtyScope background(state);
        state.setBpm(128.0);
    }
    require(events.size() == 1, "a scoped tempo write should fire one transition");
    require(events[0].first, "background analysis still marks dirty (the edit is real)");
    require(events[0].second == silverdaw::ProjectState::DirtyReason::BackgroundAnalysis,
            "a scoped write should be attributed to background analysis");

    // The scope must not leak: the next ordinary edit is the user's again.
    state.markClean();
    events.clear();
    state.setBpm(140.0);
    require(events.size() == 1 && events[0].second == silverdaw::ProjectState::DirtyReason::UserEdit,
            "attribution should not outlive the scope");
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

void testOneShotClassificationIsInheritedByResolver()
{
    // Both processes must answer "does this item have a tempo?" identically (ADR 0024),
    // and the renderer decides one-shot-ness by inheritance before resolving anything.
    // These are the two shapes where resolving first used to disagree with it.
    silverdaw::ProjectState state;
    require(state.addLibraryItem("hit", "C:\\audio\\hit.wav", "hit.wav", 500.0, 44100, 2),
            "one-shot source should add");
    require(state.setLibraryItemAudioType("hit", "simple"), "one-shot classification applies");

    // (a) An unclassified cut of a one-shot that detected a tempo of its own. The
    // classification is inherited, so that detection must not be handed out.
    require(state.addLibraryItem("cut", "C:\\audio\\cut.wav", "cut.wav", 250.0, 44100, 2, {}, {},
                                 "sample", {}, "hit"),
            "cut of the one-shot should add");
    require(state.setLibraryItemBpm("cut", 128.0) || true, "detection may or may not be accepted");
    requireNear(state.getLibraryItemBpm("cut"), 0.0, 1e-9,
                "a cut of a one-shot reports no tempo even if it stored one");

    // (b) A cut the user explicitly called music. That says this item has a pulse; it
    // does not give its one-shot parent one to lend.
    require(state.addLibraryItem("mus", "C:\\audio\\mus.wav", "mus.wav", 250.0, 44100, 2, {}, {},
                                 "sample", {}, "hit"),
            "music cut of the one-shot should add");
    require(state.setLibraryItemAudioType("mus", "music"), "music classification applies");
    requireNear(state.getLibraryItemBpm("mus"), 0.0, 1e-9,
                "a music cut inherits no tempo from a one-shot parent");
}

void testProjectStateScratchLibraryMetadata()
{
    silverdaw::ProjectState state;
    require(state.addLibraryItem("scr1", "C:\\proj\\scratches\\p1\\take-001.wav", "take-001.wav",
                                 1500.0, 48000, 2, "C:\\proj\\scratches\\p1\\take-001.wav", {},
                                 "sample", "My Scratch"),
            "baked scratch sample should add as a sample");
    require(state.setLibraryItemScratchMeta("scr1", "p1", "C:\\proj\\scratches\\p1\\source.wav"),
            "scratch metadata should apply to an existing item");
    requireEqual(state.getLibraryItemScratchPatternId("scr1"), "p1",
                 "scratch pattern id getter should return the linked pattern");
    requireEqual(state.getLibraryItemScratchSourcePath("scr1"), "C:\\proj\\scratches\\p1\\source.wav",
                 "scratch source path getter should return the snapshot path");

    const auto library = state.libraryAsJson();
    require(library.isArray() && library.getArray()->size() == 1,
            "libraryAsJson should return the one scratch item");
    const auto item = library.getArray()->getReference(0);
    require(bool(item.getProperty("scratchOrigin", false)),
            "libraryAsJson should flag the scratch-origin sample");
    requireEqual(item.getProperty("scratchPatternId", {}).toString(), "p1",
                 "libraryAsJson should serialise the scratch pattern id");
    requireEqual(item.getProperty("scratchSourcePath", {}).toString(),
                 "C:\\proj\\scratches\\p1\\source.wav",
                 "libraryAsJson should serialise the scratch source path");

    require(state.setLibraryItemScratchMeta("scr1", {}, {}),
            "clearing scratch metadata should succeed");
    require(state.getLibraryItemScratchPatternId("scr1").isEmpty(),
            "cleared scratch pattern id should be empty");
    require(!state.setLibraryItemScratchMeta("missing", "p2", "x.wav"),
            "scratch metadata on an unknown item should fail");
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

// Replay of a "Duplicate clip" message sequence: a single group containing CLIP_ADD (new clip) +
// a no-op TRACK_GAIN (a re-push of the unchanged track gain) + CLIP_RENAME. Regression guard for
// the bug where a duplicated, named clip needed several undos because the trailing CLIP_RENAME
// landed in its own transaction at the top of the stack. The renderer no longer re-pushes track
// gain after a clip add, but a no-op mutation mid-group must still not split the transaction.
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

// Regression guard: applying a clip effect (reverse / brake / backspin) after a compound
// group (e.g. Chop to Grid) must be its OWN undo step, not folded into the group's
// transaction. Bug: these envelope types were missing from isUndoableEnvelopeType, so the
// dispatcher never opened a fresh transaction and the effect's ValueTree mutation accreted
// into the still-open compound transaction — one undo reverted every effect AND the chop,
// jumping back to before the split.
void testClipEffectAfterGroupIsSeparateUndoStep()
{
    silverdaw::ProjectState state;
    require(state.addTrack("t1"), "track add should succeed");

    // Compound action (like Chop to Grid): one grouped transaction producing two slices.
    silverdaw::beginUndoGroup("Chop to grid", state);
    silverdaw::beginUndoTransactionIfNeeded("CLIP_ADD", juce::var(), state);
    require(state.addClip("t1", "a", "lib1", 0.0, 500.0, 0.0, -1), "first slice add should succeed");
    silverdaw::beginUndoTransactionIfNeeded("CLIP_ADD", juce::var(), state);
    require(state.addClip("t1", "b", "lib1", 500.0, 500.0, 0.0, -1), "second slice add should succeed");
    silverdaw::endUndoGroup();

    // Apply an effect to one slice via the dispatcher's begin/end bracket.
    silverdaw::beginUndoTransactionIfNeeded("CLIP_SET_BRAKE", juce::var(), state);
    require(state.setClipBrake("a", true), "brake toggle should succeed");
    silverdaw::endUndoTransactionIfNeeded("CLIP_SET_BRAKE", juce::var());

    // One undo must remove ONLY the brake, leaving both chopped slices intact.
    state.getUndoManager().beginNewTransaction();
    require(state.getUndoManager().undo(), "one undo should reverse only the brake");
    require(! state.isClipBrake("a"), "brake must be cleared by the undo");
    const auto afterEffectUndo = silverdaw::collectClipIds(state);
    require(afterEffectUndo.contains("a") && afterEffectUndo.contains("b"),
            "both chopped slices must survive undoing the effect");

    // A second undo reaches the chop group and reverts both slices together.
    state.getUndoManager().beginNewTransaction();
    require(state.getUndoManager().undo(), "second undo should reverse the chop group");
    const auto afterGroupUndo = silverdaw::collectClipIds(state);
    require(! afterGroupUndo.contains("a") && ! afterGroupUndo.contains("b"),
            "the chop group reverts as one step only after the effect is undone");
}

// The metronome toggle persists with the project but applies SILENTLY: it neither marks the project
// dirty nor enters the undo stack, and default-off is stored as absent (legacy round-trip clean).
void testProjectStateMetronomeRoundTrip()
{
    silverdaw::ProjectState state;
    state.markClean();

    require(! state.getMetronomeEnabled(), "fresh project should default the metronome off");

    state.setMetronomeEnabled(true);
    require(state.getMetronomeEnabled(), "setMetronomeEnabled(true) should round-trip");
    require(! state.isDirty(), "toggling the metronome must NOT mark the project dirty (silent)");
    require(! state.getUndoManager().canUndo(),
            "toggling the metronome must NOT push an undo entry (silent)");

    // ValueTreeJson round-trip for the enabled state.
    {
        const auto encoded = silverdaw::ValueTreeJson::toVar(state.getTree());
        const auto decoded = silverdaw::ValueTreeJson::fromVar(encoded);
        require(static_cast<bool>(decoded.getProperty(juce::Identifier{"metronomeEnabled"}, false)),
                "metronomeEnabled should round-trip through ValueTreeJson when on");
    }

    // Default-off removes the property so projects round-trip without an extra field.
    state.setMetronomeEnabled(false);
    require(! state.getMetronomeEnabled(), "setMetronomeEnabled(false) should round-trip");
    require(! state.getTree().hasProperty(juce::Identifier{"metronomeEnabled"}),
            "default-off metronome should be stored as absent");
    require(! state.isDirty(), "turning the metronome back off must remain silent (not dirty)");
}

void testStemInheritsSynthesisedGridPastLastBeat()
{
    // Regression: a clip-scoped stem whose window begins after the source's last
    // detected beat had every shifted beat dropped, leaving an empty grid — so the
    // timeline hid its beat markers even though the inherited (bpm, anchor) fully
    // described the grid. inheritAnalysisFromSource must synthesise a rigid grid
    // across the stem's own window instead.
    silverdaw::ProjectState state;
    silverdaw::AudioEngine engine;
    auto bridge = makeSilentBridge();

    require(state.addLibraryItem("src", "C:\\audio\\song.wav", "song.wav", 300000.0, 48000, 2),
            "source library item should add");
    require(state.setLibraryItemBpm("src", 120.0), "source BPM should apply");
    require(state.setLibraryItemBeats("src", {0.5, 1.0, 1.5, 2.0, 2.5}),
            "source beats end at 2.5s");
    require(state.setLibraryItemBeatAnchor("src", 0.5), "source anchor should apply");

    // An 8s stem window starting 77.5s into the source — well past the last beat.
    require(state.addLibraryItem("stem", "C:\\audio\\stem.wav", "stem.wav", 8000.0, 48000, 2, "", "",
                                 "stem", "Drums", "src", "clip", 77500.0, 8000.0, -1, ""),
            "stem library item should add with a window offset");

    silverdaw::inheritAnalysisFromSource("stem", "src", engine, state, bridge);

    const auto library = state.getTree().getChildWithName(juce::Identifier{"LIBRARY"});
    juce::ValueTree stem;
    for (int i = 0; i < library.getNumChildren(); ++i)
        if (library.getChild(i).getProperty(juce::Identifier{"id"}).toString() == "stem")
            stem = library.getChild(i);
    require(stem.isValid(), "stem item should exist after inheritance");

    const double anchor = static_cast<double>(stem.getProperty(juce::Identifier{"beatAnchorSec"}, 999.0));
    requireNear(anchor, 0.5 - 77.5, 1e-6, "anchor is the source phase shifted onto the stem timeline");

    const auto beatsVar = stem.getProperty(juce::Identifier{"beats"});
    require(beatsVar.isArray(), "stem should carry a beats array");
    auto* arr = beatsVar.getArray();
    require(arr != nullptr && arr->size() > 0, "stem beats must be synthesised, not empty");
    const double first = static_cast<double>((*arr)[0]);
    require(first >= 0.0 && first < 0.5, "first synthesised beat sits at the grid origin >= 0");
    require(arr->size() >= 15, "an 8s window at 120 BPM yields ~16 beats");
    const double second = static_cast<double>((*arr)[1]);
    requireNear(second - first, 0.5, 1e-6, "synthesised beats are one beat apart at 120 BPM");
    const double last = static_cast<double>((*arr)[arr->size() - 1]);
    require(last <= 8.0 + 1e-6, "synthesised grid stays within the stem window");
}

void testVariableTempoAnalysisAppliesPendingAutoWarp()
{
    silverdaw::ProjectState state;
    silverdaw::AudioEngine engine;
    auto bridge = makeSilentBridge();
    state.setBpm(128.0);
    state.setBpmSeeded(true);

    require(state.addLibraryItem("src", "C:\\audio\\song.wav", "song.wav", 8000.0, 48000, 2),
            "source library item should add");
    require(state.setLibraryItemBpm("src", 100.0), "source BPM should apply");
    require(state.setLibraryItemBeats("src", {0.0, 0.6, 1.2}), "source beats should apply");
    require(state.setLibraryItemBeatAnchor("src", 0.0), "source anchor should apply");
    require(state.setLibraryItemVariableTempo("src", true), "source variable tempo should apply");
    require(state.addLibraryItem("stem", "C:\\audio\\stem.wav", "stem.wav", 8000.0, 48000, 2,
                                 "", "", "stem", "Drums", "src", "source", 0.0, 8000.0, -1, ""),
            "derived library item should add");
    require(state.addTrack("track"), "track should add");
    require(state.addClip("track", "clip", "stem", 0.0, 8000.0), "clip should add");
    require(state.setClipWarp("clip", std::nullopt, std::nullopt, std::nullopt,
                              /*tempoRatioClear=*/false, std::nullopt, std::nullopt,
                              /*pendingAutoWarp=*/true),
            "clip should be marked for late auto-warp");

    silverdaw::inheritAnalysisFromSource("stem", "src", engine, state, bridge);

    bool found = false;
    state.forEachWarpClip(
        [&](const silverdaw::ProjectState::WarpClipInfo& info)
        {
            if (info.clipId != "clip") return;
            found = true;
            require(info.warpEnabled, "variable-tempo analysis should enable pending auto-warp");
            require(! info.pendingAutoWarp, "applied auto-warp should clear the pending flag");
        });
    require(found, "warped clip should remain in project state");
    requireNear(state.getClipEffectiveTiming("clip").tempoRatio, 1.28, 1e-6,
                "late auto-warp should use project BPM divided by representative source BPM");
}

// A reanalysis moves the source tempo under clips that are already on the timeline.
// Clips following the project tempo must be re-derived from the new BPM (their drawn
// width, beat markers and playback all hang off that ratio); a pinned ratio is explicit
// user intent and must survive untouched.
void testReanalysisRederivesWarpForExistingClips()
{
    silverdaw::ProjectState state;
    silverdaw::AudioEngine engine;
    auto bridge = makeSilentBridge();
    state.setBpm(120.0);
    state.setBpmSeeded(true);

    require(state.addLibraryItem("src", "C:\\audio\\song.wav", "song.wav", 8000.0, 48000, 2),
            "source library item should add");
    require(state.setLibraryItemBpm("src", 100.0), "source BPM should apply");
    require(state.addTrack("track"), "track should add");

    require(state.addClip("track", "following", "src", 0.0, 8000.0), "following clip should add");
    require(state.setClipWarp("following", true, std::nullopt, std::nullopt, false, std::nullopt,
                              std::nullopt, std::nullopt),
            "following clip should warp to the project tempo");
    require(state.addClip("track", "pinned", "src", 10000.0, 8000.0), "pinned clip should add");
    require(state.setClipWarp("pinned", true, std::nullopt, 1.5, false, std::nullopt, std::nullopt,
                              std::nullopt),
            "pinned clip should hold its own ratio");
    require(state.addClip("track", "pending", "src", 20000.0, 8000.0), "pending clip should add");
    require(state.setClipWarp("pending", std::nullopt, std::nullopt, std::nullopt, false,
                              std::nullopt, std::nullopt, /*pendingAutoWarp=*/true),
            "pending clip should be marked for late auto-warp");

    requireNear(state.getClipEffectiveTiming("following").tempoRatio, 1.2, 1e-9,
                "the following clip starts at project / original BPM");

    silverdaw::applyManualTempo("src", 80.0, 0.0, engine, state, bridge);

    requireNear(state.getClipEffectiveTiming("following").tempoRatio, 1.5, 1e-9,
                "a reanalysed tempo should re-derive a following clip's ratio");
    requireNear(state.getClipEffectiveTiming("pinned").tempoRatio, 1.5, 1e-9,
                "a pinned ratio must survive a reanalysis unchanged");

    bool sawPinned = false;
    bool sawPending = false;
    state.forEachWarpClip(
        [&](const silverdaw::ProjectState::WarpClipInfo& info)
        {
            if (info.clipId == "pinned")
            {
                sawPinned = true;
                require(info.tempoRatioPinned, "pinned clip should still be pinned");
                requireNear(info.tempoRatio, 1.5, 1e-9, "pinned ratio value should be unchanged");
            }
            if (info.clipId == "pending")
            {
                sawPending = true;
                require(info.warpEnabled, "reanalysis should apply a pending auto-warp");
                require(! info.pendingAutoWarp, "applied auto-warp should clear the pending flag");
            }
        });
    require(sawPinned && sawPending, "both clips should remain in project state");
}

void testEffectiveTimingReportsNearMissWarpOnLongClip()
{
    // Regression: a near-miss tempo (a stem reanalysed to 94.0446 in a 94.05 project)
    // fell inside the old flat ratio epsilon, so the clip reported warpActive=false and
    // its native duration while the engine was already stretching it. The UI then drew
    // the clip at native width with no WARP badge and beat markers off the warped grid.
    silverdaw::ProjectState state;
    state.setBpm(94.05);
    state.setBpmSeeded(true);

    const double stemMs = 177397.0;
    require(state.addLibraryItem("stem", "C:\\audio\\drums.wav", "drums.wav", stemMs, 48000, 2),
            "stem library item should add");
    require(state.setLibraryItemBpm("stem", 94.04458826555116), "reanalysed BPM should apply");
    require(state.addTrack("track"), "track should add");
    require(state.addClip("track", "long", "stem", 0.0, stemMs), "long clip should add");
    require(state.setClipWarp("long", true, std::nullopt, std::nullopt, false, std::nullopt,
                              std::nullopt, std::nullopt),
            "warp should enable");

    const auto longTiming = state.getClipEffectiveTiming("long");
    require(longTiming.warpActive, "a near-miss tempo should warp a three-minute stem");
    require(longTiming.durationMs < stemMs - 1.0,
            "an active warp should shorten the reported timeline duration");

    // The same tempo mismatch moves a two-bar loop by well under a millisecond.
    const double loopMs = 5104.0;
    require(state.addClip("track", "short", "stem", 200000.0, loopMs), "short clip should add");
    require(state.setClipWarp("short", true, std::nullopt, std::nullopt, false, std::nullopt,
                              std::nullopt, std::nullopt),
            "warp should enable");

    const auto shortTiming = state.getClipEffectiveTiming("short");
    require(! shortTiming.warpActive, "the same tempo mismatch is inaudible on a short loop");
    requireNear(shortTiming.durationMs, loopMs, 1e-9,
                "an inactive warp should report the native duration");
}

void testClipSetWarpRejectsMalformedTempoRatio()
{
    // Regression: a wrong-typed tempoRatio used to be raw-cast to 0.0, which
    // setClipWarp clamps to the 0.25 floor and persists — silently baking a 4x
    // time-stretch into the saved project that the user cannot explain or undo.
    // The strict reader must ignore the bad field and leave the ratio untouched.
    silverdaw::ProjectState state;
    silverdaw::AudioEngine engine;
    auto bridge = makeSilentBridge();

    require(state.addLibraryItem("src", "C:\\audio\\song.wav", "song.wav", 8000.0, 48000, 2),
            "library item should add");
    require(state.addTrack("track"), "track should add");
    require(state.addClip("track", "clip", "src", 0.0, 8000.0), "clip should add");

    auto* obj = new juce::DynamicObject();
    obj->setProperty("clipId", "clip");
    obj->setProperty("tempoRatio", "not-a-number");
    const juce::var payload(obj);

    silverdaw::handleClipSetWarp(payload, engine, state, bridge);

    bool found = false;
    state.forEachWarpClip(
        [&](const silverdaw::ProjectState::WarpClipInfo& info)
        {
            if (info.clipId != "clip") return;
            found = true;
            // The old raw cast produced 0.0, which the 0.25..4.0 clamp turned into a
            // pinned 0.25 — a durable 4x stretch written into the project file.
            require(!info.tempoRatioPinned,
                    "a malformed tempoRatio must not pin a tempo ratio on the clip");
        });
    require(found, "clip should remain in project state");
}

void testProjectStateManualTempoIsUndoableAndDirtying()
{
    // A hand-set tempo/beat grid is a deliberate user edit: unlike automatic
    // analysis (which is derived and silent) it marks the project dirty and is
    // undoable via the UndoManager, so Ctrl+Z reverts it.
    silverdaw::ProjectState state;
    require(state.addLibraryItem("l1", "C:\\audio\\loop.wav", "loop.wav", 4000.0, 48000, 2),
            "library add should succeed");
    // Seed a derived (non-dirty) analysis BPM, then take that as the clean baseline.
    require(state.setLibraryItemBpm("l1", 100.0), "baseline bpm should apply");
    state.markClean();
    require(! state.isDirty(), "baseline should be clean");

    state.getUndoManager().beginNewTransaction("Set manual tempo");
    require(state.setLibraryItemManualTempo("l1", 128.0, {0.0, 0.46875, 0.9375}, 0.0),
            "manual tempo setter should find the item");
    require(state.isDirty(), "manual tempo is a real edit and must mark the project dirty");
    require(state.getUndoManager().canUndo(), "manual tempo must push an undo entry");
    requireNear(state.getLibraryItemBpmForPath("C:\\audio\\loop.wav"), 128.0, 0.0001,
                "manual bpm should be live before undo");

    require(state.getUndoManager().undo(), "undo should succeed");
    requireNear(state.getLibraryItemBpmForPath("C:\\audio\\loop.wav"), 100.0, 0.0001,
                "undo must restore the previous bpm");
    require(! state.isDirty(), "undo must return the project to clean");
}

void testProjectStatePerformUndoRedoTracksDirty()
{
    // performUndo/performRedo suppress the per-action dirty listener and recompute dirty once.
    // The observable dirty result must still match a plain UndoManager undo/redo: a real edit
    // dirties, undoing it returns to clean, and redoing it dirties again.
    silverdaw::ProjectState state;
    state.markClean();
    require(! state.isDirty(), "baseline should be clean");

    state.getUndoManager().beginNewTransaction("Add track");
    require(state.addTrack("t1"), "addTrack should succeed");
    require(state.isDirty(), "adding a track should mark dirty");

    require(state.performUndo(), "performUndo should walk the transaction");
    require(! state.isDirty(), "performUndo must recompute the project back to clean");

    require(state.performRedo(), "performRedo should re-apply the transaction");
    require(state.isDirty(), "performRedo must recompute the project dirty again");

    require(! state.performRedo(), "performRedo with nothing to redo returns false");
}

void testProjectStateUndoChangeSetClassification()
{
    // performUndo/performRedo record which entities a reverted transaction touched so the caller
    // can pick the incremental engine update (clip-only, non-structural) over a full rebuild.
    silverdaw::ProjectState state;
    require(state.addLibraryItem("lib1", "C:\\audio\\a.wav", "a.wav", 4000.0, 48000, 2),
            "library add lib1");
    require(state.addLibraryItem("lib2", "C:\\audio\\b.wav", "b.wav", 4000.0, 48000, 2),
            "library add lib2");
    require(state.addTrack("t1"), "addTrack");
    require(state.addClip("t1", "c1", "lib1", 0.0, 1000.0), "addClip c1");
    state.markClean();

    // 1. A non-structural clip edit (move) → fast path: the touched clip is recorded and no full
    //    rebuild is needed.
    state.getUndoManager().beginNewTransaction("Move clip");
    require(state.setClipOffsetMs("c1", 500.0), "move clip");
    require(state.performUndo(), "undo move");
    require(! state.lastUndoChangeSet().needsFullRebuild,
            "a clip move undo must not need a full rebuild");
    require(state.lastUndoChangeSet().clipIds.contains("c1"),
            "a clip move undo must record the touched clip");

    // 2. A track edit is outside the clip-only fast path → full rebuild.
    state.getUndoManager().beginNewTransaction("Track gain");
    require(state.setTrackGain("t1", 0.5F), "track gain");
    require(state.performUndo(), "undo track gain");
    require(state.lastUndoChangeSet().needsFullRebuild,
            "a track edit undo must need a full rebuild");

    // 3. A structural edit (adding a clip) → full rebuild.
    state.getUndoManager().beginNewTransaction("Add clip");
    require(state.addClip("t1", "c2", "lib1", 2000.0, 1000.0), "add second clip");
    require(state.performUndo(), "undo add clip");
    require(state.lastUndoChangeSet().needsFullRebuild,
            "a structural (clip add) undo must need a full rebuild");

    // 4. A relink (libraryItemId change) swaps the audio source → full rebuild.
    state.getUndoManager().beginNewTransaction("Relink clip");
    require(state.setClipLibraryItemId("c1", "lib2"), "relink clip");
    require(state.performUndo(), "undo relink");
    require(state.lastUndoChangeSet().needsFullRebuild,
            "a relink undo must need a full rebuild");
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
    tests.push_back({"ProjectState attributes background-analysis dirty",
                     testProjectStateAttributesBackgroundAnalysisDirty});
    tests.push_back({"ProjectState cleanup library remove is non-dirty and non-undoable", testProjectStateNonDirtyLibraryRemove});
    tests.push_back({"ProjectState reanalyse preserves a derived library-item kind", testProjectStateReanalyseKeepsDerivedKind});
    tests.push_back({"ProjectState simple classification strips and blocks tempo", testProjectStateSimpleClassificationHasNoTempo});
    tests.push_back({"ProjectState source-BPM resolver contract", testProjectStateSourceBpmResolverContract});
    tests.push_back({"ProjectState tempo-owner resolver contract", testProjectStateTempoOwnerResolverContract});
    tests.push_back({"Tempo correction never moves persisted anchors", testTempoCorrectionNeverMovesPersistedAnchors});
    tests.push_back({"Tempo correction leaves the project tempo alone", testTempoCorrectionLeavesTheProjectTempoAlone});
    tests.push_back({"Tempo correction must not seed an unseeded project", testTempoCorrectionMustNotSeedAnUnseededProject});
    tests.push_back({"Tempo correction is redirected to the tempo owner", testTempoCorrectionIsRedirectedToTheTempoOwner});
    tests.push_back({"Tempo correction keeps the owner's grid phase when none is given", testTempoCorrectionKeepsTheOwnersGridPhaseWhenNoneIsGiven});
    tests.push_back({"Tempo correction rejects an unusable grid phase", testTempoCorrectionRejectsAnUnusableGridPhase});
    tests.push_back({"Tempo correction supersedes a detection already in flight", testTempoCorrectionSupersedesADetectionAlreadyInFlight});
    tests.push_back({"Tempo correction re-derives followers and reports exclusions", testTempoCorrectionRederivesFollowersAndReportsExclusions});
    tests.push_back({"Tempo correction scales clip envelopes with their footprint", testTempoCorrectionScalesClipEnvelopesWithTheirFootprint});
    tests.push_back({"Tempo correction rejects what it cannot correct", testTempoCorrectionRejectsWhatItCannotCorrect});
    tests.push_back({"Tempo correction undoes the whole correction in one step", testTempoCorrectionUndoesTheWholeCorrectionInOneStep});
    tests.push_back({"ProjectState repairs legacy sample kind on load", testProjectStateRepairsLegacySampleKind});
    tests.push_back({"ProjectState repairs demoted stem kind on load", testProjectStateRepairsDemotedStemKind});
    tests.push_back({"ProjectState musical length outranks detected bpm", testProjectStateMusicalLengthOutranksDetectedBpm});
    tests.push_back({"ProjectState retimes clips on tempo change", testProjectStateRetimesClipsOnTempoChange});
    tests.push_back({"ProjectState retimes markers on tempo change", testProjectStateRetimesMarkersOnTempoChange});
    tests.push_back({"ProjectState retimes track automation on tempo change", testProjectStateRetimesTrackAutomationOnTempoChange});
    tests.push_back({"ProjectState retimes clip envelopes on tempo change", testProjectStateRetimesClipEnvelopesOnTempoChange});
    tests.push_back({"ProjectState derived items inherit tempo instead of detecting", testProjectStateTempoInheritanceSourceId});
    tests.push_back({"ProjectState cover-art hidden override persists and marks dirty", testProjectStateCoverArtHiddenOverride});
    tests.push_back({"ProjectState suppressed property drift clears on undo", testProjectStateSuppressedPropertiesDoNotStickDirtyAcrossUndo});
    tests.push_back({"ProjectState derived library metadata does not mark dirty", testProjectStateDerivedLibraryMetadataDoesNotMarkDirty});
    tests.push_back({"Project length repairs timeline selection", testProjectLengthRepairsTimelineSelection});
    tests.push_back({"ProjectState manual tempo is undoable and marks dirty", testProjectStateManualTempoIsUndoableAndDirtying});
    tests.push_back({"ProjectState performUndo/performRedo track dirty", testProjectStatePerformUndoRedoTracksDirty});
    tests.push_back({"ProjectState undo change set classifies fast path vs rebuild", testProjectStateUndoChangeSetClassification});
    tests.push_back({"ProjectState clip transitions: derive, serialise, invariants, reconcile", testProjectStateClipTransitions});
    tests.push_back({"ProjectState bpmSeeded flag persists across save/load", testProjectStateBpmSeededRoundTrip});
    tests.push_back({"First on-track clip seeds project BPM", testFirstClipSeedsProjectBpm});
    tests.push_back({"Low-confidence first clip still seeds project BPM", testLowConfidenceFirstClipSeeds});
    tests.push_back({"Pre-existing library BPMs do not block the first seed", testStemBpmsDoNotBlockFirstSeed});
    tests.push_back({"Seeded project BPM is not overridden by later clips", testSeededProjectIsNotReSeeded});
    tests.push_back({"User-classified sample does not seed project BPM", testExplicitSampleDoesNotSeed});
    tests.push_back({"One-shot classification is inherited by the BPM resolver",
                     testOneShotClassificationIsInheritedByResolver});
    tests.push_back({"Library item duration lookup by id", testLibraryItemDurationLookup});
    tests.push_back({"ProjectState scratch library metadata round-trips", testProjectStateScratchLibraryMetadata});
    tests.push_back({"ProjectState rename is not undoable", testProjectStateRenameIsNotUndoable});
    tests.push_back({"Undo group collapses a compound edit to one step", testUndoGroupCollapsesCompoundEditToOneStep});
    tests.push_back({"Nested undo groups collapse to one step", testNestedUndoGroupsCollapseToOneStep});
    tests.push_back({"Duplicate-clip group undoes in one step", testDuplicateClipGroupUndoesInOneStep});
    tests.push_back({"Clip effect after a group is a separate undo step", testClipEffectAfterGroupIsSeparateUndoStep});
    tests.push_back({"ProjectState metronome toggle persists silently", testProjectStateMetronomeRoundTrip});
    tests.push_back({"Stem inherits a synthesised grid past the last source beat",
                     testStemInheritsSynthesisedGridPastLastBeat});
    tests.push_back({"Variable-tempo analysis applies pending auto-warp",
                     testVariableTempoAnalysisAppliesPendingAutoWarp});
    tests.push_back({"CLIP_SET_WARP rejects a malformed tempoRatio",
                     testClipSetWarpRejectsMalformedTempoRatio});
    tests.push_back({"Effective timing reports a near-miss warp on a long clip",
                     testEffectiveTimingReportsNearMissWarpOnLongClip});
    tests.push_back({"Reanalysis re-derives warp for clips already on the timeline",
                     testReanalysisRederivesWarpForExistingClips});
}

} // namespace silverdaw::tests
