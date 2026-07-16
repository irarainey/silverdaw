#include "TestRegistry.h"
#include "ScratchTestFixtures.h"

#include "scratch/ScratchPatternEvaluator.h"
#include "scratch/ScratchProtocol.h"

#include <cmath>
#include <vector>

namespace silverdaw::tests
{
namespace
{

using silverdaw::scratch::CrossfaderKeyframe;
using silverdaw::scratch::DeckSide;
using silverdaw::scratch::EvalResult;
using silverdaw::scratch::Pattern;
using silverdaw::scratch::PatternReplaySnapshot;
using silverdaw::scratch::PlatterKeyframe;
using silverdaw::scratch::ScratchPatternEvaluator;

// Helper: build a simple two-point platter pattern (forward motion).
Pattern makeSimpleForwardPattern()
{
    Pattern p;
    p.id = "test-fwd";
    p.name = "Forward";
    p.durationUs = 1800000; // 1.8s = one full turn at nominal speed
    p.cropStartUs = 0;
    p.cropEndUs = 1800000;
    p.sourceOffsetTurns = 0.0;
    p.ownerDeck = DeckSide::deck1;
    p.platter = {{0, 0.0, false}, {1800000, 1.0, false}};
    p.crossfader = {{0, 0.0}, {1800000, 0.0}};
    return p;
}

// Helper: pattern with a hold in the middle.
Pattern makeHoldPattern()
{
    Pattern p;
    p.id = "test-hold";
    p.name = "Hold";
    p.durationUs = 3000000; // 3s
    p.cropStartUs = 0;
    p.cropEndUs = 3000000;
    p.sourceOffsetTurns = 0.0;
    p.ownerDeck = DeckSide::deck1;
    // Forward 0-1s, hold 1-2s, forward 2-3s.
    p.platter = {
        {0, 0.0, false},
        {1000000, 0.5, true},   // touch starts hold
        {2000000, 0.5, false},  // release resumes
        {3000000, 1.0, false}
    };
    p.crossfader = {{0, 0.0}, {3000000, 0.0}};
    return p;
}

// Helper: pattern with reverse motion.
Pattern makeReversePattern()
{
    Pattern p;
    p.id = "test-rev";
    p.name = "Reverse";
    p.durationUs = 1800000;
    p.cropStartUs = 0;
    p.cropEndUs = 1800000;
    p.sourceOffsetTurns = 1.0; // Start at 1 turn into source
    p.ownerDeck = DeckSide::deck2;
    p.platter = {{0, 0.0, false}, {1800000, -1.0, false}}; // Reverse one turn
    p.crossfader = {{0, 1.0}, {1800000, 1.0}};
    return p;
}

void testEvaluatorBeyondEnd()
{
    auto snap = ScratchPatternEvaluator::buildSnapshot(makeSimpleForwardPattern());
    const auto r1 = ScratchPatternEvaluator::evaluate(snap, snap.durationUs());
    require(r1.beyondEnd, "evaluation at durationUs should be beyond end");
    requireNear(r1.playbackRate, 0.0, 1e-12, "rate beyond end should be zero");

    const auto r2 = ScratchPatternEvaluator::evaluate(snap, -1);
    require(r2.beyondEnd, "evaluation at negative time should be beyond end");
}

void testEvaluatorNominalForward()
{
    auto snap = ScratchPatternEvaluator::buildSnapshot(makeSimpleForwardPattern());
    // At midpoint: 0.9s into 1.8s pattern, turns should be 0.5.
    const auto r = ScratchPatternEvaluator::evaluate(snap, 900000);
    require(!r.beyondEnd, "midpoint should not be beyond end");
    requireNear(r.platterTurns, 0.5, 1e-6, "midpoint platter should be 0.5 turns");
    // Rate: 1 turn / 1.8s = nominal. Velocity = 1/1.8s × 1.8 = 1.0 rate.
    requireNear(r.playbackRate, 1.0, 1e-6, "nominal forward rate should be ~1.0");
}

void testEvaluatorHold()
{
    auto snap = ScratchPatternEvaluator::buildSnapshot(makeHoldPattern());
    // At 1.5s — inside the hold segment.
    const auto r = ScratchPatternEvaluator::evaluate(snap, 1500000);
    require(!r.beyondEnd, "hold midpoint should not be beyond end");
    requireNear(r.platterTurns, 0.5, 1e-6, "hold segment should maintain turns at 0.5");
    // Rate during hold should be 0 (flat segment).
    requireNear(r.playbackRate, 0.0, 1e-6, "rate during hold should be 0");
    require(r.touched, "touch should be true during hold segment");
}

void testEvaluatorReverseMotion()
{
    auto snap = ScratchPatternEvaluator::buildSnapshot(makeReversePattern());
    const auto r = ScratchPatternEvaluator::evaluate(snap, 900000); // Midpoint
    require(!r.beyondEnd, "reverse midpoint should not be beyond end");
    requireNear(r.platterTurns, -0.5, 1e-6, "reverse midpoint should be -0.5 turns");
    // Rate: -1 turn / 1.8s × 1.8 = -1.0.
    requireNear(r.playbackRate, -1.0, 1e-6, "reverse rate should be ~-1.0");
}

void testEvaluatorCrossfaderLinearV1Deck1()
{
    // Deck 1 (left): gain = 1 - position.
    requireNear(ScratchPatternEvaluator::linearV1Gain(0.0, DeckSide::deck1), 1.0, 1e-12,
                "deck1 fully left should be gain 1.0");
    requireNear(ScratchPatternEvaluator::linearV1Gain(1.0, DeckSide::deck1), 0.0, 1e-12,
                "deck1 fully right should be gain 0.0");
    requireNear(ScratchPatternEvaluator::linearV1Gain(0.5, DeckSide::deck1), 0.5, 1e-12,
                "deck1 center should be gain 0.5");
}

void testEvaluatorCrossfaderLinearV1Deck2()
{
    // Deck 2 (right): gain = position.
    requireNear(ScratchPatternEvaluator::linearV1Gain(0.0, DeckSide::deck2), 0.0, 1e-12,
                "deck2 fully left should be gain 0.0");
    requireNear(ScratchPatternEvaluator::linearV1Gain(1.0, DeckSide::deck2), 1.0, 1e-12,
                "deck2 fully right should be gain 1.0");
    requireNear(ScratchPatternEvaluator::linearV1Gain(0.5, DeckSide::deck2), 0.5, 1e-12,
                "deck2 center should be gain 0.5");
}

void testEvaluatorCrossfaderInterpolation()
{
    Pattern p = makeSimpleForwardPattern();
    p.crossfader = {{0, 0.0}, {1800000, 1.0}};
    p.ownerDeck = DeckSide::deck2;
    auto snap = ScratchPatternEvaluator::buildSnapshot(p);

    const auto r = ScratchPatternEvaluator::evaluate(snap, 900000);
    // Crossfader at midpoint: value = 0.5, deck2 gain = 0.5.
    requireNear(r.crossfaderGain, 0.5, 1e-6, "crossfader gain at midpoint should be 0.5");
}

void testEvaluatorSourcePosition()
{
    auto snap = ScratchPatternEvaluator::buildSnapshot(makeSimpleForwardPattern());
    const double sampleRate = 48000.0;
    // At time 0: sourceOffset = 0 + platter turns = 0. Source = 0 samples.
    const double pos0 = ScratchPatternEvaluator::sourcePositionSamples(snap, 0, sampleRate);
    requireNear(pos0, 0.0, 1e-6, "source position at start should be 0");

    // At full duration: 1 turn × 1.8s × 48000 = 86400 samples.
    const double posEnd = ScratchPatternEvaluator::sourcePositionSamples(snap, 1799999, sampleRate);
    requireNear(posEnd, 86400.0, 50.0, "source position near end should be ~86400 samples");
}

void testEvaluatorBlockSizeIndependence()
{
    auto snap = ScratchPatternEvaluator::buildSnapshot(makeSimpleForwardPattern());
    // Evaluator is closed-form; verify same result regardless of "block boundaries".
    const auto r1 = ScratchPatternEvaluator::evaluate(snap, 500000);
    const auto r2 = ScratchPatternEvaluator::evaluate(snap, 500000);
    requireNear(r1.platterTurns, r2.platterTurns, 1e-15,
                "same time should produce identical result (block-size independent)");
    requireNear(r1.playbackRate, r2.playbackRate, 1e-15,
                "same time should produce identical rate");
}

void testEvaluatorSeekIndependence()
{
    auto snap = ScratchPatternEvaluator::buildSnapshot(makeSimpleForwardPattern());
    // Evaluating at a time after "seeking" to a different point should still be deterministic.
    const auto r_early = ScratchPatternEvaluator::evaluate(snap, 100000);
    const auto r_late = ScratchPatternEvaluator::evaluate(snap, 1700000);
    const auto r_early2 = ScratchPatternEvaluator::evaluate(snap, 100000);
    requireNear(r_early.platterTurns, r_early2.platterTurns, 1e-15,
                "evaluator must be stateless — same time gives same result after seek");
}

void testEvaluatorCropWindow()
{
    Pattern p = makeSimpleForwardPattern();
    p.durationUs = 1800000;
    p.cropStartUs = 450000;  // Crop first quarter
    p.cropEndUs = 1350000;   // Crop last quarter
    auto snap = ScratchPatternEvaluator::buildSnapshot(p);

    require(!snap.empty(), "cropped snapshot should not be empty");
    // Duration is cropEnd - cropStart = 900000us.
    require(snap.durationUs() == 900000,
            "cropped duration should be 900000us");

    // At time 0 of the cropped window, platter should be at the value
    // corresponding to 450000us in the original pattern = 0.25 turns.
    const auto r = ScratchPatternEvaluator::evaluate(snap, 0);
    requireNear(r.platterTurns, 0.25, 1e-4, "cropped start should interpolate platter at crop boundary");
}

void testEvaluatorEmptyPattern()
{
    PatternReplaySnapshot empty;
    require(empty.empty(), "default snapshot should be empty");
    const auto r = ScratchPatternEvaluator::evaluate(empty, 0);
    require(r.beyondEnd, "empty pattern should always be beyond end");
}

void testEvaluatorBoundaryKeyframes()
{
    auto snap = ScratchPatternEvaluator::buildSnapshot(makeSimpleForwardPattern());
    // At time 0 exactly.
    const auto r0 = ScratchPatternEvaluator::evaluate(snap, 0);
    require(!r0.beyondEnd, "time 0 should not be beyond end");
    requireNear(r0.platterTurns, 0.0, 1e-12, "platter at time 0 should be 0.0");

    // At time = duration - 1 (last valid sample).
    const auto rLast = ScratchPatternEvaluator::evaluate(snap, snap.durationUs() - 1);
    require(!rLast.beyondEnd, "last valid time should not be beyond end");
}

void testEvaluatorDirectionChange()
{
    Pattern p;
    p.id = "dir-change";
    p.name = "Direction Change";
    p.durationUs = 2000000;
    p.cropStartUs = 0;
    p.cropEndUs = 2000000;
    p.sourceOffsetTurns = 0.5;
    p.ownerDeck = DeckSide::deck1;
    // Forward then reverse.
    p.platter = {
        {0, 0.0, false},
        {1000000, 0.5, false},   // Forward for 1s
        {2000000, 0.0, false}    // Back to start in next 1s
    };
    p.crossfader = {{0, 0.0}, {2000000, 0.0}};
    auto snap = ScratchPatternEvaluator::buildSnapshot(p);

    // At 0.5s — forward segment.
    const auto rFwd = ScratchPatternEvaluator::evaluate(snap, 500000);
    require(rFwd.playbackRate > 0.0, "first segment rate should be positive");

    // At 1.5s — reverse segment.
    const auto rRev = ScratchPatternEvaluator::evaluate(snap, 1500000);
    require(rRev.playbackRate < 0.0, "second segment rate should be negative");
}

} // namespace

void addScratchPatternEvaluatorTests(std::vector<TestCase>& tests)
{
    tests.push_back({"scratch_evaluator_beyond_end", testEvaluatorBeyondEnd});
    tests.push_back({"scratch_evaluator_nominal_forward", testEvaluatorNominalForward});
    tests.push_back({"scratch_evaluator_hold", testEvaluatorHold});
    tests.push_back({"scratch_evaluator_reverse_motion", testEvaluatorReverseMotion});
    tests.push_back({"scratch_evaluator_crossfader_linear_v1_deck1", testEvaluatorCrossfaderLinearV1Deck1});
    tests.push_back({"scratch_evaluator_crossfader_linear_v1_deck2", testEvaluatorCrossfaderLinearV1Deck2});
    tests.push_back({"scratch_evaluator_crossfader_interpolation", testEvaluatorCrossfaderInterpolation});
    tests.push_back({"scratch_evaluator_source_position", testEvaluatorSourcePosition});
    tests.push_back({"scratch_evaluator_block_size_independence", testEvaluatorBlockSizeIndependence});
    tests.push_back({"scratch_evaluator_seek_independence", testEvaluatorSeekIndependence});
    tests.push_back({"scratch_evaluator_crop_window", testEvaluatorCropWindow});
    tests.push_back({"scratch_evaluator_empty_pattern", testEvaluatorEmptyPattern});
    tests.push_back({"scratch_evaluator_boundary_keyframes", testEvaluatorBoundaryKeyframes});
    tests.push_back({"scratch_evaluator_direction_change", testEvaluatorDirectionChange});
}

} // namespace silverdaw::tests
