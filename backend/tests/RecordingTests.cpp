#include "TestRegistry.h"

#include "recording/InputCaptureTap.h"
#include "recording/RecordingFinalise.h"
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
} // namespace

void addRecordingTests(std::vector<TestCase>& tests)
{
    tests.push_back({"recording writer produces a readable file", testWriterProducesReadableFile});
    tests.push_back({"recording writer abort leaves nothing behind", testWriterAbortLeavesNothingBehind});
    tests.push_back({"capture tap writes selected channels only", testCaptureTapWritesSelectedChannelsOnly});
    tests.push_back({"capture tap detects silent input", testCaptureTapDetectsSilentInput});
    tests.push_back({"capture tap stops at length cap", testCaptureTapStopsAtLengthCap});
    tests.push_back({"capture tap applies input gain", testCaptureTapAppliesInputGain});
    tests.push_back({"recording finalise trims latency from the head", testFinaliseTrimsLatencyFromTheHead});
    tests.push_back({"recording finalise corrects clock drift", testFinaliseCorrectsClockDrift});
    tests.push_back({"recording finalise rejects a recording shorter than latency",
                     testFinaliseRejectsRecordingShorterThanLatency});
    tests.push_back({"recording finalise keeps stereo channels", testFinaliseKeepsStereoChannels});
    tests.push_back({"recording finalise trims the tail to the exact musical length",
                     testFinaliseTrimsTailToTheExactMusicalLength});
    tests.push_back({"recording finalise leaves a short recording untrimmed",
                     testFinaliseLeavesShortRecordingUntrimmed});
}

} // namespace silverdaw::tests
