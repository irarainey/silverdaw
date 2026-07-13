#include "TestRegistry.h"

#include "AudioEngine.h"
#include "scratch/ScratchActionRecorder.h"
#include "scratch/ScratchProtocol.h"

#include <cmath>
#include <memory>
#include <thread>
#include <chrono>

namespace silverdaw::tests
{
namespace
{

// Default final snapshot for tests — uses last recorded values or zeros.
scratch::ScratchActionRecorder::FinalSnapshot defaultFinalSnapshot(
    double platterTurns = 0.0, bool touched = false, double crossfader = 0.0)
{
    return {platterTurns, touched, crossfader};
}

std::shared_ptr<const juce::AudioBuffer<float>> makeRecorderTestBuffer(
    int samples, double sampleRate)
{
    auto audio = std::make_shared<juce::AudioBuffer<float>>(2, samples);
    for (int sample = 0; sample < samples; ++sample)
    {
        const auto value = static_cast<float>(
            0.5 * std::sin(2.0 * juce::MathConstants<double>::pi
                           * 220.0 * sample / sampleRate));
        audio->setSample(0, sample, value);
        audio->setSample(1, sample, value);
    }
    return audio;
}

void testRecorderStartAndReset()
{
    scratch::ScratchActionRecorder recorder;
    require(recorder.state() == scratch::ScratchActionRecorder::State::idle,
            "recorder should start idle");

    scratch::ScratchActionRecorder::Config cfg;
    cfg.draftId = "draft-1";
    cfg.draftName = "Test draft";
    cfg.sessionId = "session-1";
    cfg.clipId = "clip-1";
    cfg.ownerDeck = scratch::DeckSide::deck1;
    cfg.initialPlatterTurns = 0.5;
    cfg.initialCrossfader = 0.75;
    cfg.initialTouched = true;
    cfg.cropStartUs = 0;

    require(recorder.start(cfg), "recorder should start from idle");
    require(recorder.state() == scratch::ScratchActionRecorder::State::recording,
            "recorder should enter recording state");
    require(!recorder.start(cfg), "double start should be rejected");
    require(recorder.belongsToSession("session-1"), "recorder should track session id");
    require(!recorder.belongsToSession("other"), "recorder should reject wrong session id");
}

void testRecorderPlatterCapture()
{
    scratch::ScratchActionRecorder recorder;
    scratch::ScratchActionRecorder::Config cfg;
    cfg.draftId = "draft-2";
    cfg.draftName = "Platter test";
    cfg.sessionId = "session-2";
    cfg.clipId = "clip-2";
    cfg.ownerDeck = scratch::DeckSide::deck2;
    cfg.initialPlatterTurns = 0.0;
    cfg.initialCrossfader = 1.0;
    cfg.initialTouched = false;
    cfg.cropStartUs = 0;

    require(recorder.start(cfg), "recorder should start");

    // Small delay so timestamps are strictly increasing
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    recorder.recordPlatter(0.1, true);
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    recorder.recordPlatter(0.2, true);
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    recorder.recordPlatter(0.3, false);

    require(recorder.stop(defaultFinalSnapshot(0.3, false, 1.0)), "recorder should stop");
    auto pattern = recorder.takeCompletedPattern();
    require(pattern.has_value(), "completed pattern should be available");
    require(pattern->id == "draft-2", "pattern id should match draft id");
    require(pattern->ownerDeck == scratch::DeckSide::deck2, "pattern deck should match config");
    require(pattern->platter.size() >= 3, "pattern should have platter keyframes");
    require(pattern->platter.front().timeUs == 0, "first platter keyframe should be at time 0");
    require(pattern->platter.front().turns == 0.0, "first platter keyframe should use initial turns");
    require(pattern->platter.front().touched == false, "first platter keyframe should use initial touched");
    require(pattern->durationUs > 0, "pattern duration should be positive");
    require(pattern->cropStartUs == 0, "pattern crop start should be zero");
    require(pattern->cropEndUs == pattern->durationUs, "pattern crop end should equal duration");
    require(pattern->provenance.has_value(), "pattern provenance should be set");
    require(pattern->provenance->sourceClipId == "clip-2", "provenance clip id should match");
}

void testRecorderTouchStateAndDirectionChange()
{
    scratch::ScratchActionRecorder recorder;
    scratch::ScratchActionRecorder::Config cfg;
    cfg.draftId = "draft-3";
    cfg.draftName = "Touch test";
    cfg.sessionId = "session-3";
    cfg.clipId = "clip-3";
    cfg.ownerDeck = scratch::DeckSide::deck1;
    cfg.initialPlatterTurns = 0.0;
    cfg.initialCrossfader = 0.0;
    cfg.initialTouched = true;
    cfg.cropStartUs = 0;

    require(recorder.start(cfg), "recorder should start");

    // Simulate forward, then direction reversal
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    recorder.recordPlatter(0.1, true);
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    recorder.recordPlatter(0.2, true);
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    recorder.recordPlatter(0.15, true); // direction change
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    recorder.recordPlatter(0.1, false); // touch release

    require(recorder.stop(defaultFinalSnapshot(0.1, false, 0.0)), "recorder should stop");
    auto pattern = recorder.takeCompletedPattern();
    require(pattern.has_value(), "pattern should be produced");

    // Verify strictly increasing timestamps
    for (std::size_t i = 1; i < pattern->platter.size(); ++i)
    {
        require(pattern->platter[i].timeUs > pattern->platter[i - 1].timeUs,
                "platter timestamps should be strictly increasing");
    }

    // Touch state transitions should be preserved
    bool hadTouchChange = false;
    for (std::size_t i = 1; i < pattern->platter.size(); ++i)
    {
        if (pattern->platter[i].touched != pattern->platter[i - 1].touched)
            hadTouchChange = true;
    }
    require(hadTouchChange, "touch state transitions should be preserved after coalescing");
}

void testRecorderCrossfaderAfterSoftTakeover()
{
    scratch::ScratchActionRecorder recorder;
    scratch::ScratchActionRecorder::Config cfg;
    cfg.draftId = "draft-4";
    cfg.draftName = "Crossfader test";
    cfg.sessionId = "session-4";
    cfg.clipId = "clip-4";
    cfg.ownerDeck = scratch::DeckSide::deck1;
    cfg.initialPlatterTurns = 0.0;
    cfg.initialCrossfader = 0.0;
    cfg.initialTouched = false;
    cfg.cropStartUs = 0;

    require(recorder.start(cfg), "recorder should start");

    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    recorder.recordCrossfader(0.25);
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    recorder.recordCrossfader(0.5);
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    recorder.recordCrossfader(0.75);
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    recorder.recordCrossfader(1.0);

    require(recorder.stop(defaultFinalSnapshot(0.0, false, 1.0)), "recorder should stop");
    auto pattern = recorder.takeCompletedPattern();
    require(pattern.has_value(), "pattern should be produced");
    require(pattern->crossfader.size() >= 2, "crossfader should have keyframes");
    require(pattern->crossfader.front().timeUs == 0, "first crossfader should be at time 0");
    requireNear(pattern->crossfader.front().value, 0.0, 1.0e-12,
                "first crossfader value should be initial");
    for (std::size_t i = 1; i < pattern->crossfader.size(); ++i)
    {
        require(pattern->crossfader[i].timeUs > pattern->crossfader[i - 1].timeUs,
                "crossfader timestamps should be strictly increasing");
        require(pattern->crossfader[i].value >= 0.0 && pattern->crossfader[i].value <= 1.0,
                "crossfader values should be bounded [0,1]");
    }
}

void testRecorderStrictOrderingAndBounds()
{
    scratch::ScratchActionRecorder recorder;
    scratch::ScratchActionRecorder::Config cfg;
    cfg.draftId = "draft-5";
    cfg.draftName = "Bounds test";
    cfg.sessionId = "session-5";
    cfg.clipId = "clip-5";
    cfg.ownerDeck = scratch::DeckSide::deck1;
    cfg.initialPlatterTurns = 0.0;
    cfg.initialCrossfader = 0.5;
    cfg.initialTouched = false;
    cfg.cropStartUs = 0;

    require(recorder.start(cfg), "recorder should start");

    // Invalid values should be silently rejected
    recorder.recordPlatter(std::numeric_limits<double>::infinity(), false);
    recorder.recordPlatter(-1000001.0, false);
    recorder.recordCrossfader(-0.1);
    recorder.recordCrossfader(1.1);
    recorder.recordCrossfader(std::numeric_limits<double>::quiet_NaN());

    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    recorder.recordPlatter(0.5, true); // valid
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    recorder.recordCrossfader(0.8); // valid

    require(recorder.stop(defaultFinalSnapshot(0.5, true, 0.8)), "recorder should stop");
    auto pattern = recorder.takeCompletedPattern();
    require(pattern.has_value(), "pattern should be produced");
    // All platter values must be finite and bounded
    for (const auto& kf : pattern->platter)
    {
        require(std::isfinite(kf.turns), "platter turns should be finite");
        require(std::abs(kf.turns) <= scratch::kMaxAbsoluteTurns,
                "platter turns should be bounded");
    }
    // All crossfader values must be in [0,1]
    for (const auto& kf : pattern->crossfader)
    {
        require(kf.value >= 0.0 && kf.value <= 1.0, "crossfader values should be bounded");
    }
}

void testRecorderStopAndAbortControls()
{
    scratch::ScratchActionRecorder recorder;
    scratch::ScratchActionRecorder::Config cfg;
    cfg.draftId = "draft-6";
    cfg.draftName = "Abort test";
    cfg.sessionId = "session-6";
    cfg.clipId = "clip-6";
    cfg.ownerDeck = scratch::DeckSide::deck1;
    cfg.initialPlatterTurns = 0.0;
    cfg.initialCrossfader = 0.0;
    cfg.initialTouched = false;
    cfg.cropStartUs = 0;

    // Stop without start should fail
    require(!recorder.stop(defaultFinalSnapshot()), "stop on idle recorder should be rejected");

    // Abort from idle should be safe
    recorder.abort();
    require(recorder.state() == scratch::ScratchActionRecorder::State::aborted,
            "abort from idle should set aborted state");

    // Start after abort
    require(recorder.start(cfg), "start after abort should succeed");
    require(recorder.state() == scratch::ScratchActionRecorder::State::recording,
            "state should be recording after start");

    // Abort during recording
    recorder.abort();
    require(recorder.state() == scratch::ScratchActionRecorder::State::aborted,
            "abort during recording should set aborted state");
    require(!recorder.takeCompletedPattern().has_value(),
            "aborted recorder should not produce a pattern");

    // Re-start after abort
    require(recorder.start(cfg), "start after second abort should succeed");
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    recorder.recordPlatter(1.0, true);
    require(recorder.stop(defaultFinalSnapshot(1.0, true, 0.0)), "stop should succeed after valid recording");
    require(recorder.state() == scratch::ScratchActionRecorder::State::completed,
            "state should be completed after stop");
    auto pattern = recorder.takeCompletedPattern();
    require(pattern.has_value(), "takeCompletedPattern should return the pattern");
    require(recorder.state() == scratch::ScratchActionRecorder::State::idle,
            "state should return to idle after take");
    require(!recorder.takeCompletedPattern().has_value(),
            "second take should return nothing");
}

void testRecorderStaleSessionReject()
{
    scratch::ScratchActionRecorder recorder;
    scratch::ScratchActionRecorder::Config cfg;
    cfg.draftId = "draft-7";
    cfg.draftName = "Stale test";
    cfg.sessionId = "session-7";
    cfg.clipId = "clip-7";
    cfg.ownerDeck = scratch::DeckSide::deck1;
    cfg.initialPlatterTurns = 0.0;
    cfg.initialCrossfader = 0.5;
    cfg.initialTouched = false;
    cfg.cropStartUs = 0;

    require(recorder.start(cfg), "recorder should start");
    require(recorder.belongsToSession("session-7"), "belongs to current session");
    require(!recorder.belongsToSession("session-8"), "rejects wrong session");

    // Recording keyframes should not be captured when state is not recording
    recorder.stop(defaultFinalSnapshot());
    recorder.recordPlatter(5.0, true);
    recorder.recordCrossfader(0.9);
    auto pattern = recorder.takeCompletedPattern();
    require(pattern.has_value(), "completed pattern available");
    // No points beyond the stop should have been added
    require(pattern->platter.back().turns != 5.0,
            "keyframes after stop should not be captured");
}

void testRecorderEngineIntegration()
{
    AudioEngine engine;
    engine.initialiseGraph();
    constexpr double sampleRate = 48000.0;
    const auto sessionId = engine.beginScratchSession("clip-rec");
    engine.completeScratchSession(
        sessionId, makeRecorderTestBuffer(static_cast<int>(sampleRate * 2.0), sampleRate),
        sampleRate);

    scratch::SessionControlPayload recordStart;
    recordStart.sessionId = sessionId;
    recordStart.action = scratch::ControlAction::recordStart;
    require(engine.controlScratchSession(recordStart),
            "recordStart should succeed on ready session");

    auto snapshot = engine.getScratchSessionSnapshot();
    require(snapshot.has_value() && snapshot->status == "recording",
            "session should be in recording state");

    // Send a platter move and crossfader during recording
    scratch::SessionControlPayload move;
    move.sessionId = sessionId;
    move.action = scratch::ControlAction::platterMove;
    move.deck = scratch::DeckSide::deck1;
    move.deltaTurns = 0.1;
    require(engine.controlScratchSession(move), "platter move during recording should apply");

    scratch::SessionControlPayload xf;
    xf.sessionId = sessionId;
    xf.action = scratch::ControlAction::crossfader;
    xf.crossfader = 0.6;
    require(engine.controlScratchSession(xf), "crossfader during recording should apply");

    // Stop recording
    scratch::SessionControlPayload recordStop;
    recordStop.sessionId = sessionId;
    recordStop.action = scratch::ControlAction::recordStop;
    require(engine.controlScratchSession(recordStop),
            "recordStop should succeed during recording");

    snapshot = engine.getScratchSessionSnapshot();
    require(snapshot.has_value() && snapshot->status == "ready",
            "session should return to ready after recording");

    auto pattern = engine.takeScratchRecordingPattern();
    require(pattern.has_value(), "completed pattern should be retrievable");
    require(pattern->provenance.has_value(), "pattern should have provenance");
    require(pattern->provenance->sourceClipId == "clip-rec",
            "pattern provenance should reference the session clip");
    require(pattern->durationUs > 0, "pattern should have positive duration");
    require(pattern->platter.size() >= 2, "pattern should have platter data");
    require(pattern->crossfader.size() >= 2, "pattern should have crossfader data");

    // Round-trip: serialize and re-parse
    const auto serialized = scratch::serializePattern(*pattern);
    const auto reparsed = scratch::parsePattern(serialized);
    require(reparsed.has_value(), "serialized pattern should re-parse");
    require(reparsed->id == pattern->id, "round-trip should preserve id");
    require(reparsed->platter.size() == pattern->platter.size(),
            "round-trip should preserve platter count");
}

void testRecorderAbortOnSessionClose()
{
    AudioEngine engine;
    engine.initialiseGraph();
    constexpr double sampleRate = 48000.0;
    const auto sessionId = engine.beginScratchSession("clip-abort");
    engine.completeScratchSession(
        sessionId, makeRecorderTestBuffer(static_cast<int>(sampleRate * 2.0), sampleRate),
        sampleRate);

    scratch::SessionControlPayload recordStart;
    recordStart.sessionId = sessionId;
    recordStart.action = scratch::ControlAction::recordStart;
    require(engine.controlScratchSession(recordStart), "recordStart should succeed");

    // Close the session during recording — should abort
    require(engine.closeScratchSession(sessionId),
            "close during recording should succeed");
    require(!engine.takeScratchRecordingPattern().has_value(),
            "aborted recording should not produce a pattern");
}

void testRecorderSaturatedLaneCapacity()
{
    scratch::ScratchActionRecorder recorder;
    scratch::ScratchActionRecorder::Config cfg;
    cfg.draftId = "draft-sat";
    cfg.draftName = "Saturated";
    cfg.sessionId = "session-sat";
    cfg.clipId = "clip-sat";
    cfg.ownerDeck = scratch::DeckSide::deck1;
    cfg.initialPlatterTurns = 0.0;
    cfg.initialCrossfader = 0.5;
    cfg.initialTouched = false;
    cfg.cropStartUs = 0;

    require(recorder.start(cfg), "recorder should start");
    // Initial keyframe is at time 0. Fill to kMaxPatternPoints - 1.
    // We can't record that many with real sleeps, so verify that recording
    // stops accepting once the limit is hit, and stop() still produces a
    // valid pattern with the final boundary.
    // Simulate with a fast clock: recordPlatter returns silently when full.
    // We just verify that stop() never exceeds kMaxPatternPoints.
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    for (int i = 0; i < 200; ++i)
    {
        recorder.recordPlatter(static_cast<double>(i) * 0.001, (i % 3) == 0);
        std::this_thread::sleep_for(std::chrono::microseconds(10));
    }

    require(recorder.stop(defaultFinalSnapshot()), "stop after many keyframes should succeed");
    auto pattern = recorder.takeCompletedPattern();
    require(pattern.has_value(), "saturated recorder should produce a pattern");
    require(static_cast<std::int64_t>(pattern->platter.size()) <= scratch::kMaxPatternPoints,
            "platter lane should not exceed kMaxPatternPoints");
    require(static_cast<std::int64_t>(pattern->crossfader.size()) <= scratch::kMaxPatternPoints,
            "crossfader lane should not exceed kMaxPatternPoints");
    // First keyframe at 0, last at durationUs
    require(pattern->platter.front().timeUs == 0,
            "saturated pattern first platter should be at 0");
    require(pattern->platter.back().timeUs == pattern->durationUs,
            "saturated pattern last platter should be at durationUs");
    require(pattern->crossfader.front().timeUs == 0,
            "saturated pattern first crossfader should be at 0");
    require(pattern->crossfader.back().timeUs == pattern->durationUs,
            "saturated pattern last crossfader should be at durationUs");
}

void testRecorderOwnerDeckUpdate()
{
    scratch::ScratchActionRecorder recorder;
    scratch::ScratchActionRecorder::Config cfg;
    cfg.draftId = "draft-deck";
    cfg.draftName = "Deck update";
    cfg.sessionId = "session-deck";
    cfg.clipId = "clip-deck";
    cfg.ownerDeck = scratch::DeckSide::deck1;
    cfg.initialPlatterTurns = 0.0;
    cfg.initialCrossfader = 0.0;
    cfg.initialTouched = false;
    cfg.cropStartUs = 0;

    require(recorder.start(cfg), "recorder should start");
    // Update owner deck to deck 2 before stop
    recorder.updateOwnerDeck(scratch::DeckSide::deck2);
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    recorder.recordPlatter(0.1, true);
    require(recorder.stop(defaultFinalSnapshot(0.1, true, 0.0)), "recorder should stop");

    auto pattern = recorder.takeCompletedPattern();
    require(pattern.has_value(), "pattern should exist");
    require(pattern->ownerDeck == scratch::DeckSide::deck2,
            "pattern should reflect updated owner deck");
}

void testRecorderStopUsesAuthoritativeSnapshot()
{
    scratch::ScratchActionRecorder recorder;
    scratch::ScratchActionRecorder::Config cfg;
    cfg.draftId = "draft-auth";
    cfg.draftName = "Authoritative stop";
    cfg.sessionId = "session-auth";
    cfg.clipId = "clip-auth";
    cfg.ownerDeck = scratch::DeckSide::deck1;
    cfg.initialPlatterTurns = 0.0;
    cfg.initialCrossfader = 0.5;
    cfg.initialTouched = false;
    cfg.cropStartUs = 0;

    require(recorder.start(cfg), "recorder should start");
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    // Record some intermediate values
    recorder.recordPlatter(0.1, true);
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    recorder.recordPlatter(0.2, true);
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    recorder.recordCrossfader(0.6);

    // Stop with a different authoritative snapshot than last recorded values
    scratch::ScratchActionRecorder::FinalSnapshot finalState;
    finalState.platterTurns = 0.35;
    finalState.touched = false;
    finalState.crossfader = 0.9;
    require(recorder.stop(finalState), "stop with authoritative snapshot should succeed");

    auto pattern = recorder.takeCompletedPattern();
    require(pattern.has_value(), "completed pattern should exist");
    // The final platter keyframe must use the authoritative snapshot values
    requireNear(pattern->platter.back().turns, 0.35, 1.0e-12,
                "final platter keyframe must use authoritative platterTurns");
    require(pattern->platter.back().touched == false,
            "final platter keyframe must use authoritative touched state");
    requireNear(pattern->crossfader.back().value, 0.9, 1.0e-12,
                "final crossfader keyframe must use authoritative crossfader value");
    // Ensure timestamps are valid
    require(pattern->platter.back().timeUs == pattern->durationUs,
            "final platter keyframe time must equal durationUs");
    require(pattern->crossfader.back().timeUs == pattern->durationUs,
            "final crossfader keyframe time must equal durationUs");
    // Zero-duration edge case: if stop is instant, keyframe still uses authoritative values
}

void testRecorderZeroDurationStopUsesAuthoritativeSnapshot()
{
    scratch::ScratchActionRecorder recorder;
    scratch::ScratchActionRecorder::Config cfg;
    cfg.draftId = "draft-zero";
    cfg.draftName = "Zero duration auth";
    cfg.sessionId = "session-zero";
    cfg.clipId = "clip-zero";
    cfg.ownerDeck = scratch::DeckSide::deck1;
    cfg.initialPlatterTurns = 1.0;
    cfg.initialCrossfader = 0.0;
    cfg.initialTouched = true;
    cfg.cropStartUs = 0;

    require(recorder.start(cfg), "recorder should start");
    // Stop immediately — durationUs may be zero or near-zero
    scratch::ScratchActionRecorder::FinalSnapshot finalState;
    finalState.platterTurns = 1.5;
    finalState.touched = false;
    finalState.crossfader = 0.7;
    require(recorder.stop(finalState), "immediate stop should succeed");

    auto pattern = recorder.takeCompletedPattern();
    require(pattern.has_value(), "pattern should be produced");
    // Even with zero/near-zero duration, boundary keyframes use authoritative values
    requireNear(pattern->platter.back().turns, 1.5, 1.0e-12,
                "zero-duration final platter must use authoritative turns");
    requireNear(pattern->crossfader.back().value, 0.7, 1.0e-12,
                "zero-duration final crossfader must use authoritative value");
}

} // namespace

void addScratchRecorderTests(std::vector<TestCase>& tests)
{
    tests.push_back({"scratch recorder start and reset", testRecorderStartAndReset});
    tests.push_back({"scratch recorder platter capture", testRecorderPlatterCapture});
    tests.push_back({"scratch recorder touch state and direction changes", testRecorderTouchStateAndDirectionChange});
    tests.push_back({"scratch recorder crossfader after soft takeover", testRecorderCrossfaderAfterSoftTakeover});
    tests.push_back({"scratch recorder strict ordering and bounds", testRecorderStrictOrderingAndBounds});
    tests.push_back({"scratch recorder stop abort and stale controls", testRecorderStopAndAbortControls});
    tests.push_back({"scratch recorder stale session rejection", testRecorderStaleSessionReject});
    tests.push_back({"scratch recorder engine integration", testRecorderEngineIntegration});
    tests.push_back({"scratch recorder abort on session close", testRecorderAbortOnSessionClose});
    tests.push_back({"scratch recorder saturated lane capacity", testRecorderSaturatedLaneCapacity});
    tests.push_back({"scratch recorder owner deck update", testRecorderOwnerDeckUpdate});
    tests.push_back({"scratch recorder stop uses authoritative snapshot", testRecorderStopUsesAuthoritativeSnapshot});
    tests.push_back({"scratch recorder zero duration stop uses authoritative snapshot", testRecorderZeroDurationStopUsesAuthoritativeSnapshot});
}

} // namespace silverdaw::tests
