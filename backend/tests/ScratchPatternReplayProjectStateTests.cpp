#include "TestRegistry.h"
#include "ScratchTestFixtures.h"

#include "ProjectState.h"
#include "scratch/ScratchProtocol.h"

namespace silverdaw::tests
{
namespace
{

void testClipScratchPatternApplyAndRetrieve()
{
    silverdaw::ProjectState state;
    state.addTrack("t1");
    state.addClip("t1", "clip-1", "lib-1", 0.0, 5000.0, 0.0);
    state.addScratchPattern(makeValidPatternVar("sp-1", "Test"));

    require(state.setClipScratchPatternId("clip-1", "sp-1"),
            "applying pattern to existing clip should succeed");
    requireEqual(state.getClipScratchPatternId("clip-1"), juce::String("sp-1"),
                 "clip should reference the applied pattern");
}

void testClipScratchPatternRemove()
{
    silverdaw::ProjectState state;
    state.addTrack("t1");
    state.addClip("t1", "clip-1", "lib-1", 0.0, 5000.0, 0.0);
    state.addScratchPattern(makeValidPatternVar("sp-1", "Test"));
    state.setClipScratchPatternId("clip-1", "sp-1");

    require(state.setClipScratchPatternId("clip-1", {}),
            "removing pattern from clip should succeed");
    requireEqual(state.getClipScratchPatternId("clip-1"), juce::String{},
                 "clip should have no pattern after removal");
}

void testClipScratchPatternUnknownClip()
{
    silverdaw::ProjectState state;
    require(!state.setClipScratchPatternId("nonexistent", "sp-1"),
            "applying pattern to unknown clip should fail");
}

void testClipScratchPatternUndoRedo()
{
    silverdaw::ProjectState state;
    state.addTrack("t1");
    state.addClip("t1", "clip-1", "lib-1", 0.0, 5000.0, 0.0);
    state.addScratchPattern(makeValidPatternVar("sp-1", "Test"));

    state.setClipScratchPatternId("clip-1", "sp-1");
    requireEqual(state.getClipScratchPatternId("clip-1"), juce::String("sp-1"),
                 "pattern should be applied before undo");

    state.getUndoManager().undo();
    requireEqual(state.getClipScratchPatternId("clip-1"), juce::String{},
                 "pattern should be removed after undo");

    state.getUndoManager().redo();
    requireEqual(state.getClipScratchPatternId("clip-1"), juce::String("sp-1"),
                 "pattern should be restored after redo");
}

void testClipScratchPatternPersistence()
{
    silverdaw::ProjectState state;
    state.addTrack("t1");
    state.addClip("t1", "clip-1", "lib-1", 0.0, 5000.0, 0.0);
    state.addScratchPattern(makeValidPatternVar("sp-1", "Test"));
    state.setClipScratchPatternId("clip-1", "sp-1");

    // Serialize and check it appears in JSON.
    const auto json = state.tracksAsJson();
    const auto* tracksArr = json.getArray();
    require(tracksArr != nullptr && tracksArr->size() > 0,
            "tracksAsJson should have at least one track");

    // The clip's scratchPatternId should appear in the serialized output.
    // Note: tracksAsJson → tracks[0].clips[0].scratchPatternId
    const auto& track = (*tracksArr)[0];
    const auto clips = track.getProperty("clips", juce::var());
    const auto* clipsArr = clips.getArray();
    require(clipsArr != nullptr && clipsArr->size() > 0,
            "track should have at least one clip");

    const auto& clip = (*clipsArr)[0];
    requireEqual(clip.getProperty("scratchPatternId", {}).toString(), juce::String("sp-1"),
                 "serialized clip should include scratchPatternId");
}

void testClipScratchPatternMissingPatternSafe()
{
    // A clip may reference a pattern that was later deleted.
    silverdaw::ProjectState state;
    state.addTrack("t1");
    state.addClip("t1", "clip-1", "lib-1", 0.0, 5000.0, 0.0);
    state.addScratchPattern(makeValidPatternVar("sp-1", "Test"));
    state.setClipScratchPatternId("clip-1", "sp-1");

    // Now delete the pattern — the clip reference stays (graceful degradation).
    state.removeScratchPattern("sp-1");
    requireEqual(state.getClipScratchPatternId("clip-1"), juce::String("sp-1"),
                 "clip reference should persist even after pattern deletion");
    require(!state.hasScratchPattern("sp-1"),
            "pattern should be gone from the pattern store");
}

void testClipScratchPatternDirtyTracking()
{
    silverdaw::ProjectState state;
    state.addTrack("t1");
    state.addClip("t1", "clip-1", "lib-1", 0.0, 5000.0, 0.0);
    state.markClean();
    require(!state.isDirty(), "state should be clean");

    state.setClipScratchPatternId("clip-1", "sp-1");
    require(state.isDirty(), "setting pattern should mark project dirty");
}

} // namespace

void addScratchPatternReplayProjectStateTests(std::vector<TestCase>& tests)
{
    tests.push_back({"scratch_pattern_clip_apply_and_retrieve", testClipScratchPatternApplyAndRetrieve});
    tests.push_back({"scratch_pattern_clip_remove", testClipScratchPatternRemove});
    tests.push_back({"scratch_pattern_clip_unknown_clip", testClipScratchPatternUnknownClip});
    tests.push_back({"scratch_pattern_clip_undo_redo", testClipScratchPatternUndoRedo});
    tests.push_back({"scratch_pattern_clip_persistence", testClipScratchPatternPersistence});
    tests.push_back({"scratch_pattern_clip_missing_pattern_safe", testClipScratchPatternMissingPatternSafe});
    tests.push_back({"scratch_pattern_clip_dirty_tracking", testClipScratchPatternDirtyTracking});
}

} // namespace silverdaw::tests
