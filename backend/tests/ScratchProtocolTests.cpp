#include "ScratchTestFixtures.h"
#include "TestRegistry.h"

#include "scratch/ScratchProtocol.h"

#include <juce_core/juce_core.h>

namespace silverdaw::tests
{
namespace
{

void testScratchProtocolVersionValidation()
{
    // Valid: exact match.
    require(scratch::hasValidProtocolVersion(parseJson(R"json({"protocolVersion":1})json")),
            "protocolVersion 1 should be valid");

    // Wrong version number.
    require(!scratch::hasValidProtocolVersion(parseJson(R"json({"protocolVersion":2})json")),
            "protocolVersion 2 should be rejected");
    require(!scratch::hasValidProtocolVersion(parseJson(R"json({"protocolVersion":0})json")),
            "protocolVersion 0 should be rejected");

    // Missing entirely.
    require(!scratch::hasValidProtocolVersion(parseJson(R"json({})json")),
            "missing protocolVersion should be rejected");

    // Non-numeric types.
    require(!scratch::hasValidProtocolVersion(parseJson(R"json({"protocolVersion":"1"})json")),
            "string protocolVersion should be rejected");
    require(!scratch::hasValidProtocolVersion(parseJson(R"json({"protocolVersion":null})json")),
            "null protocolVersion should be rejected");
    require(!scratch::hasValidProtocolVersion(parseJson(R"json({"protocolVersion":true})json")),
            "boolean protocolVersion should be rejected");

    // Numeric but non-integer (fractional).
    require(!scratch::hasValidProtocolVersion(parseJson(R"json({"protocolVersion":1.5})json")),
            "fractional protocolVersion should be rejected");
}

void testScratchSessionPayloads()
{
    const auto open = scratch::parseSessionOpenPayload(parseJson(
        R"json({"protocolVersion":1,"clipId":"clip-1"})json"));
    require(open.has_value() && open->clipId == "clip-1", "valid scratch open payload should parse");

    const auto openLibrary = scratch::parseSessionOpenPayload(parseJson(
        R"json({"protocolVersion":1,"libraryItemId":"lib-1"})json"));
    require(openLibrary.has_value() && openLibrary->libraryItemId == "lib-1"
                && openLibrary->clipId.isEmpty(),
            "library-sourced scratch open payload should parse");

    require(!scratch::parseSessionOpenPayload(parseJson(
                 R"json({"protocolVersion":1})json"))
                 .has_value(),
            "scratch open without an identity should reject");

    require(!scratch::parseSessionOpenPayload(parseJson(
                 R"json({"protocolVersion":1,"clipId":"clip-1","libraryItemId":"lib-1"})json"))
                 .has_value(),
            "scratch open with both identities should reject");

    require(!scratch::parseSessionOpenPayload(parseJson(
                 R"json({"protocolVersion":2,"clipId":"clip-1"})json"))
                 .has_value(),
            "unsupported scratch protocol version should reject");

    const auto move = scratch::parseSessionControlPayload(parseJson(
        R"json({"protocolVersion":1,"sessionId":"session-1","action":"platterMove","deck":2,"deltaTurns":-0.125})json"));
    require(move.has_value(), "valid platter move should parse");
    require(move->action == scratch::ControlAction::platterMove, "platter action should be retained");
    require(move->deck == scratch::DeckSide::deck2, "platter deck should be retained");
    requireNear(move->deltaTurns, -0.125, 1.0e-12, "platter delta should be retained");

    require(!scratch::parseSessionControlPayload(parseJson(
                 R"json({"protocolVersion":1,"sessionId":"session-1","action":"crossfader","value":1.1})json"))
                 .has_value(),
            "out-of-range crossfader should reject");

    const auto backingGain = scratch::parseSessionControlPayload(parseJson(
        R"json({"protocolVersion":1,"sessionId":"session-1","action":"backingGain","value":0.5})json"));
    require(backingGain.has_value(), "valid backing gain should parse");
    require(backingGain->action == scratch::ControlAction::backingGain,
            "backing gain action should be retained");
    requireNear(backingGain->gain, 0.5, 1.0e-12, "backing gain value should be retained");

    const auto scratchGain = scratch::parseSessionControlPayload(parseJson(
        R"json({"protocolVersion":1,"sessionId":"session-1","action":"scratchGain","value":0.25})json"));
    require(scratchGain.has_value(), "valid scratch gain should parse");
    require(scratchGain->action == scratch::ControlAction::scratchGain,
            "scratch gain action should be retained");
    requireNear(scratchGain->gain, 0.25, 1.0e-12, "scratch gain value should be retained");

    require(!scratch::parseSessionControlPayload(parseJson(
                 R"json({"protocolVersion":1,"sessionId":"session-1","action":"scratchGain","value":1.5})json"))
                 .has_value(),
            "out-of-range scratch gain should reject");
    require(!scratch::parseSessionControlPayload(parseJson(
                 R"json({"protocolVersion":1,"sessionId":"session-1","action":"platterTouch","deck":3,"touched":true})json"))
                 .has_value(),
            "unknown deck should reject");
    require(!scratch::parseSessionControlPayload(parseJson(
                 R"json({"protocolVersion":1,"sessionId":"session-1","action":"platterMove","deck":1,"deltaTurns":9.0})json"))
                 .has_value(),
            "unsafe platter delta should reject");
}

void testScratchPatternPayload()
{
    const auto valid = parseJson(R"json({
        "id":"scratch-1",
        "name":"First take",
        "version":1,
        "durationUs":2000000,
        "cropStartUs":100000,
        "cropEndUs":1900000,
        "sourceOffsetTurns":0.25,
        "ownerDeck":1,
        "crossfaderCurve":"linear-v1",
        "platter":[
            {"timeUs":0,"turns":0.0,"touched":true},
            {"timeUs":1000000,"turns":-0.5,"touched":true},
            {"timeUs":2000000,"turns":-0.3,"touched":false}
        ],
        "crossfader":[
            {"timeUs":0,"value":1.0},
            {"timeUs":1000000,"value":0.4},
            {"timeUs":2000000,"value":0.6}
        ],
        "provenance":{"sourceClipId":"clip-1","sourceLibraryItemId":"library-1"}
    })json");
    const auto pattern = scratch::parsePattern(valid);
    require(pattern.has_value(), "valid scratch pattern should parse");
    require(pattern->platter.size() == 3, "platter keyframes should be retained");
    require(pattern->crossfader.size() == 3, "crossfader keyframes should be retained");
    require(pattern->provenance.has_value(), "pattern provenance should be retained");

