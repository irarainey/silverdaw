// Automation tests: the generic BreakpointCurve sampler (P0 foundation) plus the
// per-track automation engine added in later phases.

#include "TestRegistry.h"

#include "BreakpointCurve.h"
#include "ProjectState.h"

#include <cmath>
#include <cstddef>
#include <vector>

namespace silverdaw::tests
{
namespace
{

void testBreakpointCurveLinear()
{
    silverdaw::BreakpointCurve curve(silverdaw::InterpDomain::linear);
    curve.addPoint(0.0, -1.0F);
    curve.addPoint(1000.0, 1.0F);
    curve.finalise();

    require(!curve.isEmpty(), "two-point curve is not empty");

    std::size_t seg = 0;
    requireNear(curve.valueAtMs(-50.0, seg), -1.0, 1.0e-5, "before range clamps to first");
    requireNear(curve.valueAtMs(0.0, seg), -1.0, 1.0e-5, "start endpoint");
    requireNear(curve.valueAtMs(500.0, seg), 0.0, 1.0e-5, "midpoint linear");
    requireNear(curve.valueAtMs(1000.0, seg), 1.0, 1.0e-5, "end endpoint");
    requireNear(curve.valueAtMs(9999.0, seg), 1.0, 1.0e-5, "after range clamps to last");
}

void testBreakpointCurveBidirectionalCursorOnSeek()
{
    // Five segments so a backward jump must walk the cursor back several steps.
    silverdaw::BreakpointCurve curve(silverdaw::InterpDomain::linear);
    for (int i = 0; i <= 5; ++i)
        curve.addPoint(i * 100.0, static_cast<float>(i));
    curve.finalise();

    std::size_t seg = 0;
    // Play forward to the end, advancing the cursor.
    requireNear(curve.valueAtMs(450.0, seg), 4.5, 1.0e-5, "forward sample");
    // Seek back to the start: the bidirectional cursor must rewind and stay correct.
    requireNear(curve.valueAtMs(50.0, seg), 0.5, 1.0e-5, "seek-back sample");
    requireNear(curve.valueAtMs(250.0, seg), 2.5, 1.0e-5, "mid sample after rewind");
}

void testBreakpointCurveDecibelDomain()
{
    silverdaw::BreakpointCurve curve(silverdaw::InterpDomain::decibel);
    curve.addPoint(0.0, 1.0F);     // 0 dB
    curve.addPoint(1000.0, 0.25F); // -12 dB
    curve.finalise();

    std::size_t seg = 0;
    // dB interpolation is geometric: halfway between 1.0 and 0.25 is sqrt(0.25) = 0.5.
    requireNear(curve.valueAtMs(500.0, seg), 0.5, 1.0e-4, "decibel-domain midpoint");
}

void testBreakpointCurveDegenerate()
{
    silverdaw::BreakpointCurve empty;
    require(empty.isEmpty(), "empty curve reports empty");
    std::size_t seg = 0;
    requireNear(empty.valueAtMs(123.0, seg), 0.0, 1.0e-6, "empty curve samples 0");

    silverdaw::BreakpointCurve single;
    single.addPoint(0.0, 0.42F);
    single.finalise();
    require(single.isEmpty(), "single-point curve is treated as empty (no shape)");
    seg = 0;
    requireNear(single.valueAtMs(999.0, seg), 0.42, 1.0e-5, "single-point holds its value");
}

juce::var automationPoint(double timeMs, double value)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("timeMs", timeMs);
    obj->setProperty("value", value);
    return juce::var(obj);
}

void testProjectStateAutomationRoundTrip()
{
    silverdaw::ProjectState state;
    require(state.addTrack("t1"), "addTrack should succeed");

    juce::Array<juce::var> pts;
    pts.add(automationPoint(0.0, -1.0));
    pts.add(automationPoint(1000.0, 1.0));
    require(state.setTrackAutomation("t1", "filter", pts), "setTrackAutomation should store a lane");

    const auto stored = state.getTrackAutomation("t1", "filter");
    require(stored.size() == 2, "filter lane should round-trip two points");
    requireNear(static_cast<double>(stored.getReference(1).getProperty("value", 0.0)), 1.0, 1e-9,
                "stored value should be preserved");

    // Idempotent write is a no-op (no change).
    require(!state.setTrackAutomation("t1", "filter", pts), "identical write should report no change");

    // A second parameter coexists without dropping the first.
    juce::Array<juce::var> panPts;
    panPts.add(automationPoint(0.0, 0.0));
    panPts.add(automationPoint(500.0, 0.5));
    require(state.setTrackAutomation("t1", "pan", panPts), "second param lane should store");
    require(state.getTrackAutomationLanes("t1").size() == 2, "track should now have two lanes");
    require(state.getTrackAutomation("t1", "filter").size() == 2, "filter lane survives adding pan");

    // Fewer than two points clears just that lane.
    juce::Array<juce::var> onePt;
    onePt.add(automationPoint(0.0, 0.0));
    require(state.setTrackAutomation("t1", "filter", onePt), "single-point write clears the lane");
    require(state.getTrackAutomation("t1", "filter").isEmpty(), "filter lane should be cleared");
    require(state.getTrackAutomationLanes("t1").size() == 1, "only the pan lane should remain");
}

void testProjectStateAutomationRejectsDuplicateTimes()
{
    silverdaw::ProjectState state;
    require(state.addTrack("t1"), "addTrack should succeed");
    juce::Array<juce::var> pts;
    pts.add(automationPoint(100.0, 0.0));
    pts.add(automationPoint(100.0, 1.0)); // duplicate timeMs
    require(!state.setTrackAutomation("t1", "filter", pts), "duplicate-time points should be rejected");
}

void testTracksAsJsonCarriesAutomation()
{
    silverdaw::ProjectState state;
    require(state.addTrack("t1"), "addTrack should succeed");
    juce::Array<juce::var> pts;
    pts.add(automationPoint(0.0, -1.0));
    pts.add(automationPoint(2000.0, 1.0));
    require(state.setTrackAutomation("t1", "filter", pts), "setTrackAutomation should succeed");

    const auto tracks = state.tracksAsJson();
    auto* tracksArr = tracks.getArray();
    require(tracksArr != nullptr && tracksArr->size() == 1, "tracksAsJson should yield one track");
    auto* trackObj = (*tracksArr)[0].getDynamicObject();
    require(trackObj->hasProperty("automation"), "automated track must carry an automation array");
    auto* lanes = trackObj->getProperty("automation").getArray();
    require(lanes != nullptr && lanes->size() == 1, "one automation lane should serialise");
    auto* lane0 = (*lanes)[0].getDynamicObject();
    requireEqual(lane0->getProperty("paramId").toString(), juce::String("filter"),
                 "lane paramId should serialise");
    auto* lanePts = lane0->getProperty("points").getArray();
    require(lanePts != nullptr && lanePts->size() == 2, "lane should carry both breakpoints");
    requireNear(static_cast<double>((*lanePts)[1].getDynamicObject()->getProperty("value")), 1.0, 1e-9,
                "serialised automation must preserve the breakpoint value");
}

} // namespace

void addAutomationTests(std::vector<TestCase>& tests)
{
    tests.push_back({"BreakpointCurve linear interpolation with endpoint clamping", testBreakpointCurveLinear});
    tests.push_back({"BreakpointCurve cursor rewinds correctly on a backward seek", testBreakpointCurveBidirectionalCursorOnSeek});
    tests.push_back({"BreakpointCurve decibel domain interpolates linear gain in log space", testBreakpointCurveDecibelDomain});
    tests.push_back({"BreakpointCurve degenerate (empty / single-point) curves", testBreakpointCurveDegenerate});
    tests.push_back({"ProjectState track automation store/normalise/clear round-trip", testProjectStateAutomationRoundTrip});
    tests.push_back({"ProjectState track automation rejects duplicate breakpoint times", testProjectStateAutomationRejectsDuplicateTimes});
    tests.push_back({"tracksAsJson carries per-track automation into PROJECT_STATE", testTracksAsJsonCarriesAutomation});
}

} // namespace silverdaw::tests
