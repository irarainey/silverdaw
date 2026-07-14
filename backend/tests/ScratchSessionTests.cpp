#include "TestRegistry.h"

#include "AudioEngine.h"
#include "midi/MidiScratchRouting.h"
#include "scratch/ScratchSessionController.h"
#include "scratch/ScratchAudioSource.h"
#include "scratch/ScratchSourcePreparation.h"

#include <cmath>
#include <memory>

namespace silverdaw::tests
{
namespace
{

std::shared_ptr<const juce::AudioBuffer<float>> makeScratchBuffer(
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

void renderScratchBlocks(scratch::ScratchAudioSource& source,
                         int totalSamples, int blockSize)
{
    juce::AudioBuffer<float> output(2, blockSize);
    int rendered = 0;
    while (rendered < totalSamples)
    {
        const auto count = juce::jmin(blockSize, totalSamples - rendered);
        output.clear();
        source.getNextAudioBlock({&output, 0, count});
        rendered += count;
    }
}

void renderBackingBlocks(scratch::BackingMonitorSource& backing,
                         int totalSamples, int blockSize)
{
    juce::AudioBuffer<float> output(2, blockSize);
    int rendered = 0;
    while (rendered < totalSamples)
    {
        const auto count = juce::jmin(blockSize, totalSamples - rendered);
        output.clear();
        backing.getNextAudioBlock({&output, 0, count});
        rendered += count;
    }
}

// Prepare and activate a backing bed on a controller so the transport (which now
// drives the backing channel only) has something to run.
void prepareControllerBacking(scratch::ScratchSessionController& controller,
                              const juce::String& sessionId,
                              int samples, double sampleRate)
{
    require(controller.beginBackingPreparation(sessionId),
            "backing preparation should begin");
    require(controller.completeBacking(
                sessionId, makeScratchBuffer(samples, sampleRate), sampleRate),
            "backing preparation should complete and activate");
}

juce::File writeRampWav(const juce::File& directory, double sampleRate)
{
    const auto file = directory.getChildFile("source.wav");
    juce::WavAudioFormat wav;
    std::unique_ptr<juce::OutputStream> stream(file.createOutputStream());
    require(stream != nullptr, "scratch source stream should open");
    const auto options = juce::AudioFormatWriterOptions{}
                             .withSampleRate(sampleRate)
                             .withNumChannels(1)
                             .withBitsPerSample(32);
    std::unique_ptr<juce::AudioFormatWriter> writer(wav.createWriterFor(stream, options));
    require(writer != nullptr, "scratch source writer should create");
    juce::AudioBuffer<float> audio(1, static_cast<int>(sampleRate));
    for (int sample = 0; sample < audio.getNumSamples(); ++sample)
    {
        audio.setSample(0, sample,
                        static_cast<float>(sample) / static_cast<float>(audio.getNumSamples()));
    }
    require(writer->writeFromAudioSampleBuffer(audio, 0, audio.getNumSamples()),
            "scratch source should write");
    return file;
}

void testScratchAudioSourceTransport()
{
    constexpr double sampleRate = 48000.0;
    scratch::ScratchAudioSource source(
        makeScratchBuffer(static_cast<int>(sampleRate * 4.0), sampleRate),
        sampleRate);
    source.prepareToPlay(512, sampleRate);
    source.setPlaying(true);
    renderScratchBlocks(source, static_cast<int>(sampleRate * 1.8), 512);
    const auto nominal = source.snapshot();
    requireNear(nominal.platterTurns, 1.0, 0.01,
                "nominal scratch transport should rotate once in 1.8 seconds");
    requireNear(nominal.playbackRate, 1.0, 0.01,
                "nominal scratch transport should settle at unit rate");

    source.setTouched(true);
    renderScratchBlocks(source, static_cast<int>(sampleRate * 0.1), 512);
    const auto held = source.snapshot();
    renderScratchBlocks(source, static_cast<int>(sampleRate * 0.1), 512);
    const auto heldLater = source.snapshot();
    require(std::abs(heldLater.positionUs - held.positionUs) < 1000,
            "settled platter hold should stop source movement");

    source.setManualRate(-1.0, 0.2);
    renderScratchBlocks(source, static_cast<int>(sampleRate * 0.1), 512);
    require(source.snapshot().positionUs < heldLater.positionUs,
            "negative platter movement should read backward");

    source.setPlaying(false);
    source.setManualRate(1.0, 0.2);
    const auto pausedPosition = source.snapshot().positionUs;
    renderScratchBlocks(source, static_cast<int>(sampleRate * 0.1), 512);
    require(source.snapshot().positionUs > pausedPosition,
            "manual platter movement should advance a paused scratch source");
}

void testScratchSessionLifecycleAndOwnership()
{
    AudioEngine engine;
    engine.initialiseGraph();
    const auto firstId = engine.beginScratchSession("clip-1");
    require(firstId.isNotEmpty(), "scratch session should receive a backend id");
    require(engine.getScratchSessionSnapshot()->status == "preparing",
            "new scratch session should prepare");
    require(engine.setScratchPreparationProgress(firstId, 0.4),
            "current scratch preparation should accept progress");
    requireNear(engine.getScratchSessionSnapshot()->preparationProgress, 0.4, 1.0e-12,
                "scratch preparation progress should publish");
    require(engine.completeScratchSession(
                firstId, makeScratchBuffer(48000, 48000.0), 48000.0),
            "current scratch preparation should attach");
    requireNear(engine.getScratchSessionSnapshot()->preparationProgress, 1.0, 1.0e-12,
                "completed scratch preparation should publish full progress");
    engine.setScratchMidiSelectedDeck(
        "device-1", scratch::DeckSide::deck2, false);
    require(engine.getScratchSessionSnapshot()->selectedDeck
                == std::optional<scratch::DeckSide>{scratch::DeckSide::deck2},
            "cue-selected deck should publish before the platter is touched");
    requireNear(engine.getScratchSessionSnapshot()->crossfader, 1.0, 1.0e-12,
                "untouched crossfader should assume deck 2's open edge");
    require(!engine.getScratchSessionSnapshot()->crossfaderReversed,
            "left-to-right direction should report an un-reversed fader");
    require(engine.setScratchMidiCrossfaderDirection("device-1", true),
            "direction change should remap the selected deck edge");
    requireNear(engine.getScratchSessionSnapshot()->crossfader, 1.0, 1.0e-12,
                "reversed direction should recolour without moving the knob");
    require(engine.getScratchSessionSnapshot()->crossfaderReversed,
            "right-to-left direction should report a reversed fader");
    require(engine.setScratchMidiCrossfaderDirection("device-1", false),
            "restoring direction should remap the selected deck edge");
    require(!engine.getScratchSessionSnapshot()->crossfaderReversed,
            "restored direction should report an un-reversed fader again");

    scratch::SessionControlPayload touch;
    touch.sessionId = firstId;
    touch.action = scratch::ControlAction::platterTouch;
    touch.deck = scratch::DeckSide::deck1;
    touch.touched = true;
    require(engine.controlScratchSession(touch), "first deck should claim scratch session");

    auto conflicting = touch;
    conflicting.deck = scratch::DeckSide::deck2;
    require(!engine.controlScratchSession(conflicting),
            "second deck should not steal an active scratch session");

    scratch::SessionControlPayload crossfader;
    crossfader.sessionId = firstId;
    crossfader.action = scratch::ControlAction::crossfader;
    crossfader.crossfader = 0.25;
    require(engine.controlScratchSession(crossfader), "scratch crossfader should apply");
    requireNear(engine.getScratchSessionSnapshot()->crossfader, 0.25, 1.0e-12,
                "scratch crossfader state should publish");

    touch.touched = false;
    require(engine.controlScratchSession(touch), "owner platter release should apply");
    require(!engine.getScratchSessionSnapshot()->ownerDeck.has_value(),
            "platter release should release deck ownership");

    require(engine.scratchMidiSetTouch(
                "device-1", scratch::DeckSide::deck1, true),
            "first enabled MIDI deck should claim scratch ownership");
    require(!engine.scratchMidiSetTouch(
                "device-2", scratch::DeckSide::deck2, true),
            "another MIDI device should not steal scratch ownership");
    require(engine.getScratchSessionSnapshot()->ownerDeviceIdentifier
                == std::optional<juce::String>{"device-1"},
            "scratch state should publish the owning MIDI device");
    require(engine.scratchMidiSetCrossfader("device-1", 0.6),
            "first physical crossfader movement should apply immediately");
    requireNear(engine.getScratchSessionSnapshot()->crossfader, 0.6, 1.0e-12,
                "first physical crossfader movement should publish its position");
    require(engine.scratchMidiSetCrossfader("device-1", 0.3),
            "subsequent physical crossfader movement should apply");
    requireNear(engine.getScratchSessionSnapshot()->crossfader, 0.3, 1.0e-12,
                "physical crossfader should continue tracking");
    require(!engine.releaseScratchMidiOwner("device-2"),
            "non-owner device should not release scratch ownership");
    require(engine.releaseScratchMidiOwner("device-1"),
            "owning MIDI device should release scratch ownership");

    const auto secondId = engine.beginScratchSession("clip-2");
    require(secondId != firstId, "reopened scratch session should use a new generation id");
    require(!engine.closeScratchSession(firstId), "stale scratch close should reject");
    require(engine.closeScratchSession(secondId), "current scratch close should succeed");
}

void testScratchSourcePreparationCache()
{
    const auto directory = makeTempDir("scratch-preparation");
    const auto sourceFile = writeRampWav(directory, 48000.0);
    AudioEngine engine;
    engine.initialiseGraph();

    scratch::SourcePreparationSettings settings;
    settings.sourceFile = sourceFile;
    settings.inMs = 100.0;
    settings.durationMs = 200.0;
    settings.reversed = true;
    scratch::PreparedSource cancelled;
    juce::String error;
    require(!scratch::prepareSourceToCache(
                settings, directory.getChildFile("cache"), engine,
                cancelled, error, [] { return true; }),
            "stale scratch preparation should cancel before doing work");
    require(error == "Scratch preparation cancelled",
            "cancelled scratch preparation should report its reason");

    scratch::PreparedSource first;
    error.clear();
    require(scratch::prepareSourceToCache(
                settings, directory.getChildFile("cache"), engine, first, error),
            "reversed scratch source should prepare");
    require(first.audio != nullptr && first.audio->getNumSamples() == 9600,
            "prepared scratch source should use the clip window");
    require(first.audio->getSample(0, 0)
                > first.audio->getSample(0, first.audio->getNumSamples() - 1),
            "prepared scratch source should bake reverse before scratching");
    require(first.cacheFile.existsAsFile(), "prepared scratch source should persist in cache");

    scratch::PreparedSource second;
    require(scratch::prepareSourceToCache(
                settings, directory.getChildFile("cache"), engine, second, error),
            "prepared scratch cache should reopen");
    require(second.audio != nullptr && second.audio->getNumSamples() == 9600,
            "reopened scratch cache should retain prepared audio");
    require(second.cacheFile == first.cacheFile,
            "identical scratch transforms should reuse their cache entry");
    const auto reopenedId = engine.beginScratchSession("cached-clip");
    require(engine.completeScratchSession(
                reopenedId, second.audio, second.sampleRate),
            "reopened scratch cache should activate a later session");

    settings.reversed = false;
    settings.warpEnabled = true;
    settings.tempoRatio = 2.0;
    scratch::PreparedSource warped;
    require(scratch::prepareSourceToCache(
                settings, directory.getChildFile("cache"), engine, warped, error),
            "warped scratch source should prepare");
    require(std::abs(warped.audio->getNumSamples() - 4800) <= 1,
            "scratch preparation should bake the effective tempo ratio");
    require(warped.cacheFile != first.cacheFile,
            "transform changes should invalidate the prepared scratch cache");
    directory.deleteRecursively();
}

void testScratchSourceActivateDeactivate()
{
    constexpr double sampleRate = 48000.0;
    scratch::ScratchAudioSource source;
    source.prepareToPlay(512, sampleRate);

    require(!source.isActive(), "default-constructed scratch source should be inactive");
    juce::AudioBuffer<float> output(2, 512);
    output.clear();
    source.getNextAudioBlock({&output, 0, 512});
    require(output.getMagnitude(0, 512) < 1.0e-6F,
            "inactive scratch source should produce silence");

    source.activate(makeScratchBuffer(static_cast<int>(sampleRate * 2.0), sampleRate),
                    sampleRate);
    require(source.isActive(), "scratch source should be active after activate");
    source.setPlaying(true);
    renderScratchBlocks(source, static_cast<int>(sampleRate * 0.5), 512);
    require(source.snapshot().positionUs > 0,
            "active scratch source should advance position");

    source.deactivate();
    require(!source.isActive(), "scratch source should be inactive after deactivate");
    output.clear();
    source.getNextAudioBlock({&output, 0, 512});
    require(output.getMagnitude(0, 512) < 1.0e-6F,
            "deactivated scratch source should produce silence");
}

void testScratchFixedTopologySession()
{
    AudioEngine engine;
    engine.initialiseGraph();
    const auto sessionId = engine.beginScratchSession("clip-1");
    require(engine.completeScratchSession(
                sessionId, makeScratchBuffer(48000, 48000.0), 48000.0),
            "fixed-topology scratch complete should activate");
    require(engine.getScratchSessionSnapshot()->status == "ready",
            "completed scratch session status should be ready");
    require(engine.closeScratchSession(sessionId),
            "close should succeed on active session");
    require(!engine.getScratchSessionSnapshot().has_value(),
            "closed session should clear snapshot");

    // Reopen should work without creating a new source
    const auto secondId = engine.beginScratchSession("clip-2");
    require(engine.completeScratchSession(
                secondId, makeScratchBuffer(48000, 48000.0), 48000.0),
            "second fixed-topology scratch complete should reactivate");
    require(engine.closeScratchSession(secondId),
            "second session close should succeed");
}

void testCrossfaderInitialEdgeAndTracking()
{
    AudioEngine engine;
    engine.initialiseGraph();
    constexpr double sampleRate = 48000.0;
    const auto sessionId = engine.beginScratchSession("clip-crossfader-tracking");
    engine.completeScratchSession(
        sessionId, makeScratchBuffer(static_cast<int>(sampleRate), sampleRate), sampleRate);

    // Claim deck 2 via MIDI — crossfader starts at 1.0
    require(engine.scratchMidiSetTouch("dev-1", scratch::DeckSide::deck2, true),
            "deck 2 MIDI claim should succeed");
    requireNear(engine.getScratchSessionSnapshot()->crossfader, 1.0, 1.0e-12,
                "deck 2 should start at crossfader 1.0");

    require(engine.scratchMidiSetCrossfader("dev-1", 0.6),
            "first physical crossfader movement should apply");
    requireNear(engine.getScratchSessionSnapshot()->crossfader, 0.6, 1.0e-12,
                "effective value should soft-slide toward the first physical position");

    require(engine.scratchMidiSetCrossfader("dev-1", 0.4),
            "subsequent physical crossfader movement should follow");
    requireNear(engine.getScratchSessionSnapshot()->crossfader, 0.4, 1.0e-12,
                "effective value should follow physical movement");

    require(engine.releaseScratchMidiOwner("dev-1"),
            "release should succeed");
    require(engine.scratchMidiSetTouch("dev-1", scratch::DeckSide::deck1, true),
            "re-claim deck 1 should succeed");
    requireNear(engine.getScratchSessionSnapshot()->crossfader, 0.4, 1.0e-12,
                "re-claiming another deck should preserve the physical position");

    require(engine.scratchMidiSetCrossfader("dev-1", 0.8),
            "physical movement after re-claim should continue tracking");
    requireNear(engine.getScratchSessionSnapshot()->crossfader, 0.8, 1.0e-12,
                "tracking should persist until the session closes");

    require(engine.closeScratchSession(sessionId),
            "tracked crossfader session should close");
    const auto reopenedId = engine.beginScratchSession("clip-crossfader-reopened");
    engine.completeScratchSession(
        reopenedId, makeScratchBuffer(static_cast<int>(sampleRate), sampleRate), sampleRate);
    require(engine.scratchMidiSetTouch("dev-1", scratch::DeckSide::deck2, true),
            "reopened session should accept a new deck claim");
    requireNear(engine.getScratchSessionSnapshot()->crossfader, 1.0, 1.0e-12,
                "reopened session should reset to the selected deck's open edge");
    engine.closeScratchSession(reopenedId);
}

void testScratchSourceActivationRace()
{
    constexpr double sampleRate = 48000.0;
    scratch::ScratchAudioSource source;
    source.prepareToPlay(512, sampleRate);

    // Activate
    source.activate(makeScratchBuffer(static_cast<int>(sampleRate), sampleRate), sampleRate);
    require(source.isActive(), "should be active after activate");
    source.setPlaying(true);

    // Render some blocks
    renderScratchBlocks(source, static_cast<int>(sampleRate * 0.1), 512);
    require(source.snapshot().positionUs > 0, "should advance");

    // Deactivate while "active" — deactivate waits for quiescence
    source.deactivate();
    require(!source.isActive(), "should be inactive after deactivate");

    // Callback after deactivate must produce silence
    juce::AudioBuffer<float> output(2, 512);
    output.clear();
    source.getNextAudioBlock({&output, 0, 512});
    require(output.getMagnitude(0, 512) < 1.0e-6F,
            "post-deactivate callback should produce silence");

    // Re-activate
    source.activate(makeScratchBuffer(static_cast<int>(sampleRate * 2.0), sampleRate), sampleRate);
    require(source.isActive(), "should be active after re-activate");
    source.setPlaying(true);
    renderScratchBlocks(source, static_cast<int>(sampleRate * 0.1), 512);
    require(source.snapshot().positionUs > 0, "should advance after re-activate");

    source.deactivate();
}

void testScratchSessionAutoStopsAtForwardEnd()
{
    constexpr double sampleRate = 48000.0;
    scratch::ScratchAudioSource source;
    source.prepareToPlay(512, sampleRate);
    scratch::BackingMonitorSource backing;
    backing.prepareToPlay(512, sampleRate);
    scratch::ScratchSessionController controller(source, backing);
    const auto sessionId = controller.beginSession("clip-end-stop");
    require(controller.completeSession(
                sessionId, makeScratchBuffer(static_cast<int>(sampleRate * 0.05), sampleRate),
                sampleRate),
            "scratch session should prepare for end-stop testing");
    // The transport now runs the backing window, which bounds the session.
    prepareControllerBacking(controller, sessionId,
                             static_cast<int>(sampleRate * 0.05), sampleRate);

    scratch::SessionControlPayload play;
    play.sessionId = sessionId;
    play.action = scratch::ControlAction::play;
    require(controller.controlSession(play), "backing transport should start playback");
    require(backing.isPlaying(), "play should run the backing bed");
    require(!source.snapshot().playing,
            "transport play must not spin the scratch clip");

    renderBackingBlocks(backing, static_cast<int>(sampleRate * 0.2), 128);
    require(controller.reconcileSourceEnd(),
            "backing window end should report a consumed transition");

    const auto snapshot = controller.getSnapshot();
    require(snapshot && snapshot->status == "ready",
            "backing window end should transition the session back to ready");
    require(!backing.isPlaying(),
            "backing window end reconciliation should stop backing playback");
    // After end reconciliation, the backing should be back at start.
    require(backing.positionUs() == 0,
            "backing window end reconciliation should reset backing position to start");
    require(!backing.isAtForwardBoundary(),
            "backing window end reconciliation should leave backing away from the end boundary");
}

void testScratchSessionPlayFromEndRestartsFromBeginning()
{
    constexpr double sampleRate = 48000.0;
    scratch::ScratchAudioSource source;
    source.prepareToPlay(512, sampleRate);
    scratch::BackingMonitorSource backing;
    backing.prepareToPlay(512, sampleRate);
    scratch::ScratchSessionController controller(source, backing);
    const auto sessionId = controller.beginSession("clip-restart");
    require(controller.completeSession(
                sessionId, makeScratchBuffer(static_cast<int>(sampleRate * 0.05), sampleRate),
                sampleRate),
            "scratch session should prepare for replay testing");
    prepareControllerBacking(controller, sessionId,
                             static_cast<int>(sampleRate * 0.05), sampleRate);

    scratch::SessionControlPayload play;
    play.sessionId = sessionId;
    play.action = scratch::ControlAction::play;
    require(controller.controlSession(play), "backing transport should start playback");
    renderBackingBlocks(backing, static_cast<int>(sampleRate * 0.2), 128);
    controller.reconcileSourceEnd();
    require(!backing.isAtForwardBoundary(),
            "backing should be at start after end reconciliation");

    require(controller.controlSession(play),
            "play after backing end should start from the beginning");
    const auto restarted = controller.getSnapshot();
    require(restarted && restarted->status == "playing",
            "restarted session should return to playing");
    require(backing.isPlaying(), "restarted session should run the backing bed");
    require(backing.positionUs() == 0,
            "restarted backing playback should begin at position zero");
}

void testScratchMidiCrossfaderWorksWithoutPlatterOwnership()
{
    AudioEngine engine;
    engine.initialiseGraph();
    constexpr double sampleRate = 48000.0;
    const auto sessionId = engine.beginScratchSession("clip-midi-crossfader");
    require(engine.completeScratchSession(
                sessionId, makeScratchBuffer(static_cast<int>(sampleRate), sampleRate), sampleRate),
            "scratch session should prepare for MIDI crossfader testing");
    require(engine.scratchMidiSetTouch("device-1", scratch::DeckSide::deck1, true),
            "MIDI deck should claim scratch ownership before release");
    require(engine.releaseScratchMidiOwner("device-1"),
            "MIDI deck release should succeed");
    require(!engine.getScratchSessionSnapshot()->ownerDeviceIdentifier.has_value(),
            "released MIDI platter ownership should clear the current owner");

    require(engine.scratchMidiSetCrossfader("device-1", 0.35),
            "eligible MIDI device should keep tracking after platter release");
    requireNear(engine.getScratchSessionSnapshot()->crossfader, 0.35, 1.0e-12,
                "post-release MIDI crossfader movement should update state");
    require(!engine.getScratchSessionSnapshot()->ownerDeviceIdentifier.has_value(),
            "crossfader-only movement should not steal platter ownership back");
    require(!engine.scratchMidiSetCrossfader("device-2", 0.5),
            "non-eligible MIDI devices should still be rejected");
}

void testRapidMidiCrossfaderCoalescesToFinalValue()
{
    AudioEngine engine;
    engine.initialiseGraph();
    constexpr double sampleRate = 48000.0;
    const auto sessionId = engine.beginScratchSession("clip-rapid-cf");
    engine.completeScratchSession(
        sessionId, makeScratchBuffer(static_cast<int>(sampleRate), sampleRate), sampleRate);

    // Claim deck 1 via MIDI — crossfader starts at 0.0
    require(engine.scratchMidiSetTouch("dev-rapid", scratch::DeckSide::deck1, true),
            "MIDI deck claim should succeed for rapid crossfader testing");
    requireNear(engine.getScratchSessionSnapshot()->crossfader, 0.0, 1.0e-12,
                "initial crossfader should be 0.0");

    require(engine.scratchMidiSetCrossfader("dev-rapid", 0.5),
            "first physical value should apply immediately");

    // Simulate rapid sequential MIDI events — all should succeed and only the
    // final value matters for the snapshot.
    int appliedCount = 0;
    for (int i = 1; i <= 50; ++i)
    {
        const double v = static_cast<double>(i) / 50.0;
        if (engine.scratchMidiSetCrossfader("dev-rapid", v))
            ++appliedCount;
    }
    require(appliedCount == 50,
            "all rapid crossfader moves should apply");
    requireNear(engine.getScratchSessionSnapshot()->crossfader, 1.0, 1.0e-12,
                "snapshot should reflect the final crossfader value after rapid sequence");

    // Rapid reverse
    for (int i = 49; i >= 0; --i)
    {
        const double v = static_cast<double>(i) / 50.0;
        engine.scratchMidiSetCrossfader("dev-rapid", v);
    }
    requireNear(engine.getScratchSessionSnapshot()->crossfader, 0.0, 1.0e-12,
                "snapshot should reflect final value after rapid reverse sequence");

    engine.closeScratchSession(sessionId);
}

} // namespace

void testScratchPlayProducesAudioThroughMixer()
{
    AudioEngine engine;
    engine.initialiseGraph();
    constexpr double sampleRate = 48000.0;
    constexpr int blockSize = 512;
    const auto sessionId = engine.beginScratchSession("clip-audio-output");
    require(engine.completeScratchSession(
                sessionId, makeScratchBuffer(static_cast<int>(sampleRate * 2.0), sampleRate),
                sampleRate),
            "scratch session should prepare for audio output testing");

    // The scratch clip is heard when it spins (its recording-time state); the
    // transport no longer auditions it. Drive the motor directly to exercise
    // the mixer audio path.
    auto& source = engine.scratchSourceForTest();
    source.setPlaying(true);

    // Render blocks and verify the scratch source produces non-zero audio.
    juce::AudioBuffer<float> output(2, blockSize);
    output.clear();
    source.getNextAudioBlock({&output, 0, blockSize});
    const auto magnitude = output.getMagnitude(0, blockSize);
    require(magnitude > 1.0e-4F,
            "spinning scratch source should produce audible output through the mixer");

    engine.closeScratchSession(sessionId);
}

void testScratchPointerCrossfaderCutSilencesWithoutTouch()
{
    AudioEngine engine;
    engine.initialiseGraph();
    constexpr double sampleRate = 48000.0;
    constexpr int blockSize = 512;
    const auto sessionId = engine.beginScratchSession("clip-cut-default-deck");
    require(engine.completeScratchSession(
                sessionId, makeScratchBuffer(static_cast<int>(sampleRate * 2.0), sampleRate),
                sampleRate),
            "scratch session should prepare for crossfader-cut testing");

    scratch::SessionControlPayload cut;
    cut.sessionId = sessionId;
    cut.action = scratch::ControlAction::crossfader;
    cut.crossfader = 1.0;

    auto& source = engine.scratchSourceForTest();
    // Spin the clip directly (its recording-time state) to exercise the
    // crossfader gain path without a platter touch.
    source.setPlaying(true);
    juce::AudioBuffer<float> output(2, blockSize);

    output.clear();
    source.getNextAudioBlock({&output, 0, blockSize});
    require(output.getMagnitude(0, blockSize) > 1.0e-4F,
            "virtual scratch deck should be audible by default before any platter touch");

    require(engine.controlScratchSession(cut),
            "crossfader cut should apply without a prior platter touch");

    // Settle the short gain ramp, then confirm the deck is silenced.
    for (int i = 0; i < 12; ++i)
    {
        output.clear();
        source.getNextAudioBlock({&output, 0, blockSize});
    }
    require(output.getMagnitude(0, blockSize) < 1.0e-3F,
            "closed crossfader should silence the virtual deck with no deck claimed");

    cut.crossfader = 0.0;
    require(engine.controlScratchSession(cut), "crossfader open should apply");
    for (int i = 0; i < 12; ++i)
    {
        output.clear();
        source.getNextAudioBlock({&output, 0, blockSize});
    }
    require(output.getMagnitude(0, blockSize) > 1.0e-4F,
            "reopened crossfader should restore audible output");

    engine.closeScratchSession(sessionId);
}

void testScratchTransportRequiresBacking()
{
    constexpr double sampleRate = 48000.0;
    scratch::ScratchAudioSource source;
    source.prepareToPlay(512, sampleRate);
    scratch::BackingMonitorSource backing;
    backing.prepareToPlay(512, sampleRate);
    scratch::ScratchSessionController controller(source, backing);
    const auto sessionId = controller.beginSession("clip-no-backing");
    require(controller.completeSession(
                sessionId, makeScratchBuffer(static_cast<int>(sampleRate * 0.5), sampleRate),
                sampleRate),
            "scratch session should prepare without a backing");

    scratch::SessionControlPayload play;
    play.sessionId = sessionId;
    play.action = scratch::ControlAction::play;
    require(!controller.controlSession(play),
            "transport play should be rejected when no backing is prepared");
    require(!source.snapshot().playing,
            "rejected play must not spin the scratch clip");
    require(controller.getSnapshot()->status == "ready",
            "rejected play should leave the session ready");

    scratch::SessionControlPayload seek;
    seek.sessionId = sessionId;
    seek.action = scratch::ControlAction::seek;
    seek.positionUs = 10000;
    require(!controller.controlSession(seek),
            "transport seek should be rejected when no backing is prepared");
}

void testScratchPlayFromReadyAndPausedStartsAndBroadcastsState()
{
    constexpr double sampleRate = 48000.0;
    scratch::ScratchAudioSource source;
    source.prepareToPlay(512, sampleRate);
    scratch::BackingMonitorSource backing;
    backing.prepareToPlay(512, sampleRate);
    scratch::ScratchSessionController controller(source, backing);
    const auto sessionId = controller.beginSession("clip-play-state");
    controller.completeSession(
        sessionId, makeScratchBuffer(static_cast<int>(sampleRate * 0.5), sampleRate), sampleRate);
    prepareControllerBacking(controller, sessionId,
                             static_cast<int>(sampleRate * 0.5), sampleRate);

    // Play from ready drives the backing bed, not the scratch clip.
    scratch::SessionControlPayload play;
    play.sessionId = sessionId;
    play.action = scratch::ControlAction::play;
    require(controller.controlSession(play), "play from ready should succeed");
    auto snap = controller.getSnapshot();
    require(snap && snap->status == "playing", "status should be playing after play from ready");
    require(backing.isPlaying(), "backing bed should be running after play");
    require(!source.snapshot().playing, "transport play must not spin the scratch clip");

    // Pause
    scratch::SessionControlPayload pause;
    pause.sessionId = sessionId;
    pause.action = scratch::ControlAction::pause;
    require(controller.controlSession(pause), "pause should succeed");
    snap = controller.getSnapshot();
    require(snap && snap->status == "paused", "status should be paused after pause");
    require(!backing.isPlaying(), "backing bed should be stopped after pause");

    // Play from paused
    require(controller.controlSession(play), "play from paused should succeed");
    snap = controller.getSnapshot();
    require(snap && snap->status == "playing", "status should be playing after play from paused");
    require(backing.isPlaying(), "backing bed should be running after play from paused");
}

void testScratchRepeatPlayEndCycles()
{
    constexpr double sampleRate = 48000.0;
    scratch::ScratchAudioSource source;
    source.prepareToPlay(512, sampleRate);
    scratch::BackingMonitorSource backing;
    backing.prepareToPlay(512, sampleRate);
    scratch::ScratchSessionController controller(source, backing);
    const auto sessionId = controller.beginSession("clip-repeat");
    require(controller.completeSession(
                sessionId, makeScratchBuffer(static_cast<int>(sampleRate * 0.05), sampleRate),
                sampleRate),
            "scratch session should prepare for repeat cycle testing");
    prepareControllerBacking(controller, sessionId,
                             static_cast<int>(sampleRate * 0.05), sampleRate);

    scratch::SessionControlPayload play;
    play.sessionId = sessionId;
    play.action = scratch::ControlAction::play;

    for (int cycle = 0; cycle < 5; ++cycle)
    {
        require(controller.controlSession(play),
                (juce::String("play should succeed on cycle ")
                 + juce::String(cycle + 1)).toRawUTF8());
        auto snap = controller.getSnapshot();
        require(snap && snap->status == "playing",
                (juce::String("status should be playing on cycle ")
                 + juce::String(cycle + 1)).toRawUTF8());
        require(backing.isActive(),
                (juce::String("backing should remain active on cycle ")
                 + juce::String(cycle + 1)).toRawUTF8());

        renderBackingBlocks(backing, static_cast<int>(sampleRate * 0.2), 128);
        require(controller.reconcileSourceEnd(),
                (juce::String("end should be consumed on cycle ")
                 + juce::String(cycle + 1)).toRawUTF8());

        snap = controller.getSnapshot();
        require(snap && snap->status == "ready",
                (juce::String("status should be ready after end on cycle ")
                 + juce::String(cycle + 1)).toRawUTF8());
        require(backing.positionUs() == 0,
                (juce::String("backing position should be 0 after end on cycle ")
                 + juce::String(cycle + 1)).toRawUTF8());
        require(!backing.isPlaying(),
                (juce::String("backing should be stopped after end on cycle ")
                 + juce::String(cycle + 1)).toRawUTF8());
        require(backing.isActive(),
                (juce::String("backing should stay active after end on cycle ")
                 + juce::String(cycle + 1)).toRawUTF8());
    }
}

void testScratchJogCalibration()
{
    constexpr double sampleRate = 48000.0;
    scratch::ScratchAudioSource source;
    source.prepareToPlay(512, sampleRate);
    source.activate(makeScratchBuffer(static_cast<int>(sampleRate * 4.0), sampleRate), sampleRate);

    // Nominal playback: 1.8 seconds per turn at 33⅓ RPM.
    source.setPlaying(true);
    renderScratchBlocks(source, static_cast<int>(sampleRate * 1.8), 512);
    const auto nominal = source.snapshot();
    requireNear(nominal.platterTurns, 1.0, 0.02,
                "one scratch turn should take 1.8 seconds at nominal speed");

    // Calibrated scratch ticks: 512 ticks = 1 turn for standard relative MIDI.
    // A single tick should be 1/512 of a turn.
    const double singleTickTurns = 1.0 / 512.0;
    requireNear(singleTickTurns, VinylScratchProcessor::turnsForSeconds(
        VinylScratchProcessor::secondsForTurns(singleTickTurns)),
        1.0e-12, "tick-to-turn round-trip should be identity");

    // For absolute-14 relative: 16384 ticks = 1 turn.
    const double hiResSingleTickTurns = 1.0 / 16384.0;
    require(hiResSingleTickTurns < singleTickTurns,
            "high-resolution tick should be finer than standard tick");

    source.deactivate();
}

void testScratchCrossfaderDirectionInversion()
{
    // Test that reverse crossfader setting inverts the physical value.
    MidiScratchDeviceState state;
    state.reverseCrossfader = false;

    // Without inversion: physical 0.8 passes through as-is.
    MidiControllerEvent event;
    event.action = MidiControllerAction::crossfader;
    event.kind = MidiControllerValueKind::absolute;
    event.deck = 0;
    event.value = 0.8;
    // The inversion logic in routeImmediate:
    //   directedValue = reverseCrossfader ? 1.0 - value : value
    const auto normalDirected = state.reverseCrossfader ? 1.0 - event.value : event.value;
    requireNear(normalDirected, 0.8, 1.0e-12,
                "normal direction should pass through physical value");

    // With inversion: physical 0.8 → directed 0.2.
    state.reverseCrossfader = true;
    const auto invertedDirected = state.reverseCrossfader ? 1.0 - event.value : event.value;
    requireNear(invertedDirected, 0.2, 1.0e-12,
                "reversed direction should invert physical value");

    // Physical 0.0 → directed 1.0.
    event.value = 0.0;
    const auto invertedZero = state.reverseCrossfader ? 1.0 - event.value : event.value;
    requireNear(invertedZero, 1.0, 1.0e-12,
                "reversed direction should map physical 0.0 to directed 1.0");

    // Physical 1.0 → directed 0.0.
    event.value = 1.0;
    const auto invertedOne = state.reverseCrossfader ? 1.0 - event.value : event.value;
    requireNear(invertedOne, 0.0, 1.0e-12,
                "reversed direction should map physical 1.0 to directed 0.0");

    // Verify first-touch tracking works with values normalized by the router.
    AudioEngine engine;
    engine.initialiseGraph();
    constexpr double sampleRate = 48000.0;
    const auto sessionId = engine.beginScratchSession("clip-direction");
    engine.completeScratchSession(
        sessionId, makeScratchBuffer(static_cast<int>(sampleRate), sampleRate), sampleRate);

    // Claim deck 1 — crossfader starts at 0.0.
    require(engine.scratchMidiSetTouch("dev-dir", scratch::DeckSide::deck1, true),
            "deck 1 claim should succeed for direction testing");
    requireNear(engine.getScratchSessionSnapshot()->crossfader, 0.0, 1.0e-12,
                "initial crossfader for deck 1 should be 0.0");

    require(engine.scratchMidiSetCrossfader("dev-dir", 0.5),
            "first directed physical position should apply");
    require(engine.scratchMidiSetCrossfader("dev-dir", 0.3),
            "subsequent directed physical position should follow");
    requireNear(engine.getScratchSessionSnapshot()->crossfader, 0.3, 1.0e-12,
                "crossfader should track every directed position");

    require(engine.setScratchMidiCrossfaderDirection("dev-dir", true),
            "runtime direction change should apply");
    requireNear(engine.getScratchSessionSnapshot()->crossfader, 0.3, 1.0e-12,
                "changing direction should preserve the displayed physical position");

    require(engine.scratchMidiSetCrossfader("dev-dir", 0.7),
            "reversed directed physical position should apply");
    requireNear(engine.getScratchSessionSnapshot()->crossfader, 0.3, 1.0e-12,
                "reversed MIDI value should render at its physical position");

    scratch::SessionControlPayload pointerFader;
    pointerFader.sessionId = sessionId;
    pointerFader.action = scratch::ControlAction::crossfader;
    pointerFader.crossfader = 0.8;
    require(engine.controlScratchSession(pointerFader),
            "virtual crossfader should apply with reversed direction");
    requireNear(engine.getScratchSessionSnapshot()->crossfader, 0.8, 1.0e-12,
                "virtual crossfader should remain under the pointer");

    MidiScratchRouter router;
    router.setEngine(engine);
    MidiScratchDeviceState routedState;
    routedState.reverseCrossfader = true;
    MidiControllerEvent routedEvent;
    routedEvent.action = MidiControllerAction::crossfader;
    routedEvent.kind = MidiControllerValueKind::absolute;
    routedEvent.value = 0.8;
    router.routeImmediate("dev-dir", routedState, 0, routedEvent, nullptr);
    requireNear(engine.getScratchSessionSnapshot()->crossfader, 0.8, 1.0e-12,
                "routed MIDI should publish the raw physical display position");
    require(engine.getScratchSessionSnapshot()->crossfaderReversed,
            "routed reversed crossfader move should report a reversed display");

    engine.closeScratchSession(sessionId);
}

void testScratchArmingStartsRecordingOnPointerTouch()
{
    constexpr double sampleRate = 48000.0;
    scratch::ScratchAudioSource source;
    source.prepareToPlay(512, sampleRate);
    scratch::BackingMonitorSource backing;
    scratch::ScratchSessionController controller(source, backing);
    const auto sessionId = controller.beginSession("clip-arm-touch");
    require(controller.completeSession(
                sessionId, makeScratchBuffer(static_cast<int>(sampleRate * 0.5), sampleRate),
                sampleRate),
            "scratch session should prepare for arming");

    scratch::SessionControlPayload arm;
    arm.sessionId = sessionId;
    arm.action = scratch::ControlAction::recordArm;
    require(controller.controlSession(arm), "arming should be accepted from ready");
    {
        const auto snap = controller.getSnapshot();
        require(snap && snap->armed, "snapshot should report armed state");
        require(snap->status == "ready",
                "arming alone should not start recording");
    }

    scratch::SessionControlPayload touch;
    touch.sessionId = sessionId;
    touch.action = scratch::ControlAction::platterTouch;
    touch.deck = scratch::DeckSide::deck1;
    touch.touched = true;
    require(controller.controlSession(touch),
            "first armed platter touch should claim the deck");
    const auto snap = controller.getSnapshot();
    require(snap && snap->status == "recording",
            "armed platter touch should begin recording");
    require(!snap->armed, "starting recording should clear the armed flag");

    scratch::SessionControlPayload stop;
    stop.sessionId = sessionId;
    stop.action = scratch::ControlAction::recordStop;
    require(controller.controlSession(stop), "recording should stop");
    require(controller.takeCompletedPattern().has_value(),
            "armed recording should yield a completed pattern");
}

void testScratchArmingStartsRecordingOnMidiMovement()
{
    constexpr double sampleRate = 48000.0;
    scratch::ScratchAudioSource source;
    source.prepareToPlay(512, sampleRate);
    scratch::BackingMonitorSource backing;
    scratch::ScratchSessionController controller(source, backing);
    const auto sessionId = controller.beginSession("clip-arm-move");
    require(controller.completeSession(
                sessionId, makeScratchBuffer(static_cast<int>(sampleRate * 0.5), sampleRate),
                sampleRate),
            "scratch session should prepare for movement arming");

    scratch::SessionControlPayload arm;
    arm.sessionId = sessionId;
    arm.action = scratch::ControlAction::recordArm;
    require(controller.controlSession(arm), "arming should be accepted");

    require(controller.midiMovePlatter("device-1", scratch::DeckSide::deck1, 0.1, 1000.0),
            "armed movement-only jog should claim and record");
    const auto snap = controller.getSnapshot();
    require(snap && snap->status == "recording",
            "armed movement should begin recording");
    require(!snap->armed, "movement start should clear the armed flag");

    scratch::SessionControlPayload disarm;
    disarm.sessionId = sessionId;
    disarm.action = scratch::ControlAction::recordDisarm;
    require(!controller.controlSession(disarm),
            "disarm should be rejected once recording has started");
}

void testScratchDisarmClearsArmedState()
{
    constexpr double sampleRate = 48000.0;
    scratch::ScratchAudioSource source;
    source.prepareToPlay(512, sampleRate);
    scratch::BackingMonitorSource backing;
    scratch::ScratchSessionController controller(source, backing);
    const auto sessionId = controller.beginSession("clip-disarm");
    require(controller.completeSession(
                sessionId, makeScratchBuffer(static_cast<int>(sampleRate * 0.5), sampleRate),
                sampleRate),
            "scratch session should prepare for disarm");

    scratch::SessionControlPayload arm;
    arm.sessionId = sessionId;
    arm.action = scratch::ControlAction::recordArm;
    require(controller.controlSession(arm), "arming should be accepted");
    require(controller.getSnapshot()->armed, "session should be armed");

    scratch::SessionControlPayload disarm = arm;
    disarm.action = scratch::ControlAction::recordDisarm;
    require(controller.controlSession(disarm), "disarm should be accepted while armed");
    require(!controller.getSnapshot()->armed, "disarm should clear the armed flag");
}

void addScratchSessionTests(std::vector<TestCase>& tests)
{
    tests.push_back({"scratch session audio transport and hold", testScratchAudioSourceTransport});
    tests.push_back({"scratch session lifecycle and deck ownership", testScratchSessionLifecycleAndOwnership});
    tests.push_back({"scratch session prepares and caches clip source", testScratchSourcePreparationCache});
    tests.push_back({"scratch source activate and deactivate cycle", testScratchSourceActivateDeactivate});
    tests.push_back({"scratch fixed topology session lifecycle", testScratchFixedTopologySession});
    tests.push_back({"scratch crossfader initial edge and tracking", testCrossfaderInitialEdgeAndTracking});
    tests.push_back({"scratch source activation race quiescence", testScratchSourceActivationRace});
    tests.push_back({"scratch session auto-stops at the forward end", testScratchSessionAutoStopsAtForwardEnd});
    tests.push_back({"scratch session play from end restarts from the beginning", testScratchSessionPlayFromEndRestartsFromBeginning});
    tests.push_back({"scratch MIDI crossfader works without platter ownership", testScratchMidiCrossfaderWorksWithoutPlatterOwnership});
    tests.push_back({"rapid MIDI crossfader coalesces to final value", testRapidMidiCrossfaderCoalescesToFinalValue});
    tests.push_back({"scratch play produces audio through the mixer", testScratchPlayProducesAudioThroughMixer});
    tests.push_back({"scratch pointer crossfader cut silences without platter touch", testScratchPointerCrossfaderCutSilencesWithoutTouch});
    tests.push_back({"scratch play from ready and paused starts and broadcasts state", testScratchPlayFromReadyAndPausedStartsAndBroadcastsState});
    tests.push_back({"scratch transport requires a prepared backing", testScratchTransportRequiresBacking});
    tests.push_back({"scratch repeat play-end cycles survive without deactivation", testScratchRepeatPlayEndCycles});
    tests.push_back({"scratch jog calibration tick-to-turn conversion", testScratchJogCalibration});
    tests.push_back({"scratch crossfader direction inversion with tracking", testScratchCrossfaderDirectionInversion});
    tests.push_back({"scratch arming starts recording on pointer touch", testScratchArmingStartsRecordingOnPointerTouch});
    tests.push_back({"scratch arming starts recording on MIDI movement", testScratchArmingStartsRecordingOnMidiMovement});
    tests.push_back({"scratch disarm clears armed state", testScratchDisarmClearsArmedState});
}

} // namespace silverdaw::tests
