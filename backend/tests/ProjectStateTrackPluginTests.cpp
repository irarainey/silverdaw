// Per-track VST3 insert slots in ProjectState (ADR 0025): CRUD, chain ordering when clips share
// the child list, and the PROJECT_STATE shape the renderer's Plugins panel reads — including the
// unresolved flag, which is derived from the machine and must never be persisted.

#include "TestRegistry.h"

#include "ProjectState.h"
#include "ProjectStateTypes.h"

#include <juce_core/juce_core.h>

namespace silverdaw::tests
{
namespace
{

TrackPluginSlot makeSlot(const juce::String& slotId, const juce::String& identifier,
                         const juce::String& name)
{
    TrackPluginSlot slot;
    slot.slotId = slotId;
    slot.identifier = identifier;
    slot.name = name;
    slot.manufacturer = "Acme";
    return slot;
}

juce::var findTrackJson(const juce::var& tracks, const juce::String& trackId)
{
    if (const auto* array = tracks.getArray())
        for (const auto& entry : *array)
            if (entry.getProperty("id", {}).toString() == trackId) return entry;

    return {};
}

void testTrackPluginCrudRoundTrip()
{
    silverdaw::ProjectState state;
    require(state.addTrack("t-plugins"), "addTrack should accept a new id");

    require(state.addTrackPlugin("t-plugins", makeSlot("s1", "id-1", "First")),
            "first slot should be added");
    require(state.addTrackPlugin("t-plugins", makeSlot("s2", "id-2", "Second")),
            "second slot should be added");
    require(!state.addTrackPlugin("t-plugins", makeSlot("s1", "id-3", "Duplicate")),
            "a duplicate slot id must be rejected");
    require(!state.addTrackPlugin("no-such-track", makeSlot("s9", "id-9", "Orphan")),
            "an unknown track id must be rejected");

    auto slots = state.getTrackPlugins("t-plugins");
    require(slots.size() == 2, "the track should hold two slots");
    require(slots[0].slotId == "s1" && slots[1].slotId == "s2", "slots come back in chain order");
    require(slots[0].name == "First" && slots[0].manufacturer == "Acme",
            "descriptor fields survive the round-trip");
    require(!slots[0].bypassed, "a new slot is not bypassed");

    require(state.setTrackPluginBypassed("t-plugins", "s2", true), "bypass should apply");
    require(state.getTrackPlugins("t-plugins")[1].bypassed, "bypass should persist");

    require(state.setTrackPluginState("t-plugins", "s1", "Y2hldw=="), "state chunk should store");
    require(state.getTrackPlugins("t-plugins")[0].state == "Y2hldw==",
            "the stored chunk should come back verbatim");

    require(state.removeTrackPlugin("t-plugins", "s1"), "remove should succeed");
    require(!state.removeTrackPlugin("t-plugins", "s1"), "removing twice must fail");
    slots = state.getTrackPlugins("t-plugins");
    require(slots.size() == 1 && slots[0].slotId == "s2", "only the surviving slot remains");
}

void testTrackPluginReorderIgnoresOtherChildren()
{
    silverdaw::ProjectState state;
    require(state.addTrack("t-mixed"), "addTrack should accept a new id");
    // Beat-repeat regions live in the same child list, so a slot's chain position is not its
    // child index — the reorder must map through the plugin children only.
    require(state.addTrackPlugin("t-mixed", makeSlot("s1", "id-1", "First")), "slot 1 added");
    require(state.addBeatRepeatRegion("t-mixed", "r1", 0.0, 4.0, "1/8"), "region added");
    require(state.addTrackPlugin("t-mixed", makeSlot("s2", "id-2", "Second")), "slot 2 added");
    require(state.addTrackPlugin("t-mixed", makeSlot("s3", "id-3", "Third")), "slot 3 added");

    require(state.moveTrackPlugin("t-mixed", "s3", 0), "moving the last slot to the front");
    auto slots = state.getTrackPlugins("t-mixed");
    require(slots.size() == 3, "no slot should be lost");
    require(slots[0].slotId == "s3" && slots[1].slotId == "s1" && slots[2].slotId == "s2",
            "chain order should follow the requested index");

    // An out-of-range index clamps rather than failing, so a stale renderer cannot corrupt
    // the chain.
    require(state.moveTrackPlugin("t-mixed", "s3", 99), "an out-of-range index should clamp");
    slots = state.getTrackPlugins("t-mixed");
    require(slots[2].slotId == "s3", "the slot should land at the end of the chain");

    require(state.getBeatRepeatRegions("t-mixed").size() == 1,
            "the beat-repeat region must be untouched");
}

void testTrackPluginJsonExposesUnresolvedWithoutPersistingIt()
{
    silverdaw::ProjectState state;
    require(state.addTrack("t-json"), "addTrack should accept a new id");
    require(state.addTrackPlugin("t-json", makeSlot("s1", "installed", "Installed")), "slot 1");
    require(state.addTrackPlugin("t-json", makeSlot("s2", "missing", "Missing")), "slot 2");

    // Without a probe every slot is assumed to resolve, so a headless run emits no flag.
    {
        const auto track = findTrackJson(state.tracksAsJson(), "t-json");
        const auto* plugins = track.getProperty("plugins", {}).getArray();
        require(plugins != nullptr && plugins->size() == 2, "both slots should be in the snapshot");
        require(!(*plugins)[1].hasProperty("unresolved"),
                "no probe means no unresolved flag");
    }

    state.setPluginAvailabilityProbe(
        [](const juce::String& identifier) { return identifier == "installed"; });

    const auto track = findTrackJson(state.tracksAsJson(), "t-json");
    const auto* plugins = track.getProperty("plugins", {}).getArray();
    require(plugins != nullptr && plugins->size() == 2, "both slots should still be present");
    require((*plugins)[0].getProperty("slotId", {}).toString() == "s1", "chain order is preserved");
    require(!(*plugins)[0].hasProperty("unresolved"), "an installed plugin is not flagged");
    require(static_cast<bool>((*plugins)[1].getProperty("unresolved", false)),
            "a missing plugin is flagged for the renderer");
    require((*plugins)[1].getProperty("name", {}).toString() == "Missing",
            "an unresolved slot still carries its name");

    // ADR 0003: the opaque state chunk is never sent to the renderer.
    require(state.setTrackPluginState("t-json", "s1", "Y2hldw=="), "state chunk should store");
    const auto after = findTrackJson(state.tracksAsJson(), "t-json");
    require(!after.getProperty("plugins", {}).getArray()->getReference(0).hasProperty("state"),
            "state chunks must not cross the bridge");

    // The flag is machine-specific, so it must not reach the tree the project file is built from.
    const auto trackTree = state.getTree().getChildWithProperty(juce::Identifier{"id"}, "t-json");
    for (int i = 0; i < trackTree.getNumChildren(); ++i)
    {
        const auto child = trackTree.getChild(i);
        if (child.hasType(juce::Identifier{"PLUGIN"}))
            require(!child.hasProperty(juce::Identifier{"unresolved"}),
                    "unresolved must never be written into the project tree");
    }
}

} // namespace

void addProjectStateTrackPluginTests(std::vector<TestCase>& tests)
{
    tests.push_back({"ProjectState track plugin slots round-trip", testTrackPluginCrudRoundTrip});
    tests.push_back({"ProjectState track plugin reorder skips non-plugin children",
                     testTrackPluginReorderIgnoresOtherChildren});
    tests.push_back({"ProjectState track plugins expose unresolved without persisting it",
                     testTrackPluginJsonExposesUnresolvedWithoutPersistingIt});
}

} // namespace silverdaw::tests