    valid.getDynamicObject()->setProperty("version", 2);
    require(!scratch::parsePattern(valid).has_value(), "unsupported pattern version should reject");
}

void testScratchPatternOrderingAndBounds()
{
    const auto invalidOrder = parseJson(R"json({
        "id":"scratch-1",
        "name":"First take",
        "version":1,
        "durationUs":2000000,
        "cropStartUs":0,
        "cropEndUs":2000000,
        "sourceOffsetTurns":0.0,
        "ownerDeck":1,
        "crossfaderCurve":"linear-v1",
        "platter":[
            {"timeUs":1000000,"turns":0.0,"touched":true},
            {"timeUs":500000,"turns":0.1,"touched":true}
        ],
        "crossfader":[
            {"timeUs":0,"value":0.5},
            {"timeUs":2000000,"value":0.5}
        ]
    })json");
    require(!scratch::parsePattern(invalidOrder).has_value(), "unordered pattern keyframes should reject");

    invalidOrder.getDynamicObject()
        ->getProperty("platter")
        .getArray()
        ->getReference(1)
        .getDynamicObject()
        ->setProperty("timeUs", 1000000);
    require(!scratch::parsePattern(invalidOrder).has_value(), "duplicate pattern timestamps should reject");

    const auto invalidCrop = parseJson(R"json({
        "id":"scratch-1",
        "name":"First take",
        "version":1,
        "durationUs":2000000,
        "cropStartUs":1500000,
        "cropEndUs":1000000,
        "sourceOffsetTurns":0.0,
        "ownerDeck":1,
        "crossfaderCurve":"linear-v1",
        "platter":[
            {"timeUs":0,"turns":0.0,"touched":false},
            {"timeUs":2000000,"turns":0.0,"touched":false}
        ],
        "crossfader":[
            {"timeUs":0,"value":0.5},
            {"timeUs":2000000,"value":0.5}
        ]
    })json");
    require(!scratch::parsePattern(invalidCrop).has_value(), "inverted pattern crop should reject");

    invalidCrop.getDynamicObject()->setProperty("cropStartUs", 0);
    invalidCrop.getDynamicObject()->setProperty("cropEndUs", 2000000);
    invalidCrop.getDynamicObject()->setProperty("sourceOffsetTurns", 1000001.0);
    require(!scratch::parsePattern(invalidCrop).has_value(), "unsafe source turn offset should reject");

    // Empty lanes must be rejected
    const auto emptyLanes = parseJson(R"json({
        "id":"scratch-1",
        "name":"First take",
        "version":1,
        "durationUs":2000000,
        "cropStartUs":0,
        "cropEndUs":2000000,
        "sourceOffsetTurns":0.0,
        "ownerDeck":1,
        "crossfaderCurve":"linear-v1",
        "platter":[],
        "crossfader":[]
    })json");
    require(!scratch::parsePattern(emptyLanes).has_value(), "empty pattern lanes should reject");

    // First timestamp must be 0
    const auto badFirst = parseJson(R"json({
        "id":"scratch-1",
        "name":"First take",
        "version":1,
        "durationUs":2000000,
        "cropStartUs":0,
        "cropEndUs":2000000,
        "sourceOffsetTurns":0.0,
        "ownerDeck":1,
        "crossfaderCurve":"linear-v1",
        "platter":[
            {"timeUs":100,"turns":0.0,"touched":false},
            {"timeUs":2000000,"turns":0.0,"touched":false}
        ],
        "crossfader":[
            {"timeUs":0,"value":0.5},
            {"timeUs":2000000,"value":0.5}
        ]
    })json");
    require(!scratch::parsePattern(badFirst).has_value(), "platter lane not starting at 0 should reject");

    // Last timestamp must be durationUs
    const auto badLast = parseJson(R"json({
        "id":"scratch-1",
        "name":"First take",
        "version":1,
        "durationUs":2000000,
        "cropStartUs":0,
        "cropEndUs":2000000,
        "sourceOffsetTurns":0.0,
        "ownerDeck":1,
        "crossfaderCurve":"linear-v1",
        "platter":[
            {"timeUs":0,"turns":0.0,"touched":false},
            {"timeUs":1500000,"turns":0.0,"touched":false}
        ],
        "crossfader":[
            {"timeUs":0,"value":0.5},
            {"timeUs":2000000,"value":0.5}
        ]
    })json");
    require(!scratch::parsePattern(badLast).has_value(), "platter lane not ending at durationUs should reject");
}

