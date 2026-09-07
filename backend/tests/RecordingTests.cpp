#include "TestRegistry.h"

#include "engine/ClockRateEstimator.h"
#include "recording/CalibrationClickSource.h"
#include "recording/CaptureDevice.h"
#include "recording/InputCaptureTap.h"
#include "recording/LatencyCalibration.h"
#include "recording/LatencyCalibrator.h"
#include "recording/RecordingCleanup.h"
#include "recording/RecordingFinalise.h"
#include "recording/RecordingSessionController.h"
#include "recording/RecordingWriter.h"

#include <cmath>
#include <memory>
#include <vector>

namespace silverdaw::tests
{
namespace
{
using silverdaw::recording::finaliseRecording;
using silverdaw::recording::InputCaptureTap;
using silverdaw::recording::RecordingWriter;

constexpr double kSampleRate = 48000.0;

juce::AudioFormatManager& formats()
{
    static juce::AudioFormatManager manager;
    if (manager.getNumKnownFormats() == 0) manager.registerBasicFormats();
    return manager;
}

// A ramp is the easiest signal to assert alignment on: the sample value is the
// sample index, so a trim of N samples is visible as a first sample of N.
void writeRamp(const juce::File& file, int numSamples, int channels, double sampleRate)
{
    juce::WavAudioFormat wav;
    std::unique_ptr<juce::OutputStream> stream(file.createOutputStream());
    const auto options = juce::AudioFormatWriterOptions{}
                             .withSampleRate(sampleRate)
                             .withNumChannels(channels)
                             .withBitsPerSample(24);
    std::unique_ptr<juce::AudioFormatWriter> writer(wav.createWriterFor(stream, options));
    require(writer != nullptr, "test ramp writer should be created");

    juce::AudioBuffer<float> buffer(channels, numSamples);
    for (int channel = 0; channel < channels; ++channel)
        for (int i = 0; i < numSamples; ++i)
            buffer.setSample(channel, i, static_cast<float>(i) / static_cast<float>(numSamples));
    require(writer->writeFromAudioSampleBuffer(buffer, 0, numSamples), "test ramp should be written");
}

std::unique_ptr<juce::AudioFormatReader> readerFor(const juce::File& file)
{
    return std::unique_ptr<juce::AudioFormatReader>(formats().createReaderFor(file));
}

void testWriterProducesReadableFile()
{
    const auto dir = makeTempDir("recording-writer");
    const auto file = dir.getChildFile("capture.wav");

    RecordingWriter writer;
    juce::String error;
    require(writer.start(file, kSampleRate, 1, static_cast<juce::int64>(kSampleRate), error),
            "writer should start on a writable volume");

    juce::AudioBuffer<float> block(1, 512);
    block.clear();
    const float* channels[] = {block.getReadPointer(0)};
    for (int i = 0; i < 10; ++i)
        require(writer.getThreadedWriter()->write(channels, block.getNumSamples()),
                "the threaded writer should accept blocks");

    require(writer.finish(), "a writer that received audio should finish successfully");
    require(file.existsAsFile(), "the finished recording should exist on disk");

    const auto reader = readerFor(file);
    require(reader != nullptr, "the finished recording should be readable");
    requireNear(static_cast<double>(reader->lengthInSamples), 5120.0, 1.0,
                "every written block should reach the file");

    dir.deleteRecursively();
}

void testWriterAbortLeavesNothingBehind()
{
    const auto dir = makeTempDir("recording-writer-abort");
    const auto file = dir.getChildFile("capture.wav");

    RecordingWriter writer;
    juce::String error;
    require(writer.start(file, kSampleRate, 1, 1024, error), "writer should start");
    writer.abort();
    require(! file.existsAsFile(), "an aborted recording must not be left on disk");

    dir.deleteRecursively();
}

void testCaptureTapWritesSelectedChannelsOnly()
{
    const auto dir = makeTempDir("recording-tap");
    const auto file = dir.getChildFile("capture.wav");

    RecordingWriter writer;
    juce::String error;
    require(writer.start(file, kSampleRate, 1, 4096, error), "writer should start");

    InputCaptureTap tap;
    tap.setChannelSelection(2, 1);
    tap.setWriter(writer.getThreadedWriter());

    // Four device inputs; only the third carries signal, and it is the one asked for.
    juce::AudioBuffer<float> input(4, 256);
    input.clear();
    for (int i = 0; i < input.getNumSamples(); ++i)
        input.setSample(2, i, 0.5F);
    const float* inputs[] = {input.getReadPointer(0), input.getReadPointer(1),
                             input.getReadPointer(2), input.getReadPointer(3)};

    const juce::AudioIODeviceCallbackContext context{};
    tap.audioDeviceIOCallbackWithContext(inputs, 4, nullptr, 0, input.getNumSamples(), context);

    requireNear(static_cast<double>(tap.getCapturedSamples()), 256.0, 0.0,
                "the tap should count the samples it handed to the writer");
    require(tap.hasSeenAnySignal(), "a non-silent selected channel should register as signal");

    float peakL = 0.0F;
    float peakR = 0.0F;
    tap.consumePeaks(peakL, peakR);
    requireNear(peakL, 0.5F, 1.0e-6, "the input peak should follow the selected channel");
    requireNear(peakR, 0.5F, 1.0e-6, "a mono selection should meter the same value on both lanes");

    tap.setWriter(nullptr);
    require(writer.finish(), "the tap's audio should finish as a usable file");

    const auto reader = readerFor(file);
    require(reader != nullptr, "the captured file should be readable");
    require(reader->numChannels == 1, "a single selected channel should produce a mono file");

    dir.deleteRecursively();
}

void testCaptureTapDetectsSilentInput()
{
    InputCaptureTap tap;
    juce::AudioBuffer<float> input(1, 128);
    input.clear();
    const float* inputs[] = {input.getReadPointer(0)};
    const juce::AudioIODeviceCallbackContext context{};
    tap.audioDeviceIOCallbackWithContext(inputs, 1, nullptr, 0, input.getNumSamples(), context);

    require(! tap.hasSeenAnySignal(),
            "digital silence must stay detectable — it is the missing-consent signature");
}

void testCaptureTapStopsAtLengthCap()
{
    const auto dir = makeTempDir("recording-tap-cap");
    const auto file = dir.getChildFile("capture.wav");

    RecordingWriter writer;
    juce::String error;
    require(writer.start(file, kSampleRate, 1, 4096, error), "writer should start");

    InputCaptureTap tap;
    tap.setChannelSelection(0, 1);
    tap.setMaxSamples(300);
    tap.setWriter(writer.getThreadedWriter());

    juce::AudioBuffer<float> input(1, 256);
    for (int i = 0; i < input.getNumSamples(); ++i)
        input.setSample(0, i, 0.25F);
    const float* inputs[] = {input.getReadPointer(0)};
    const juce::AudioIODeviceCallbackContext context{};
    for (int block = 0; block < 3; ++block)
        tap.audioDeviceIOCallbackWithContext(inputs, 1, nullptr, 0, input.getNumSamples(), context);

    requireNear(static_cast<double>(tap.getCapturedSamples()), 300.0, 0.0,
                "the length cap should bound the captured audio exactly");
    require(tap.hasHitLengthCap(), "reaching the cap should be reported, not silently ignored");

    tap.setWriter(nullptr);
    writer.finish();
    dir.deleteRecursively();
}

void testCountInLeavesTheAnchorAloneAndCostsTheTakeNothing()
{
    using silverdaw::recording::countInLengthMs;
    constexpr double bar = 2000.0;

    // The count-in clicks with the transport parked, so its length is simply the bars
    // asked for — it never has to be found in front of the anchor, and **From Start**
    // still records from 0 ms instead of starting a bar late.
    requireNear(countInLengthMs(1, bar), bar, 0.0, "one bar of count-in is one bar long");
    requireNear(countInLengthMs(0, bar), 0.0, 0.0, "no count-in is no time at all");
    requireNear(countInLengthMs(-1, bar), 0.0, 0.0, "a negative bar count cannot borrow time");
    requireNear(countInLengthMs(1, 0.0), 0.0, 0.0, "an unusable tempo yields no count-in");
}

void testRecordWindowAnchorsWhereTheModeSays()
{
    using silverdaw::recording::resolveRecordWindow;

    const auto fromStart = resolveRecordWindow("start", 9000.0, true, 1000.0, 5000.0);
    require(fromStart.mode == "start" && fromStart.anchorMs == 0.0 && ! fromStart.endMs.has_value(),
            "From Start records from the top whatever the playhead and selection are doing");

    const auto fromPlayhead = resolveRecordWindow("playhead", 9000.0, true, 1000.0, 5000.0);
    require(fromPlayhead.anchorMs == 9000.0 && ! fromPlayhead.endMs.has_value(),
            "From Playhead anchors where the playhead is and runs until it is stopped");
    require(resolveRecordWindow("playhead", -50.0, false, 0.0, 0.0).anchorMs == 0.0,
            "a playhead before the project start still anchors at the start");

    const auto range = resolveRecordWindow("selection", 9000.0, true, 1000.0, 5000.0);
    require(range.anchorMs == 1000.0 && range.endMs == 5000.0,
            "a range window takes both its ends from the timeline selection");

    const auto lost = resolveRecordWindow("selection", 9000.0, false, 0.0, 0.0);
    require(lost.mode == "playhead" && lost.anchorMs == 9000.0 && ! lost.endMs.has_value(),
            "a range that has been cleared falls back to the playhead, not to a stale span");

    require(resolveRecordWindow("start", 9000.0, false, 0.0, 0.0).mode == "start",
            "having no selection is no reason to disturb From Start");
}

void testCaptureTapAppliesInputGain()
{
    const auto dir = makeTempDir("recording-tap-gain");
    const auto file = dir.getChildFile("capture.wav");

    RecordingWriter writer;
    juce::String error;
    require(writer.start(file, kSampleRate, 1, 4096, error), "writer should start");

    InputCaptureTap tap;
    tap.audioDeviceAboutToStart(nullptr);
    tap.setChannelSelection(0, 1);
    tap.setGain(2.0F);
    tap.setWriter(writer.getThreadedWriter());

    juce::AudioBuffer<float> input(1, 256);
    for (int i = 0; i < input.getNumSamples(); ++i)
        input.setSample(0, i, 0.25F);
    const float* inputs[] = {input.getReadPointer(0)};
    const juce::AudioIODeviceCallbackContext context{};
    tap.audioDeviceIOCallbackWithContext(inputs, 1, nullptr, 0, input.getNumSamples(), context);

    float peakL = 0.0F;
    float peakR = 0.0F;
    tap.consumePeaks(peakL, peakR);
    requireNear(peakL, 0.5F, 1.0e-6,
                "the meter must show the gain-applied level, not the raw input");

    tap.setWriter(nullptr);
    require(writer.finish(), "the gained capture should finish as a usable file");

    const auto reader = readerFor(file);
    require(reader != nullptr, "the captured file should be readable");
    juce::AudioBuffer<float> written(1, 256);
    reader->read(&written, 0, 256, 0, true, false);
    requireNear(written.getSample(0, 128), 0.5F, 1.0e-4,
                "the gain must be written into the file, not only metered");

    dir.deleteRecursively();
}

void testFinaliseTrimsLatencyFromTheHead()
{
    const auto dir = makeTempDir("recording-finalise-latency");
    const auto source = dir.getChildFile("raw.wav");
    const auto destination = dir.getChildFile("final.wav");
    const int sourceSamples = 48000;
    writeRamp(source, sourceSamples, 1, kSampleRate);

    silverdaw::recording::FinaliseRequest request;
    request.sourceFile = source;
    request.destinationFile = destination;
    request.nominalSampleRate = kSampleRate;
    request.measuredSampleRate = kSampleRate;
    request.latencyMs = 100.0;

    const auto result = finaliseRecording(request, formats());
    require(result.ok, "finalise should succeed on a valid recording");
    requireNear(result.latencyOffsetMs, 100.0, 0.001, "the reported trim should match the request");

    const auto reader = readerFor(destination);
    require(reader != nullptr, "the finalised recording should be readable");
    requireNear(static_cast<double>(reader->lengthInSamples), sourceSamples - 4800.0, 1.0,
                "the head trim should shorten the file by exactly the latency");

    juce::AudioBuffer<float> head(1, 1);
    reader->read(&head, 0, 1, 0, true, true);
    requireNear(head.getSample(0, 0), 4800.0F / static_cast<float>(sourceSamples), 1.0e-3,
                "the finalised file should start where the performer was actually heard");

    dir.deleteRecursively();
}

void testFinaliseCorrectsClockDrift()
{
    const auto dir = makeTempDir("recording-finalise-drift");
    const auto source = dir.getChildFile("raw.wav");
    const auto destination = dir.getChildFile("final.wav");
    const int sourceSamples = 48000;
    writeRamp(source, sourceSamples, 1, kSampleRate);

    silverdaw::recording::FinaliseRequest request;
    request.sourceFile = source;
    request.destinationFile = destination;
    request.nominalSampleRate = kSampleRate;
    // A capture clock running fast delivers more samples than the wall clock
    // says it should, so the finished file has to be shortened to stay in time.
    request.measuredSampleRate = kSampleRate * 1.001;
    request.latencyMs = 0.0;

    const auto result = finaliseRecording(request, formats());
    require(result.ok, "finalise should succeed with a drift correction");
    requireNear(result.driftPpm, 1000.0, 1.0, "the reported drift should match the measurement");

    const auto reader = readerFor(destination);
    require(reader != nullptr, "the drift-corrected recording should be readable");
    requireNear(static_cast<double>(reader->lengthInSamples), sourceSamples / 1.001, 2.0,
                "drift correction should resample to the measured ratio");

    dir.deleteRecursively();
}

// Drift is a RATIO between two clocks, not a departure from nominal. Two devices that run
// fast by the same amount stay in step with each other, and resampling for their shared
// offset would introduce the very error the correction exists to remove.
void testFinaliseDriftIsMeasuredAgainstTheOutputClock()
{
    const auto dir = makeTempDir("recording-finalise-relative-drift");
    const auto source = dir.getChildFile("raw.wav");
    const int sourceSamples = 48000;
    writeRamp(source, sourceSamples, 1, kSampleRate);

    silverdaw::recording::FinaliseRequest request;
    request.sourceFile = source;
    request.destinationFile = dir.getChildFile("together.wav");
    request.nominalSampleRate = kSampleRate;
    request.measuredSampleRate = kSampleRate * 1.001;
    request.timelineSampleRate = kSampleRate * 1.001;
    request.latencyMs = 0.0;

    auto result = finaliseRecording(request, formats());
    require(result.ok, "finalise should succeed when both clocks agree with each other");
    requireNear(result.driftPpm, 0.0, 1.0, "clocks that agree with each other should show no drift");
    auto reader = readerFor(request.destinationFile);
    require(reader != nullptr, "the untouched recording should be readable");
    requireNear(static_cast<double>(reader->lengthInSamples), sourceSamples, 2.0,
                "a take that never drifted against the timeline should not be resampled");

    // A slow output clock makes the arrangement take longer in wall-clock terms than the
    // capture did, so the take has to be stretched to keep up with it.
    request.destinationFile = dir.getChildFile("apart.wav");
    request.timelineSampleRate = kSampleRate;
    result = finaliseRecording(request, formats());
    require(result.ok, "finalise should succeed when the clocks disagree");
    requireNear(result.driftPpm, 1000.0, 1.0, "drift should be the ratio between the two clocks");
    reader = readerFor(request.destinationFile);
    require(reader != nullptr, "the drift-corrected recording should be readable");
    requireNear(static_cast<double>(reader->lengthInSamples), sourceSamples / 1.001, 2.0,
                "the take should be resampled by the ratio between the clocks");

    dir.deleteRecursively();
}

void testClockRateEstimatorRecoversTheRateAndItsUncertainty()
{
    const auto perSecond =
        static_cast<double>(juce::Time::getHighResolutionTicksPerSecond());
    const double trueRate = 48000.0 * 1.00005; // 50 ppm fast, a realistic crystal error.
    constexpr int kBlock = 480;

    const auto feed = [&](silverdaw::ClockRateEstimator& estimator, int blocks, double noiseMs)
    {
        juce::Random random(1234);
        for (int i = 0; i < blocks; ++i)
        {
            const double frames = static_cast<double>(i) * kBlock;
            const double noise = (random.nextDouble() - 0.5) * 2.0 * noiseMs / 1000.0;
            const double ticks = (frames / trueRate + noise) * perSecond;
            estimator.addBlock(static_cast<juce::int64>(frames),
                               static_cast<juce::int64>(ticks));
        }
    };

    silverdaw::ClockRateEstimator tooShort;
    feed(tooShort, 8, 0.0);
    require(! tooShort.estimate().usable,
            "an estimate should be refused before there are enough points to trust it");

    silverdaw::ClockRateEstimator brief;
    feed(brief, 500, 1.0); // ~5 seconds.
    const auto briefEstimate = brief.estimate();
    require(briefEstimate.usable, "five seconds of blocks should produce an estimate");

    silverdaw::ClockRateEstimator long_;
    feed(long_, 6000, 1.0); // ~60 seconds.
    const auto longEstimate = long_.estimate();
    require(longEstimate.usable, "a minute of blocks should produce an estimate");
    requireNear(longEstimate.rate, trueRate, 5.0, "the fitted rate should recover the true rate");
    require(longEstimate.ppmStdError < briefEstimate.ppmStdError,
            "a longer measurement should report a tighter uncertainty");
    require(longEstimate.ppmStdError < 5.0,
            "a minute of blocks should resolve a 50 ppm error comfortably");

    // A stalled callback displaces one stamp without changing the rate; it must not tilt
    // the line, because a resample driven by a stall is worse than no correction at all.
    silverdaw::ClockRateEstimator stalled;
    feed(stalled, 6000, 1.0);
    stalled.addBlock(static_cast<juce::int64>(6000) * kBlock,
                     static_cast<juce::int64>((6000.0 * kBlock / trueRate + 0.5) * perSecond));
    requireNear(stalled.estimate().rate, trueRate, 5.0,
                "a single stalled callback should be discarded rather than tilt the fit");
}

void testFinaliseTrimsHeadInTheCapturedDomain()
{
    const auto dir = makeTempDir("recording-finalise-head-domain");
    const auto source = dir.getChildFile("raw.wav");
    const auto destination = dir.getChildFile("final.wav");
    const int sourceSamples = 96000;
    writeRamp(source, sourceSamples, 1, kSampleRate);

    silverdaw::recording::FinaliseRequest request;
    request.sourceFile = source;
    request.destinationFile = destination;
    request.nominalSampleRate = kSampleRate;
    // A capture clock running 1000 ppm fast: one second of wall time holds 1.001
    // seconds' worth of raw samples.
    request.measuredSampleRate = kSampleRate * 1.001;
    request.latencyMs = 100.0;

    const auto result = finaliseRecording(request, formats());
    require(result.ok, "finalise should succeed with both a head trim and a drift correction");

    const auto reader = readerFor(destination);
    require(reader != nullptr, "the finalised recording should be readable");

    // The head trim happens before resampling, so it must be converted at the measured
    // rate: trimming `latencyMs * nominalRate` raw samples would remove the wrong span
    // of captured time. What survives is (source - measuredTrim) resampled by the ratio.
    const double measuredTrim = 100.0 * (kSampleRate * 1.001) / 1000.0;
    const double expected = (sourceSamples - measuredTrim) / 1.001;
    requireNear(static_cast<double>(reader->lengthInSamples), expected, 2.0,
                "the head trim should be taken in the captured domain, not the nominal one");

    dir.deleteRecursively();
}

void testFinaliseRejectsRecordingShorterThanLatency()
{
    const auto dir = makeTempDir("recording-finalise-short");
    const auto source = dir.getChildFile("raw.wav");
    writeRamp(source, 480, 1, kSampleRate);

    silverdaw::recording::FinaliseRequest request;
    request.sourceFile = source;
    request.destinationFile = dir.getChildFile("final.wav");
    request.nominalSampleRate = kSampleRate;
    request.measuredSampleRate = kSampleRate;
    request.latencyMs = 100.0;

    const auto result = finaliseRecording(request, formats());
    require(! result.ok, "a recording shorter than the latency trim cannot be finalised");
    require(result.error.isNotEmpty(), "a failed finalise should say what went wrong");

    dir.deleteRecursively();
}

void testFinaliseKeepsStereoChannels()
{
    const auto dir = makeTempDir("recording-finalise-stereo");
    const auto source = dir.getChildFile("raw.wav");
    const auto destination = dir.getChildFile("final.wav");
    writeRamp(source, 24000, 2, kSampleRate);

    silverdaw::recording::FinaliseRequest request;
    request.sourceFile = source;
    request.destinationFile = destination;
    request.nominalSampleRate = kSampleRate;
    request.measuredSampleRate = kSampleRate;
    request.latencyMs = 0.0;

    const auto result = finaliseRecording(request, formats());
    require(result.ok, "a stereo recording should finalise");
    require(result.channelCount == 2, "finalise must not collapse a stereo pair");
    requireNear(result.durationMs, 500.0, 1.0, "the reported duration should match the audio");

    dir.deleteRecursively();
}

void testFinaliseTrimsTailToTheExactMusicalLength()
{
    const auto dir = makeTempDir("recording-finalise-exact");
    const auto source = dir.getChildFile("raw.wav");
    const auto destination = dir.getChildFile("final.wav");
    // 1s of audio for a 500ms window: the capture always overruns the window end.
    writeRamp(source, 48000, 1, kSampleRate);

    silverdaw::recording::FinaliseRequest request;
    request.sourceFile = source;
    request.destinationFile = destination;
    request.nominalSampleRate = kSampleRate;
    request.measuredSampleRate = kSampleRate;
    request.latencyMs = 0.0;
    request.exactDurationMs = 500.0;

    const auto result = finaliseRecording(request, formats());
    require(result.ok, "finalise should succeed when trimming to an exact length");
    require(result.exactLength, "trimming to the requested length should be reported");
    requireNear(result.durationMs, 500.0, 0.05,
                "a claimed beat count is only true if the file is exactly that long");

    const auto reader = readerFor(destination);
    require(reader != nullptr, "the trimmed recording should be readable");
    requireNear(static_cast<double>(reader->lengthInSamples), 24000.0, 1.0,
                "the tail past the window end should be removed");

    dir.deleteRecursively();
}

void testFinaliseLeavesShortRecordingUntrimmed()
{
    const auto dir = makeTempDir("recording-finalise-exact-short");
    const auto source = dir.getChildFile("raw.wav");
    const auto destination = dir.getChildFile("final.wav");
    writeRamp(source, 12000, 1, kSampleRate);

    silverdaw::recording::FinaliseRequest request;
    request.sourceFile = source;
    request.destinationFile = destination;
    request.nominalSampleRate = kSampleRate;
    request.measuredSampleRate = kSampleRate;
    request.latencyMs = 0.0;
    request.exactDurationMs = 500.0;

    const auto result = finaliseRecording(request, formats());
    require(result.ok, "a short recording should still finalise");
    require(! result.exactLength,
            "material shorter than the window must not be reported as an exact length");
    requireNear(result.durationMs, 250.0, 1.0, "finalise must never pad a short recording");

    dir.deleteRecursively();
}

void testSessionBorrowsTheMetronomeInBothDirections()
{
    using silverdaw::recording::sessionMetronomeEnabled;

    require(sessionMetronomeEnabled("countIn", false),
            "a count-in must click even when the session's click is off");
    require(! sessionMetronomeEnabled("review", true),
            "review must not click over a take, whatever the session asked for");
    require(sessionMetronomeEnabled("recording", true),
            "Click While Recording is the session's own setting through the take");
    require(! sessionMetronomeEnabled("recording", false),
            "a recording must not click when the session's click is off");
    require(sessionMetronomeEnabled("idle", true),
            "an idle session keeps the click it was opened with");
    require(sessionMetronomeEnabled("finalising", true),
            "the click comes back as soon as the take is over");
}

void testBackingIsBorrowedInBothDirections()
{
    using silverdaw::recording::backingTrackAudible;

    require(backingTrackAudible(true, true, true), "a chosen track the project plays must be heard");
    require(! backingTrackAudible(true, false, true),
            "a track left out of the backing must be silent for the take");
    require(backingTrackAudible(true, true, false),
            "a muted track ticked into the backing must be heard for the take");
    require(! backingTrackAudible(true, false, false),
            "a muted track left out of the backing stays silent");
    require(backingTrackAudible(false, false, true),
            "with no session the project alone decides, whatever the last selection was");
    require(! backingTrackAudible(false, true, false),
            "closing the dialog must hand a muted track straight back to the project");
}

void testBackingLevelIsSessionScoped()
{
    using silverdaw::recording::sessionBackingGain;

    require(sessionBackingGain(true, 0.25) == 0.25,
            "an open session sets the level the backing plays at");
    require(sessionBackingGain(true, 0.0) == 0.0,
            "a backing turned all the way down must be silent, not unity");
    require(sessionBackingGain(false, 0.25) == 1.0,
            "closing the dialog must return the arrangement to its own level");
}

void testMonitorIsSessionScopedAndSilentInReview()
{
    using silverdaw::recording::sessionMonitorAudible;

    require(sessionMonitorAudible(true, true, "recording"),
            "a performer who asked to hear themselves must hear themselves");
    require(! sessionMonitorAudible(true, false, "recording"),
            "monitoring is opt-in and must stay off until it is asked for");
    require(! sessionMonitorAudible(true, true, "review"),
            "an open monitor over a take playing back is a feedback loop");
    require(! sessionMonitorAudible(false, true, "recording"),
            "nothing should be listening to an input once the dialog has gone");
}

void testRecordingModeDecidesMusicality()
{
    using silverdaw::recording::recordingModeIsMusical;

    require(recordingModeIsMusical("music"), "a music take carries the project tempo");
    require(! recordingModeIsMusical("simple"),
            "a simple take must carry no tempo, so nothing draws beat markers on it");
    require(recordingModeIsMusical(""),
            "an unrecognised mode must fall back to musical, not silently drop the tempo");
}

void testCleanupFindsTheNoiseFloorFromQuietWindows()
{
    using silverdaw::recording::noiseFloorDbFromWindowRms;

    // Mostly performance with a quiet bed under it: the floor is the bed, not the
    // average and not the single quietest block.
    std::vector<float> windows(100, 0.5F);
    for (int i = 0; i < 12; ++i)
        windows[static_cast<std::size_t>(i)] = 0.01F;
    const auto floorDb = noiseFloorDbFromWindowRms(windows);
    require(floorDb < -35.0 && floorDb > -45.0,
            "the floor should measure the quiet bed, around -40 dB");

    std::vector<float> empty;
    require(noiseFloorDbFromWindowRms(empty) <= -100.0,
            "a take with no windows has nothing to remove");
}

void testCleanupExpanderLeavesThePerformanceAlone()
{
    using silverdaw::recording::expanderGain;
    using silverdaw::recording::kMaxReductionDb;

    require(expanderGain(-6.0, -50.0) == 1.0F,
            "a signal above the threshold must pass through untouched");
    require(expanderGain(-50.0, -50.0) == 1.0F, "the threshold itself is not attenuated");

    const auto deep = expanderGain(-90.0, -50.0);
    const auto expected =
        static_cast<float>(juce::Decibels::decibelsToGain(-kMaxReductionDb));
    require(std::abs(deep - expected) < 1.0e-5F,
            "material far below the threshold is attenuated, but only to the cap");
    require(deep > 0.0F, "the expander must never gate to digital silence");

    const auto partial = expanderGain(-54.0, -50.0);
    require(partial < 1.0F && partial > deep,
            "a word tail just under the threshold is attenuated gradually");
}

// The residual stage, stated as audio: a noise bed either side of a phrase has to
// come down, and the phrase itself has to come through at the level it was
// performed at. This is the stage that runs *after* the denoiser has taken the
// bed out from under the performance, so what it is asked to remove here is what
// the denoiser left between phrases.
void testCleanupRemovesTheBedAndKeepsThePerformance()
{
    using silverdaw::recording::expandBelowFloorInPlace;
    using silverdaw::recording::kMaxReductionDb;
    using silverdaw::recording::kThresholdAboveFloorDb;
    using silverdaw::recording::measureNoiseFloorDb;

    constexpr int kSeconds = 3;
    const int total = static_cast<int>(kSampleRate) * kSeconds;
    const int toneStart = total / 3;
    const int toneEnd = 2 * total / 3;

    // A hiss bed all the way through, with a sung note over the middle third.
    juce::Random random(20260906);
    const double bedAmplitude = juce::Decibels::decibelsToGain(-52.0);
    const double toneAmplitude = juce::Decibels::decibelsToGain(-12.0);
    juce::AudioBuffer<float> audio(1, total);
    auto* samples = audio.getWritePointer(0);
    for (int i = 0; i < total; ++i)
    {
        double value = bedAmplitude * (random.nextDouble() * 2.0 - 1.0);
        if (i >= toneStart && i < toneEnd)
            value += toneAmplitude
                     * std::sin(2.0 * juce::MathConstants<double>::pi * 440.0 * i / kSampleRate);
        samples[i] = static_cast<float>(value);
    }

    const auto rmsDb = [](const juce::AudioBuffer<float>& buffer, int start, int length)
    {
        return juce::Decibels::gainToDecibels(buffer.getRMSLevel(0, start, length));
    };
    // Away from the transitions, where the envelope is deliberately still moving.
    const int settle = static_cast<int>(kSampleRate) / 4;
    const int gapStart = settle;
    const int gapLength = toneStart - gapStart - settle;
    const int toneMeasureStart = toneStart + settle;
    const int toneMeasureLength = toneEnd - toneMeasureStart - settle;

    const auto bedBefore = rmsDb(audio, gapStart, gapLength);
    const auto toneBefore = rmsDb(audio, toneMeasureStart, toneMeasureLength);

    const auto floorDb = measureNoiseFloorDb(audio, kSampleRate);
    expandBelowFloorInPlace(audio, kSampleRate, floorDb + kThresholdAboveFloorDb);

    const auto bedAfter = rmsDb(audio, gapStart, gapLength);
    const auto toneAfter = rmsDb(audio, toneMeasureStart, toneMeasureLength);

    require(bedBefore - bedAfter > 4.0,
            "the bed in the gaps must come down by an amount the user would hear");
    require(bedAfter > -140.0, "the gaps must keep room tone, not become digital silence");
    require(bedBefore - bedAfter <= kMaxReductionDb + 3.0,
            "the reduction must stay bounded, so a gap still sounds like a room");
    require(std::abs(toneBefore - toneAfter) < 1.0,
            "the performance must come through at the level it was performed at");
}

// The timing, which is what made the old expander inaudible: it has to close
// inside the gap between two words rather than only between phrases, and it has
// to open again fast enough that the next word starts at full level.
void testCleanupExpanderClosesInAShortGapAndOpensOnTime()
{
    using silverdaw::recording::expandBelowFloorInPlace;
    using silverdaw::recording::kThresholdAboveFloorDb;
    using silverdaw::recording::measureNoiseFloorDb;

    const int rate = static_cast<int>(kSampleRate);
    const int phrase = rate / 2;      // half a second of word
    const int gap = (rate * 3) / 10;  // 300 ms between the two, as speech has
    const int total = phrase + gap + phrase;
    const int secondPhraseStart = phrase + gap;

    juce::Random random(20260908);
    const double bedAmplitude = juce::Decibels::decibelsToGain(-52.0);
    const double toneAmplitude = juce::Decibels::decibelsToGain(-12.0);
    juce::AudioBuffer<float> audio(1, total);
    auto* samples = audio.getWritePointer(0);
    for (int i = 0; i < total; ++i)
    {
        double value = bedAmplitude * (random.nextDouble() * 2.0 - 1.0);
        if (i < phrase || i >= secondPhraseStart)
            value += toneAmplitude
                     * std::sin(2.0 * juce::MathConstants<double>::pi * 440.0 * i / kSampleRate);
        samples[i] = static_cast<float>(value);
    }

    const auto rmsDb = [](const juce::AudioBuffer<float>& buffer, int start, int length)
    {
        return juce::Decibels::gainToDecibels(buffer.getRMSLevel(0, start, length));
    };
    // The last third of the gap, by which time a release measured in tens of
    // milliseconds has had every chance to close.
    const int gapMeasureStart = phrase + (gap * 2) / 3;
    const int gapMeasureLength = gap / 3;
    // The first 50 ms of the next word, which is where a gain that opens on the
    // release coefficient audibly ducks the start of the phrase.
    const int onsetLength = rate / 20;

    const auto gapBefore = rmsDb(audio, gapMeasureStart, gapMeasureLength);
    const auto onsetBefore = rmsDb(audio, secondPhraseStart, onsetLength);

    const auto floorDb = measureNoiseFloorDb(audio, kSampleRate);
    expandBelowFloorInPlace(audio, kSampleRate, floorDb + kThresholdAboveFloorDb);

    const auto gapAfter = rmsDb(audio, gapMeasureStart, gapMeasureLength);
    const auto onsetAfter = rmsDb(audio, secondPhraseStart, onsetLength);

    require(gapBefore - gapAfter > 4.0,
            "the expander must close inside a gap between words, not only between phrases");
    require(onsetBefore - onsetAfter < 1.0,
            "the word after the gap must start at full level, not fade in");
}

// The whole chain over a real file, which is the only thing that proves the
// denoiser stage is actually reached: a take is read, high-passed, denoised,
// expanded and written back in place, and what comes back is still a playable
// file of the same shape holding the performance it went in with.
void testCleanupRewritesTheTakeInPlace()
{
    const auto dir = makeTempDir("recording-cleanup");
    const auto file = dir.getChildFile("take.wav");

    const int total = static_cast<int>(kSampleRate) * 2;
    const int toneStart = total / 3;
    const int toneEnd = 2 * total / 3;
    juce::Random random(20260909);
    const double bedAmplitude = juce::Decibels::decibelsToGain(-52.0);
    const double toneAmplitude = juce::Decibels::decibelsToGain(-12.0);
    {
        juce::WavAudioFormat wav;
        std::unique_ptr<juce::OutputStream> stream(file.createOutputStream());
        const auto options = juce::AudioFormatWriterOptions{}
                                 .withSampleRate(kSampleRate)
                                 .withNumChannels(1)
                                 .withBitsPerSample(24);
        std::unique_ptr<juce::AudioFormatWriter> writer(wav.createWriterFor(stream, options));
        require(writer != nullptr, "cleanup test writer should be created");
        juce::AudioBuffer<float> buffer(1, total);
        for (int i = 0; i < total; ++i)
        {
            double value = bedAmplitude * (random.nextDouble() * 2.0 - 1.0);
            if (i >= toneStart && i < toneEnd)
                value += toneAmplitude
                         * std::sin(2.0 * juce::MathConstants<double>::pi * 440.0 * i
                                    / kSampleRate);
            buffer.setSample(0, i, static_cast<float>(value));
        }
        require(writer->writeFromAudioSampleBuffer(buffer, 0, total),
                "cleanup test take should be written");
    }

    silverdaw::recording::CleanupRequest request;
    request.file = file;
    request.sampleRate = kSampleRate;
    const auto result = silverdaw::recording::cleanRecording(request, formats());

    require(result.ok, "a readable take should clean without error");
    require(! result.skipped, "a take with an audible bed should not be skipped");
    require(result.noiseFloorDb > -75.0 && result.noiseFloorDb < -30.0,
            "the measured floor should land on the bed that was written");
    require(result.residualFloorDb < result.noiseFloorDb - 6.0,
            "the denoiser stage must measurably lower the bed before the expander runs");
    require(! dir.getChildFile("take.cleanup.wav").existsAsFile(),
            "the temporary file should not be left behind");

    const auto reader = readerFor(file);
    require(reader != nullptr, "the cleaned take should still be readable");
    require(reader->lengthInSamples == total, "cleanup must not change the take's length");
    require(static_cast<int>(reader->numChannels) == 1, "cleanup must not change the channels");

    juce::AudioBuffer<float> cleaned(1, total);
    require(reader->read(&cleaned, 0, total, 0, true, true), "the cleaned take should read back");
    const int settle = static_cast<int>(kSampleRate) / 4;
    const auto toneDb = juce::Decibels::gainToDecibels(
        cleaned.getRMSLevel(0, toneStart + settle, toneEnd - toneStart - 2 * settle));
    require(toneDb > -30.0, "the performance must survive the whole chain");
}

// What a dialog with nothing remembered offers: a take over the whole
// arrangement from the top, no click and no count-in, nothing monitored, and a
// musical take kept exactly as it was performed. The backing is seeded from the
// project by `open`, so "match the arrangement" is the one default that cannot be
// a constant here.
void testFreshSessionDefaults()
{    const silverdaw::recording::RecordingStateSnapshot fresh;

    require(fresh.windowMode == "start", "a fresh dialog records from the start of the project");
    require(fresh.countInBars == 0, "a fresh dialog counts nobody in");
    require(! fresh.clickEnabled, "a fresh dialog does not click through the take");
    require(! fresh.monitorEnabled, "a fresh dialog does not monitor the input");
    require(! fresh.cleanupEnabled, "a fresh dialog keeps the take exactly as performed");
    require(fresh.recordingMode == "music", "a fresh dialog records to the project's tempo");
    require(fresh.backingGain == 1.0, "a fresh dialog plays the backing at its own level");
    require(fresh.inputGainDb == 0.0, "a fresh dialog does not trim the input");
}

// The stereo option must not change the performance, only how many copies of it
// the file holds: both channels have to be the mono take, sample for sample.
void testDuplicateMonoToStereoCopiesTheTake()
{
    const auto dir = makeTempDir("recording-stereo-duplicate");
    const auto source = dir.getChildFile("mono.wav");
    const auto destination = dir.getChildFile("stereo.wav");
    writeRamp(source, 12000, 1, kSampleRate);

    require(silverdaw::recording::duplicateMonoToStereo(source, destination, formats()),
            "a mono take should duplicate to stereo");

    const auto monoReader = readerFor(source);
    const auto stereoReader = readerFor(destination);
    require(monoReader != nullptr && stereoReader != nullptr, "both takes should read back");
    require(stereoReader->numChannels == 2, "the duplicate should have two channels");
    require(stereoReader->lengthInSamples == monoReader->lengthInSamples,
            "the duplicate should be the same length as the take");

    juce::AudioBuffer<float> mono(1, 12000);
    juce::AudioBuffer<float> stereo(2, 12000);
    require(monoReader->read(&mono, 0, 12000, 0, true, false), "the mono take should read");
    require(stereoReader->read(&stereo, 0, 12000, 0, true, true), "the duplicate should read");
    for (int i = 0; i < 12000; i += 997)
    {
        requireNear(stereo.getSample(0, i), mono.getSample(0, i), 1.0e-4,
                    "the left channel should be the take");
        requireNear(stereo.getSample(1, i), mono.getSample(0, i), 1.0e-4,
                    "the right channel should be the take too");
    }

    dir.deleteRecursively();
}

// A take that is already stereo has nothing to duplicate, and must not be
// rewritten behind the user's back.
void testDuplicateMonoToStereoRefusesAStereoTake()
{
    const auto dir = makeTempDir("recording-stereo-refuse");
    const auto source = dir.getChildFile("stereo.wav");
    const auto destination = dir.getChildFile("copy.wav");
    writeRamp(source, 4800, 2, kSampleRate);

    require(! silverdaw::recording::duplicateMonoToStereo(source, destination, formats()),
            "a stereo take should not be duplicated");
    require(! destination.existsAsFile(), "a refused duplicate should leave no file behind");

    dir.deleteRecursively();
}
void testCalibrationFindsBurstOnsetsNotPeaks()
{
    // A windowed burst peaks well after it starts, so timing the peak would report a round trip
    // several milliseconds too long. The onset is what arrives.
    const int length = 4800;
    const int burstLength = 288; // 6 ms at 48 kHz
    std::vector<float> signal(static_cast<size_t>(length), 0.0F);
    const std::vector<juce::int64> starts{500, 2000, 3500};
    for (auto start : starts)
    {
        for (int i = 0; i < burstLength; ++i)
        {
            const double window =
                0.5 - 0.5 * std::cos(juce::MathConstants<double>::twoPi * i / burstLength);
            const double phase = juce::MathConstants<double>::twoPi * 1000.0 * i / kSampleRate;
            signal[static_cast<size_t>(start + i)] =
                static_cast<float>(std::sin(phase) * window * 0.5);
        }
    }

    const auto onsets = silverdaw::recording::findBurstOnsets(signal.data(), length, 0.02F, 1000);
    require(onsets.size() == starts.size(), "each burst should be found once");
    for (size_t i = 0; i < onsets.size(); ++i)
    {
        // Within a millisecond of the true start: the onset threshold necessarily sits a little
        // way into the window's rise, and that is the accuracy the round trip inherits.
        require(std::abs(onsets[i] - starts[i]) < 48,
                "onset should land within 1 ms of the burst start");
    }
}

// The bursts must reach every output channel. A calibration heard on one side only is quieter
// than it should be, and quieter is exactly what makes a measurement fail.
void testCalibrationClicksReachEveryOutputChannel()
{
    silverdaw::recording::CalibrationClickSource clicks;

    // Mirrors the engine: the click source is not the mixer's first input, so it is pulled with
    // the mixer's own temporary buffer rather than the device buffer (AudioEngineDevice.cpp).
    struct SilentSource final : juce::AudioSource
    {
        void prepareToPlay(int, double) override {}
        void releaseResources() override {}
        void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override
        {
            info.clearActiveBufferRegion();
        }
    };
    SilentSource silence;
    juce::MixerAudioSource mixer;
    mixer.addInputSource(&silence, false);
    mixer.addInputSource(&clicks, false);
    mixer.prepareToPlay(512, kSampleRate);

    clicks.start(2, 20.0, 0.5F);

    juce::AudioBuffer<float> block(2, 512);
    float loudest = 0.0F;
    double biggestChannelGap = 0.0;
    for (int pull = 0; pull < 8; ++pull)
    {
        block.clear();
        juce::AudioSourceChannelInfo info(&block, 0, 512);
        mixer.getNextAudioBlock(info);
        for (int i = 0; i < 512; ++i)
        {
            const auto left = block.getSample(0, i);
            const auto right = block.getSample(1, i);
            loudest = juce::jmax(loudest, std::abs(left));
            biggestChannelGap = juce::jmax(biggestChannelGap,
                                           static_cast<double>(std::abs(left - right)));
        }
    }
    mixer.releaseResources();

    require(loudest > 0.1F, "the bursts should be audible in the output");
    require(biggestChannelGap < 1.0e-6, "both channels should carry the same burst");
}

// The burst was lengthened so it can be heard clearly, which is only safe because its attack
// stayed fast. If the envelope ever softens, the onset drifts and every measurement is long.
void testCalibrationBurstOnsetStaysSharp()
{
    silverdaw::recording::CalibrationClickSource clicks;
    clicks.prepareToPlay(512, kSampleRate);
    clicks.start(3, 200.0, 0.8F);

    const int length = 48000;
    juce::AudioBuffer<float> rendered(1, length);
    rendered.clear();
    juce::AudioBuffer<float> block(1, 512);
    for (int offset = 0; offset + 512 <= length; offset += 512)
    {
        block.clear();
        juce::AudioSourceChannelInfo info(&block, 0, 512);
        clicks.getNextAudioBlock(info);
        rendered.copyFrom(0, offset, block, 0, 0, 512);
    }

    const auto* data = rendered.getReadPointer(0);
    juce::int64 trueStart = -1;
    for (int i = 0; i < length; ++i)
    {
        if (std::abs(data[i]) > 0.0F)
        {
            trueStart = i;
            break;
        }
    }
    require(trueStart >= 0, "the source should have emitted something");

    const auto onsets = silverdaw::recording::findBurstOnsets(
        data, length, 0.05F, static_cast<juce::int64>(kSampleRate * 0.1));
    require(! onsets.empty(), "the emitted bursts should be found");
    require(std::abs(onsets[0] - trueStart) < static_cast<juce::int64>(kSampleRate * 0.002),
            "the detected onset should sit within 2 ms of where the burst really began");
}

void testCalibrationAgreesOnlyWhenReadingsCorroborate()
{
    const auto agreed = silverdaw::recording::agreedRoundTripMs({95.0, 96.0, 97.0, 96.5}, 12.0);
    require(agreed.has_value(), "consistent readings should agree");
    require(std::abs(*agreed - 96.125) < 0.001, "the agreed value should average the cluster");

    // One late reflection must not drag the answer.
    const auto robust =
        silverdaw::recording::agreedRoundTripMs({95.0, 96.0, 400.0, 97.0, 96.0}, 12.0);
    require(robust.has_value(), "a majority cluster should still agree");
    require(std::abs(*robust - 96.0) < 0.6, "an outlier should be excluded, not averaged in");

    require(! silverdaw::recording::agreedRoundTripMs({10.0, 200.0, 400.0}, 12.0).has_value(),
            "scattered readings should refuse to report a number");
    require(! silverdaw::recording::agreedRoundTripMs({96.0, 96.0}, 12.0).has_value(),
            "too few readings should refuse to report a number");
    require(! silverdaw::recording::agreedRoundTripMs({0.2, 0.2, 0.2, 0.2}, 12.0).has_value(),
            "an implausibly short round trip should be rejected");
}

// The round trip is the gap between a burst being written to the output and its echo landing in
// the capture, measured across two clocks: emission stamps taken in the audio callback, and a
// capture whose first sample carries a stamp of its own. This exercises that join end to end,
// with a file standing in for the microphone.
void testCalibrationRecoversTheRoundTripFromACapture()
{
    const auto dir = makeTempDir("recording-calibration");
    const auto file = dir.getChildFile("calibration.wav");

    constexpr double roundTripMs = 96.0;
    constexpr int burstLength = 288; // 6 ms at 48 kHz
    const std::vector<double> emitOffsetsMs{0.0, 250.0, 500.0, 750.0};

    const int length = 60000;
    juce::AudioBuffer<float> buffer(1, length);
    buffer.clear();
    for (auto emitMs : emitOffsetsMs)
    {
        const auto start = static_cast<int>((emitMs + roundTripMs) * kSampleRate / 1000.0);
        for (int i = 0; i < burstLength; ++i)
        {
            const double window =
                0.5 - 0.5 * std::cos(juce::MathConstants<double>::twoPi * i / burstLength);
            const double phase = juce::MathConstants<double>::twoPi * 1000.0 * i / kSampleRate;
            buffer.setSample(0, start + i, static_cast<float>(std::sin(phase) * window * 0.5));
        }
    }

    {
        juce::WavAudioFormat wav;
        std::unique_ptr<juce::OutputStream> stream(file.createOutputStream());
        const auto options = juce::AudioFormatWriterOptions{}
                                 .withSampleRate(kSampleRate)
                                 .withNumChannels(1)
                                 .withBitsPerSample(24);
        std::unique_ptr<juce::AudioFormatWriter> writer(wav.createWriterFor(stream, options));
        require(writer != nullptr, "the calibration capture writer should be created");
        require(writer->writeFromAudioSampleBuffer(buffer, 0, length),
                "the calibration capture should be written");
    }

    // Capture sample 0 and the first emission share an instant, so an offset in the file is
    // exactly the round trip. A non-zero base proves the maths uses the stamps, not the file.
    const auto ticksPerSecond = juce::Time::getHighResolutionTicksPerSecond();
    const juce::int64 firstBlockTicks = ticksPerSecond * 1234;
    std::vector<juce::int64> emitTicks;
    for (auto emitMs : emitOffsetsMs)
        emitTicks.push_back(firstBlockTicks
                            + static_cast<juce::int64>(emitMs * static_cast<double>(ticksPerSecond)
                                                       / 1000.0));

    const auto outcome =
        silverdaw::recording::measureRoundTrip(file, formats(), firstBlockTicks, emitTicks);
    require(outcome.ok, "a clean capture should measure");
    require(outcome.detected == static_cast<int>(emitOffsetsMs.size()),
            "every burst should be heard");
    require(std::abs(outcome.roundTripMs - roundTripMs) < 1.5,
            "the measured round trip should match what was played back");

    dir.deleteRecursively();
}

// Silence is a failure with a cause the user can act on, not a round trip of zero — reporting
// a number here would trim every take by nothing and look like the feature simply did not work.
void testCalibrationRefusesToMeasureSilence()
{
    const auto dir = makeTempDir("recording-calibration-silent");
    const auto file = dir.getChildFile("silent.wav");
    juce::AudioBuffer<float> buffer(1, 24000);
    buffer.clear();
    {
        juce::WavAudioFormat wav;
        std::unique_ptr<juce::OutputStream> stream(file.createOutputStream());
        const auto options = juce::AudioFormatWriterOptions{}
                                 .withSampleRate(kSampleRate)
                                 .withNumChannels(1)
                                 .withBitsPerSample(24);
        std::unique_ptr<juce::AudioFormatWriter> writer(wav.createWriterFor(stream, options));
        require(writer->writeFromAudioSampleBuffer(buffer, 0, 24000), "silence should be written");
    }

    const auto outcome = silverdaw::recording::measureRoundTrip(
        file, formats(), juce::Time::getHighResolutionTicksPerSecond(), {1, 2, 3, 4});
    require(! outcome.ok, "silence should not measure");
    require(outcome.roundTripMs == 0.0, "a failed measurement should report no round trip");
    require(outcome.error.isNotEmpty(), "a failed measurement should say why");

    dir.deleteRecursively();
}

/**
 * The lead-in contract: whatever is kept in front of the anchor, the audio played *on* the
 * anchor still lands on it once the take is placed at `anchorMs - preRollMs`. Everything
 * captured ahead of the anchor is either trimmed or kept, never both and never lost.
 */
void testPreRollKeepsTheAnchorOnTheAnchor()
{
    using silverdaw::recording::kRecordPreRollMs;
    using silverdaw::recording::planHeadTrim;

    const auto ample = planHeadTrim(400.0, 8000.0, false);
    require(std::abs(ample.preRollMs - kRecordPreRollMs) < 1.0e-9,
            "a generous lead-in should keep the full pre-roll");
    require(std::abs(ample.headTrimMs + ample.preRollMs - 400.0) < 1.0e-9,
            "trim plus pre-roll should account for the whole lead-in");
    require(std::abs((8000.0 - ample.preRollMs) + ample.preRollMs - 8000.0) < 1.0e-9,
            "the anchor audio should land back on the anchor");

    // Latency and skew are all there is to keep; a lead-in cannot be invented.
    const auto scarce = planHeadTrim(30.0, 8000.0, false);
    require(std::abs(scarce.preRollMs - 30.0) < 1.0e-9,
            "the pre-roll should be capped by what was actually captured");
    require(scarce.headTrimMs == 0.0, "a short lead-in should be kept whole, not trimmed");

    // Nothing can sit before the start of the timeline.
    const auto atZero = planHeadTrim(400.0, 0.0, false);
    require(atZero.preRollMs == 0.0, "a take on the timeline start should keep no lead-in");
    require(std::abs(atZero.headTrimMs - 400.0) < 1.0e-9, "the whole lead-in should be trimmed");

    const auto nearZero = planHeadTrim(400.0, 40.0, false);
    require(std::abs(nearZero.preRollMs - 40.0) < 1.0e-9,
            "the pre-roll should be capped by the anchor");

    // A claimed beat count is divided by the file's whole duration to recover a tempo,
    // so a lead-in would make the take read as slower than it was played.
    const auto musical = planHeadTrim(400.0, 8000.0, true);
    require(musical.preRollMs == 0.0, "a take claiming a beat count should keep no lead-in");
    require(std::abs(musical.headTrimMs - 400.0) < 1.0e-9,
            "an exact-length take should still be trimmed flush to the anchor");

    // A negative skew larger than the latency means the take starts after the anchor;
    // there is nothing in front of it to trim or to keep.
    const auto negative = planHeadTrim(-15.0, 8000.0, false);
    require(negative.headTrimMs == 0.0 && negative.preRollMs == 0.0,
            "a take with no lead-in at all should neither trim nor keep");
}

/**
 * Which driver types "automatic" will pick from. Both exclusions are behavioural, not
 * cosmetic: exclusive mode locks the microphone away from every other application and
 * fails to open if anything already holds it, and DirectSound runs at several times the
 * period of any WASAPI path.
 */
void testAutomaticCaptureTypeExcludesTheDisruptiveDrivers()
{
    using silverdaw::recording::isAutomaticCaptureType;

    require(isAutomaticCaptureType("Windows Audio"), "the shared WASAPI path is the mainstay");
    require(isAutomaticCaptureType("Windows Audio (Low Latency Mode)"),
            "a low-latency WASAPI path should stay eligible even though it is not preferred by name");
    require(isAutomaticCaptureType("ASIO"), "an unknown type should be eligible rather than excluded");
    require(! isAutomaticCaptureType("Windows Audio (Exclusive Mode)"),
            "exclusive mode must never be chosen without being asked for");
    require(! isAutomaticCaptureType("DirectSound"),
            "DirectSound is a fallback, not an automatic choice");
}

/**
 * The starvation watchdog. A capture device pulled mid-take reports nothing — measured on
 * real hardware — so a stalled callback is the only evidence of loss, and the threshold has
 * to clear every honest gap because a false positive aborts a good take.
 */
void testCaptureStarvationNeedsARealStall()
{
    using silverdaw::recording::captureHasStarved;
    using silverdaw::recording::kCaptureStarvationMs;

    // A tick per millisecond keeps the arithmetic legible.
    constexpr double perSecond = 1000.0;
    const juce::int64 reference = 5000;
    const auto after = [&](double ms) { return reference + static_cast<juce::int64>(ms); };

    require(! captureHasStarved(reference, after(0.0), perSecond),
            "a device that has just delivered has not starved");
    require(! captureHasStarved(reference, after(53.0), perSecond),
            "DirectSound's 53 ms period is a legitimate gap");
    require(! captureHasStarved(reference, after(kCaptureStarvationMs), perSecond),
            "the threshold itself should not trip it");
    require(captureHasStarved(reference, after(kCaptureStarvationMs + 1.0), perSecond),
            "a stall past the threshold is a lost input");

    // The margin over the worst honest driver period is the whole safety argument.
    require(kCaptureStarvationMs > 53.0 * 20.0,
            "the threshold must clear the slowest driver period by a wide margin");

    // No reference at all: capture never opened and nothing was ever delivered. Reporting a
    // loss here would abort sessions that had not begun.
    require(! captureHasStarved(0, after(10000.0), perSecond),
            "an absent reference must never report a loss");
    require(! captureHasStarved(reference, after(10000.0), 0.0),
            "an unusable clock must never report a loss");
    require(! captureHasStarved(reference, reference - 1000, perSecond),
            "a clock that appears to run backwards must never report a loss");
}
} // namespace
void addRecordingTests(std::vector<TestCase>& tests)
{
    tests.push_back({"recording writer produces a readable file", testWriterProducesReadableFile});
    tests.push_back({"recording writer abort leaves nothing behind", testWriterAbortLeavesNothingBehind});
    tests.push_back({"capture tap writes selected channels only", testCaptureTapWritesSelectedChannelsOnly});
    tests.push_back({"capture tap detects silent input", testCaptureTapDetectsSilentInput});
    tests.push_back({"capture tap stops at length cap", testCaptureTapStopsAtLengthCap});
    tests.push_back({"capture tap applies input gain", testCaptureTapAppliesInputGain});
    tests.push_back({"recording count-in leaves the anchor alone",
                     testCountInLeavesTheAnchorAloneAndCostsTheTakeNothing});
    tests.push_back({"recording window anchors where its mode says",
                     testRecordWindowAnchorsWhereTheModeSays});
    tests.push_back({"recording session borrows the metronome in both directions",
                     testSessionBorrowsTheMetronomeInBothDirections});
    tests.push_back({"recording backing is borrowed in both directions",
                     testBackingIsBorrowedInBothDirections});
    tests.push_back({"recording backing level is session scoped",
                     testBackingLevelIsSessionScoped});
    tests.push_back({"recording monitor is session scoped and silent in review",
                     testMonitorIsSessionScopedAndSilentInReview});
    tests.push_back({"recording mode decides whether a take is musical",
                     testRecordingModeDecidesMusicality});
    tests.push_back({"recording cleanup finds the noise floor from quiet windows",
                     testCleanupFindsTheNoiseFloorFromQuietWindows});
    tests.push_back({"recording cleanup leaves the performance alone",
                     testCleanupExpanderLeavesThePerformanceAlone});
    tests.push_back({"recording cleanup removes the bed and keeps the performance",
                     testCleanupRemovesTheBedAndKeepsThePerformance});
    tests.push_back({"recording cleanup closes in a short gap and opens on time",
                     testCleanupExpanderClosesInAShortGapAndOpensOnTime});
    tests.push_back({"recording cleanup rewrites the take in place",
                     testCleanupRewritesTheTakeInPlace});
    tests.push_back({"recording session defaults with nothing remembered",
                     testFreshSessionDefaults});
    tests.push_back({"recording mono take duplicates to stereo",
                     testDuplicateMonoToStereoCopiesTheTake});
    tests.push_back({"recording stereo take is not duplicated",
                     testDuplicateMonoToStereoRefusesAStereoTake});
    tests.push_back({"recording finalise trims latency from the head", testFinaliseTrimsLatencyFromTheHead});
    tests.push_back({"recording finalise corrects clock drift", testFinaliseCorrectsClockDrift});
    tests.push_back({"recording finalise measures drift against the output clock",
                     testFinaliseDriftIsMeasuredAgainstTheOutputClock});
    tests.push_back({"recording clock rate estimator recovers the rate and its uncertainty",
                     testClockRateEstimatorRecoversTheRateAndItsUncertainty});
    tests.push_back({"recording finalise trims the head in the captured domain", testFinaliseTrimsHeadInTheCapturedDomain});
    tests.push_back({"recording finalise rejects a recording shorter than latency",
                     testFinaliseRejectsRecordingShorterThanLatency});
    tests.push_back({"recording finalise keeps stereo channels", testFinaliseKeepsStereoChannels});
    tests.push_back({"recording finalise trims the tail to the exact musical length",
                     testFinaliseTrimsTailToTheExactMusicalLength});
    tests.push_back({"recording finalise leaves a short recording untrimmed",
                     testFinaliseLeavesShortRecordingUntrimmed});
    tests.push_back({"recording calibration finds burst onsets not peaks",
                     testCalibrationFindsBurstOnsetsNotPeaks});
    tests.push_back({"recording calibration agrees only when readings corroborate",
                     testCalibrationAgreesOnlyWhenReadingsCorroborate});
    tests.push_back({"recording calibration burst onset stays sharp",
                     testCalibrationBurstOnsetStaysSharp});
    tests.push_back({"recording calibration clicks reach every output channel",
                     testCalibrationClicksReachEveryOutputChannel});
    tests.push_back({"recording calibration recovers the round trip from a capture",
                     testCalibrationRecoversTheRoundTripFromACapture});
    tests.push_back({"recording calibration refuses to measure silence",
                     testCalibrationRefusesToMeasureSilence});
    tests.push_back({"recording pre-roll keeps the anchor on the anchor",
                     testPreRollKeepsTheAnchorOnTheAnchor});
    tests.push_back({"recording automatic capture type excludes the disruptive drivers",
                     testAutomaticCaptureTypeExcludesTheDisruptiveDrivers});
    tests.push_back({"recording capture starvation needs a real stall",
                     testCaptureStarvationNeedsARealStall});
}

} // namespace silverdaw::tests
