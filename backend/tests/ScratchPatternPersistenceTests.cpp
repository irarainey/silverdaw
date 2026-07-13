// Scratch-pattern persistence tests: ProjectState CRUD, undo/redo, project-file
// round-trip, and PROJECT_STATE snapshot coverage.

#include "ScratchTestFixtures.h"
#include "TestRegistry.h"

#include "ProjectFile.h"
#include "ProjectSession.h"
#include "ProjectState.h"
#include "scratch/ScratchProtocol.h"

#include <juce_core/juce_core.h>
#include <juce_data_structures/juce_data_structures.h>

namespace silverdaw::tests
{
namespace
{

// ─── Tests ───────────────────────────────────────────────────────────────────

void testScratchPatternAddAndRetrieve()
{
    silverdaw::ProjectState state;
    const auto pat = makeValidPatternVar();
    require(state.addScratchPattern(pat), "addScratchPattern should succeed for a valid pattern");
    require(state.hasScratchPattern("sp-1"), "hasScratchPattern should be true after add");

    const auto json = state.scratchPatternsAsJson();
    const auto* arr = json.getArray();
    require(arr != nullptr && arr->size() == 1, "scratchPatternsAsJson should contain one pattern");
    requireEqual((*arr)[0].getProperty("id", {}).toString(), "sp-1",
                 "serialised pattern should retain its id");
    requireEqual((*arr)[0].getProperty("name", {}).toString(), "Test",
                 "serialised pattern should retain its name");

    // Roundtrip: the stored var should parse back cleanly.
    const auto parsed = scratch::parsePattern((*arr)[0]);
    require(parsed.has_value(), "stored pattern should round-trip through parsePattern");
    requireEqual(parsed->id, "sp-1", "round-tripped id should match");
}

void testScratchPatternUpdate()
{
    silverdaw::ProjectState state;
    require(state.addScratchPattern(makeValidPatternVar("sp-1", "Original")),
            "initial add should succeed");
    state.markClean();
    require(!state.isDirty(), "state should be clean after markClean");

    const auto updated = makeValidPatternVar("sp-1", "Revised");
    require(state.updateScratchPattern("sp-1", updated), "update for existing id should succeed");
    require(state.isDirty(), "update should mark the project dirty");

    const auto json = state.scratchPatternsAsJson();
    const auto* arr = json.getArray();
    require(arr != nullptr && arr->size() == 1, "update should not add a duplicate entry");
    requireEqual((*arr)[0].getProperty("name", {}).toString(), "Revised",
                 "name should be updated");

    require(!state.updateScratchPattern("no-such-id", updated),
            "update for unknown id should return false");
}

void testScratchPatternDelete()
{
    silverdaw::ProjectState state;
    require(state.addScratchPattern(makeValidPatternVar("sp-1", "A")), "add should succeed");
    require(state.addScratchPattern(makeValidPatternVar("sp-2", "B")), "second add should succeed");

    require(state.removeScratchPattern("sp-1"), "remove for existing id should succeed");
    require(!state.hasScratchPattern("sp-1"), "pattern should be absent after remove");
    require(state.hasScratchPattern("sp-2"), "other pattern should be unaffected");

    const auto json = state.scratchPatternsAsJson();
    const auto* arr = json.getArray();
    require(arr != nullptr && arr->size() == 1, "only one pattern should remain");
    requireEqual((*arr)[0].getProperty("id", {}).toString(), "sp-2",
                 "remaining pattern should be sp-2");

    require(!state.removeScratchPattern("sp-1"), "remove for already-deleted id should return false");
    require(!state.removeScratchPattern(""), "remove with empty id should return false");
}

void testScratchPatternDuplicateIdIdempotentUpdate()
{
    silverdaw::ProjectState state;
    const auto first = makeValidPatternVar("sp-1", "First");
    require(state.addScratchPattern(first), "first add should succeed");

    // Adding the same id again with a different name is an idempotent update.
    const auto second = makeValidPatternVar("sp-1", "Second");
    require(state.addScratchPattern(second), "second add with same id should succeed (update)");
    require(state.hasScratchPattern("sp-1"), "pattern should still exist");

    const auto json = state.scratchPatternsAsJson();
    const auto* arr = json.getArray();
    require(arr != nullptr && arr->size() == 1, "no duplicate should be created");
    requireEqual((*arr)[0].getProperty("name", {}).toString(), "Second",
                 "in-place update should use the new name");
}

void testScratchPatternMalformedInputRejected()
{
    silverdaw::ProjectState state;

    // Non-object input.
    require(!state.addScratchPattern(juce::var("not an object")),
            "non-object payload should be rejected");

    // Pattern with wrong version.
    auto badVersion = makeValidPatternVar("sp-1", "Bad");
    badVersion.getDynamicObject()->setProperty("version", 2);
    require(!state.addScratchPattern(badVersion), "wrong version should be rejected");

    // Pattern with empty id.
    auto noId = makeValidPatternVar("", "NoId");
    require(!state.addScratchPattern(noId), "empty id should be rejected");

    require(!state.hasScratchPattern(""), "no patterns should have been stored");
    const auto jsonResult = state.scratchPatternsAsJson();
    const auto* arr = jsonResult.getArray();
    require(arr != nullptr && arr->isEmpty(), "no patterns should persist after all rejections");
}

void testScratchPatternRename()
{
    silverdaw::ProjectState state;
    require(state.addScratchPattern(makeValidPatternVar("sp-1", "Original")), "add should succeed");

    require(state.renameScratchPattern("sp-1", "NewName"), "rename should succeed for existing id");
    const auto json = state.scratchPatternsAsJson();
    const auto* arr = json.getArray();
    require(arr != nullptr && arr->size() == 1, "one pattern should remain");
    requireEqual((*arr)[0].getProperty("name", {}).toString(), "NewName",
                 "name should be updated by rename");

    // Rename should also update the name in the stored pattern data (round-trips correctly).
    const auto parsed = scratch::parsePattern((*arr)[0]);
    require(parsed.has_value(), "renamed pattern should still parse cleanly");
    requireEqual(parsed->name, "NewName", "parsePattern should see the new name");

    require(!state.renameScratchPattern("no-such", "X"), "rename for unknown id should fail");
    require(!state.renameScratchPattern("sp-1", ""), "rename to empty name should fail");
}

void testScratchPatternJsonRoundtrip()
{
    const auto dir = makeTempDir("scratch-pattern-roundtrip");
    const auto file = dir.getChildFile("project.silverdaw");

    silverdaw::ProjectState state;
    state.replaceTree(makeProjectTree());
    require(state.addScratchPattern(makeValidPatternVar("sp-1", "Pattern A")),
            "add before save should succeed");
    require(state.addScratchPattern(makeValidPatternVar("sp-2", "Pattern B")),
            "second add before save should succeed");
    state.markClean();

    require(silverdaw::ProjectFile::save(file, state).wasOk(), "save should succeed");

    silverdaw::ProjectState loaded;
    require(silverdaw::ProjectFile::load(file, loaded).ok, "load should succeed");
    require(loaded.hasScratchPattern("sp-1"), "sp-1 should survive the file round-trip");
    require(loaded.hasScratchPattern("sp-2"), "sp-2 should survive the file round-trip");

    const auto json = loaded.scratchPatternsAsJson();
    const auto* arr = json.getArray();
    require(arr != nullptr && arr->size() == 2, "both patterns should be present after reload");

    // Both patterns should parse cleanly after the round-trip.
    for (int i = 0; i < arr->size(); ++i)
    {
        const auto parsed = scratch::parsePattern((*arr)[i]);
        require(parsed.has_value(), "reloaded pattern should parse cleanly");
    }
}

void testScratchPatternOlderProjectHasNoPatterns()
{
    // A project saved without SCRATCH_PATTERNS (an older file) must yield zero patterns.
    silverdaw::ProjectState state;
    state.replaceTree(makeProjectTree()); // makeProjectTree has no SCRATCH_PATTERNS

    require(!state.hasScratchPattern("any"), "older project should have no patterns");
    const auto json = state.scratchPatternsAsJson();
    const auto* arr = json.getArray();
    require(arr != nullptr && arr->isEmpty(),
            "scratchPatternsAsJson should return empty array for older project");
}

void testScratchPatternUndoAdd()
{
    silverdaw::ProjectState state;
    state.markClean();

    state.getUndoManager().beginNewTransaction("Add scratch pattern");
    require(state.addScratchPattern(makeValidPatternVar("sp-1", "Pattern")),
            "add should succeed");
    require(state.hasScratchPattern("sp-1"), "pattern should be present after add");
    require(state.isDirty(), "project should be dirty after add");

    state.performUndo();

    require(!state.hasScratchPattern("sp-1"), "pattern should be absent after undo");
    require(!state.isDirty(), "undo should return project to clean state");
}

void testScratchPatternUndoDelete()
{
    silverdaw::ProjectState state;
    require(state.addScratchPattern(makeValidPatternVar("sp-1", "Pattern")), "add should succeed");
    state.markClean();

    // Flush the open transaction from addScratchPattern so delete is its own step.
    state.getUndoManager().beginNewTransaction();
    require(state.removeScratchPattern("sp-1"), "delete should succeed");
    require(!state.hasScratchPattern("sp-1"), "pattern should be absent after delete");

    state.performUndo();

    require(state.hasScratchPattern("sp-1"), "pattern should be restored after undo-of-delete");
}

void testScratchPatternSnapshotIncludesPatterns()
{
    silverdaw::ProjectState state;
    require(state.addScratchPattern(makeValidPatternVar("sp-1", "Pattern A")), "add should succeed");

    ProjectSession session; // empty path
    const auto envelope = silverdaw::buildProjectStateEnvelope(session, state, false);
    require(envelope.isObject(), "envelope should be an object");

    const auto scratchPatterns = envelope.getProperty("scratchPatterns", juce::var());
    require(scratchPatterns.isArray(), "envelope should include scratchPatterns array");
    const auto* arr = scratchPatterns.getArray();
    require(arr != nullptr && arr->size() == 1, "envelope scratchPatterns should contain one entry");
    requireEqual((*arr)[0].getProperty("id", {}).toString(), "sp-1",
                 "pattern id should appear in the snapshot");

    // A project with no patterns should omit the field to keep legacy payloads byte-clean.
    silverdaw::ProjectState empty;
    const auto emptyEnvelope = silverdaw::buildProjectStateEnvelope(session, empty, false);
    const auto absent = emptyEnvelope.getProperty("scratchPatterns", juce::var());
    require(absent.isVoid() || (absent.isArray() && absent.getArray()->isEmpty()),
            "empty project should omit scratchPatterns from envelope");
}

void testScratchPatternMaxPointsEnforced()
{
    // Build a platter array with more than kMaxPatternPoints entries.
    constexpr int overLimit = scratch::kMaxPatternPoints + 1;
    const juce::int64 durationUs = overLimit;

    juce::Array<juce::var> platter;
    platter.ensureStorageAllocated(overLimit);
    for (int i = 0; i < overLimit; ++i)
    {
        auto* pt = new juce::DynamicObject();
        pt->setProperty("timeUs", static_cast<juce::int64>(i));
        pt->setProperty("turns", 0.0);
        pt->setProperty("touched", false);
        platter.add(juce::var(pt));
    }

    juce::Array<juce::var> crossfader;
    {
        auto* c0 = new juce::DynamicObject();
        c0->setProperty("timeUs", static_cast<juce::int64>(0));
        c0->setProperty("value", 0.5);
        crossfader.add(juce::var(c0));
    }
    {
        auto* c1 = new juce::DynamicObject();
        c1->setProperty("timeUs", durationUs);
        c1->setProperty("value", 0.5);
        crossfader.add(juce::var(c1));
    }

    auto* obj = new juce::DynamicObject();
    obj->setProperty("id", juce::String("sp-big"));
    obj->setProperty("name", juce::String("Big"));
    obj->setProperty("version", 1);
    obj->setProperty("durationUs", durationUs);
    obj->setProperty("cropStartUs", static_cast<juce::int64>(0));
    obj->setProperty("cropEndUs", durationUs);
    obj->setProperty("sourceOffsetTurns", 0.0);
    obj->setProperty("ownerDeck", 1);
    obj->setProperty("crossfaderCurve", juce::String("linear-v1"));
    obj->setProperty("platter", platter);
    obj->setProperty("crossfader", crossfader);

    silverdaw::ProjectState state;
    require(!state.addScratchPattern(juce::var(obj)),
            "pattern exceeding kMaxPatternPoints should be rejected");
    require(!state.hasScratchPattern("sp-big"), "over-limit pattern should not be stored");
}

void testScratchPatternSnapshotIsolatesCorruptEntry()
{
    // Inject a valid and a corrupt pattern directly into the ValueTree, bypassing
    // addScratchPattern validation. scratchPatternsAsJson must omit the corrupt
    // entry without poisoning the valid one.
    silverdaw::ProjectState state;

    auto tree = makeProjectTree();

    juce::ValueTree patternsNode(juce::Identifier{"SCRATCH_PATTERNS"});

    // Valid pattern node.
    juce::ValueTree validNode(juce::Identifier{"SCRATCH_PATTERN"});
    validNode.setProperty("id", "sp-valid", nullptr);
    validNode.setProperty("scratchPatternData",
                          scratch::serializePattern(scratch::parsePattern(makeValidPatternVar("sp-valid", "Valid")).value()),
                          nullptr);
    patternsNode.appendChild(validNode, nullptr);

    // Corrupt entry: wrong version (bypasses addScratchPattern guard).
    auto corruptVar = makeValidPatternVar("sp-corrupt", "Corrupt");
    corruptVar.getDynamicObject()->setProperty("version", 99);
    juce::ValueTree corruptNode(juce::Identifier{"SCRATCH_PATTERN"});
    corruptNode.setProperty("id", "sp-corrupt", nullptr);
    corruptNode.setProperty("scratchPatternData", corruptVar, nullptr);
    patternsNode.appendChild(corruptNode, nullptr);

    tree.appendChild(patternsNode, nullptr);
    state.replaceTree(tree);

    const auto json = state.scratchPatternsAsJson();
    const auto* arr = json.getArray();
    require(arr != nullptr, "result should be an array");
    require(arr->size() == 1, "only the valid pattern should survive revalidation");
    requireEqual((*arr)[0].getProperty("id", {}).toString(), "sp-valid",
                 "surviving pattern should be sp-valid");
}

void testScratchPatternSnapshotIsolatesNonObjectData()
{
    // Inject a pattern node whose data property is a string instead of an object.
    silverdaw::ProjectState state;

    auto tree = makeProjectTree();

    juce::ValueTree patternsNode(juce::Identifier{"SCRATCH_PATTERNS"});

    juce::ValueTree badDataNode(juce::Identifier{"SCRATCH_PATTERN"});
    badDataNode.setProperty("id", "sp-bad", nullptr);
    badDataNode.setProperty("scratchPatternData", juce::String("not-an-object"), nullptr);
    patternsNode.appendChild(badDataNode, nullptr);

    // Also a valid one to confirm isolation.
    juce::ValueTree validNode(juce::Identifier{"SCRATCH_PATTERN"});
    validNode.setProperty("id", "sp-ok", nullptr);
    validNode.setProperty("scratchPatternData",
                          scratch::serializePattern(scratch::parsePattern(makeValidPatternVar("sp-ok", "OK")).value()),
                          nullptr);
    patternsNode.appendChild(validNode, nullptr);

    tree.appendChild(patternsNode, nullptr);
    state.replaceTree(tree);

    const auto json = state.scratchPatternsAsJson();
    const auto* arr = json.getArray();
    require(arr != nullptr && arr->size() == 1, "only the valid pattern should be emitted");
    requireEqual((*arr)[0].getProperty("id", {}).toString(), "sp-ok",
                 "valid pattern should survive");
}

void testScratchPatternSnapshotIsolatesMissingLanes()
{
    // Pattern with empty platter lane — violates the schema constraint.
    silverdaw::ProjectState state;

    auto tree = makeProjectTree();

    juce::ValueTree patternsNode(juce::Identifier{"SCRATCH_PATTERNS"});

    auto emptyLaneVar = makeValidPatternVar("sp-empty-lane", "EmptyLane");
    emptyLaneVar.getDynamicObject()->setProperty("platter", juce::Array<juce::var>());
    juce::ValueTree badNode(juce::Identifier{"SCRATCH_PATTERN"});
    badNode.setProperty("id", "sp-empty-lane", nullptr);
    badNode.setProperty("scratchPatternData", emptyLaneVar, nullptr);
    patternsNode.appendChild(badNode, nullptr);

    tree.appendChild(patternsNode, nullptr);
    state.replaceTree(tree);

    const auto json = state.scratchPatternsAsJson();
    const auto* arr = json.getArray();
    require(arr != nullptr && arr->isEmpty(),
            "pattern with empty platter lane should be omitted");
}

void testScratchPatternSnapshotAllCorruptYieldsEmptyArray()
{
    // Every stored pattern is corrupt; result must be a valid empty array, not void/null.
    silverdaw::ProjectState state;

    auto tree = makeProjectTree();

    juce::ValueTree patternsNode(juce::Identifier{"SCRATCH_PATTERNS"});

    auto bad1 = makeValidPatternVar("sp-1", "Bad1");
    bad1.getDynamicObject()->setProperty("version", 2);
    juce::ValueTree node1(juce::Identifier{"SCRATCH_PATTERN"});
    node1.setProperty("id", "sp-1", nullptr);
    node1.setProperty("scratchPatternData", bad1, nullptr);
    patternsNode.appendChild(node1, nullptr);

    auto bad2 = makeValidPatternVar("sp-2", "Bad2");
    bad2.getDynamicObject()->removeProperty("id");
    juce::ValueTree node2(juce::Identifier{"SCRATCH_PATTERN"});
    node2.setProperty("id", "sp-2", nullptr);
    node2.setProperty("scratchPatternData", bad2, nullptr);
    patternsNode.appendChild(node2, nullptr);

    tree.appendChild(patternsNode, nullptr);
    state.replaceTree(tree);

    const auto json = state.scratchPatternsAsJson();
    const auto* arr = json.getArray();
    require(arr != nullptr && arr->isEmpty(),
            "all-corrupt tree should yield empty array, not null");
}

} // namespace

void addScratchPatternPersistenceTests(std::vector<TestCase>& tests)
{
    tests.push_back({"scratch pattern persistence add and retrieve", testScratchPatternAddAndRetrieve});
    tests.push_back({"scratch pattern persistence update", testScratchPatternUpdate});
    tests.push_back({"scratch pattern persistence delete", testScratchPatternDelete});
    tests.push_back({"scratch pattern persistence duplicate id idempotent update", testScratchPatternDuplicateIdIdempotentUpdate});
    tests.push_back({"scratch pattern persistence malformed input rejected", testScratchPatternMalformedInputRejected});
    tests.push_back({"scratch pattern persistence rename", testScratchPatternRename});
    tests.push_back({"scratch pattern persistence JSON roundtrip", testScratchPatternJsonRoundtrip});
    tests.push_back({"scratch pattern persistence older project has no patterns", testScratchPatternOlderProjectHasNoPatterns});
    tests.push_back({"scratch pattern persistence undo add", testScratchPatternUndoAdd});
    tests.push_back({"scratch pattern persistence undo delete", testScratchPatternUndoDelete});
    tests.push_back({"scratch pattern persistence snapshot includes patterns", testScratchPatternSnapshotIncludesPatterns});
    tests.push_back({"scratch pattern persistence max points enforced", testScratchPatternMaxPointsEnforced});
    tests.push_back({"scratch pattern snapshot isolates corrupt entry", testScratchPatternSnapshotIsolatesCorruptEntry});
    tests.push_back({"scratch pattern snapshot isolates non-object data", testScratchPatternSnapshotIsolatesNonObjectData});
    tests.push_back({"scratch pattern snapshot isolates missing lanes", testScratchPatternSnapshotIsolatesMissingLanes});
    tests.push_back({"scratch pattern snapshot all corrupt yields empty array", testScratchPatternSnapshotAllCorruptYieldsEmptyArray});
}

} // namespace silverdaw::tests