void testScratchBackingPayloads()
{
    // Valid prepare payload.
    const auto ok = scratch::parseBackingPreparePayload(parseJson(R"json({
        "protocolVersion":1,
        "sessionId":"sess-1",
        "trackIds":["t1","t2"],
        "startAnchor":"playhead",
        "durationSec":60
    })json"));
    require(ok.has_value(), "well-formed backing prepare payload should parse");
    require(ok->sessionId == "sess-1", "backing prepare should carry the session id");
    require(ok->trackIds.size() == 2, "backing prepare should carry both track ids");
    require(ok->startAnchor == "playhead", "backing prepare should carry the start anchor");
    require(ok->durationSec == 60, "backing prepare should carry the duration");

    // Newly supported maximum duration.
    require(scratch::parseBackingPreparePayload(parseJson(R"json({
        "protocolVersion":1,"sessionId":"s","trackIds":["t1"],"startAnchor":"arrangement","durationSec":120
    })json")).has_value(), "backing prepare with a 120s duration should parse");

    // Wrong protocol version.
    require(!scratch::parseBackingPreparePayload(parseJson(R"json({
        "protocolVersion":2,"sessionId":"s","trackIds":["t1"],"startAnchor":"arrangement","durationSec":60
    })json")).has_value(), "backing prepare with wrong protocol version should reject");

    // Invalid start anchor.
    require(!scratch::parseBackingPreparePayload(parseJson(R"json({
        "protocolVersion":1,"sessionId":"s","trackIds":["t1"],"startAnchor":"middle","durationSec":60
    })json")).has_value(), "backing prepare with unknown start anchor should reject");

    // Invalid duration.
    require(!scratch::parseBackingPreparePayload(parseJson(R"json({
        "protocolVersion":1,"sessionId":"s","trackIds":["t1"],"startAnchor":"arrangement","durationSec":45
    })json")).has_value(), "backing prepare with unsupported duration should reject");

    // Empty track id in the array.
    require(!scratch::parseBackingPreparePayload(parseJson(R"json({
        "protocolVersion":1,"sessionId":"s","trackIds":[""],"startAnchor":"arrangement","durationSec":60
    })json")).has_value(), "backing prepare with an empty track id should reject");

    // Missing session id.
    require(!scratch::parseBackingPreparePayload(parseJson(R"json({
        "protocolVersion":1,"trackIds":["t1"],"startAnchor":"arrangement","durationSec":60
    })json")).has_value(), "backing prepare without a session id should reject");

    // Valid clear payload.
    const auto clear = scratch::parseBackingClearPayload(parseJson(R"json({
        "protocolVersion":1,"sessionId":"sess-1"
    })json"));
    require(clear.has_value(), "well-formed backing clear payload should parse");
    require(clear->sessionId == "sess-1", "backing clear should carry the session id");

    // Clear with wrong protocol version.
    require(!scratch::parseBackingClearPayload(parseJson(R"json({
        "protocolVersion":9,"sessionId":"s"
    })json")).has_value(), "backing clear with wrong protocol version should reject");
}

} // namespace

void addScratchProtocolTests(std::vector<TestCase>& tests)
{
    tests.push_back({"scratch protocol version validation", testScratchProtocolVersionValidation});
    tests.push_back({"scratch protocol parses session payloads", testScratchSessionPayloads});
    tests.push_back({"scratch protocol parses pattern payloads", testScratchPatternPayload});
    tests.push_back({"scratch protocol rejects invalid pattern bounds", testScratchPatternOrderingAndBounds});
    tests.push_back({"scratch protocol parses backing payloads", testScratchBackingPayloads});
}

} // namespace silverdaw::tests
