// Bridge: AUTH token validation and the payload-helper guards that reject
// malformed wire values before they reach the engine.

#include "TestRegistry.h"

#include "AudioEngine.h"
#include "AudioConstants.h"
#include "BridgeAuth.h"
#include "EdgeFadeSnapshot.h"
#include "LoudnessAnalyzer.h"
#include "Leveler.h"
#include "MidiDeviceCommands.h"
#include "MixdownEngine.h"
#include "PayloadHelpers.h"
#include "PeaksCache.h"
#include "ProjectFile.h"
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

juce::var objectWithToken(const juce::String& token)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("token", token);
    return juce::var(obj);
}

juce::var makeBridgePayload(std::initializer_list<std::pair<const char*, juce::var>> fields)
{
    auto* obj = new juce::DynamicObject();
    for (const auto& f : fields)
    {
        obj->setProperty(juce::Identifier{f.first}, f.second);
    }
    return juce::var(obj);
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

// The optional readers are silent for absent fields (normal for fields like
// gestureId/clipId that only some envelope types carry) but must still reject —
// never coerce — present-but-wrong-typed values, matching the strict contract.
void testBridgeOptionalReadersRejectWrongType()
{
    using silverdaw::bridge::readOptionalBool;
    using silverdaw::bridge::readOptionalString;

    // Absent optional field — silently empty, not an error.
    {
        const auto v = makeBridgePayload({});
        require(!readOptionalString(v, "gestureId").has_value(),
                "absent optional string should yield nullopt");
        require(!readOptionalBool(v, "gestureEnd").has_value(),
                "absent optional bool should yield nullopt");
    }

    // Present, correctly typed — accepted.
    {
        const auto v = makeBridgePayload({{"gestureId", juce::var("g-1")},
                                          {"gestureEnd", juce::var(true)}});
        const auto s = readOptionalString(v, "gestureId");
        require(s.has_value() && *s == "g-1", "valid optional string should be accepted");
        require(readOptionalBool(v, "gestureEnd").value_or(false), "valid optional bool should be accepted");
    }

    // Present but wrong-typed — rejected (NOT coerced). A numeric clipId must not
    // become the string "5", and a string "true" must not become a boolean.
    {
        const auto v = makeBridgePayload({{"clipId", juce::var(5)},
                                          {"gestureEnd", juce::var("true")}});
        require(!readOptionalString(v, "clipId").has_value(),
                "numeric value should not be coerced into an optional string");
        require(!readOptionalBool(v, "gestureEnd").has_value(),
                "string value should not be coerced into an optional bool");
    }
}

// MIDI enumeration is host-dependent (a CI box may have zero devices), so the
// contract we can always assert is structural: an object with an `inputs` array
// of device objects. Contents are whatever the machine actually has.
void testMidiDevicesEnvelopeShape()
{
    const auto envelope = silverdaw::buildMidiDevicesListEnvelope();
    require(envelope.isObject(), "MIDI devices envelope should be an object");

    const auto inputs = envelope["inputs"];
    require(inputs.isArray(), "MIDI devices envelope should carry an inputs array");

    for (const auto& entry : *inputs.getArray())
    {
        require(entry.isObject(), "each MIDI input entry should be an object");
        require(entry["name"].isString(), "each MIDI input should have a name");
        require(entry["identifier"].isString(), "each MIDI input should have an identifier");
        require(entry["connected"].isBool(), "each MIDI input should report connection state");
        require(entry["enabled"].isBool(), "each MIDI input should report enabled state");
        require(entry.getDynamicObject()->hasProperty("controllerProfile"),
                "each MIDI input should include nullable controller mapping state");
        const auto controllerProfile = entry["controllerProfile"];
        require(controllerProfile.isVoid() || controllerProfile.isString(),
                "controller profile should be null or a display name");
        require(entry.getDynamicObject()->hasProperty("lastActivityMs"),
                "each MIDI input should include nullable activity state");
        const auto lastActivity = entry["lastActivityMs"];
        require(lastActivity.isVoid() || lastActivity.isDouble(),
                "MIDI input activity should be null or a millisecond timestamp");
    }
}

} // namespace

void addBridgeTests(std::vector<TestCase>& tests)
{
    tests.push_back({"Bridge auth token validation", testBridgeAuthTokenValidation});
    tests.push_back({"Bridge payload helpers reject malformed values", testBridgePayloadHelpersRejectMalformed});
    tests.push_back({"Bridge optional readers reject wrong types", testBridgeOptionalReadersRejectWrongType});
    tests.push_back({"Bridge MIDI devices envelope shape", testMidiDevicesEnvelopeShape});
}

} // namespace silverdaw::tests
