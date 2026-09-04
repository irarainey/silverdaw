#include "RecordingFinalise.h"

#include "Log.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <cmath>
#include <memory>
#include <vector>

namespace silverdaw::recording
{
namespace
{
constexpr int kBitsPerSample = 24;
constexpr int kBlockSamples = 8192;
// Below this the correction is smaller than the resampler's own error, so
// resampling would cost quality for nothing.
constexpr double kMinCorrectablePpm = 1.0;

FinaliseResult fail(juce::String message)
{
    FinaliseResult result;
    result.error = std::move(message);
    return result;
}
} // namespace

FinaliseResult finaliseRecording(const FinaliseRequest& request,
                                 juce::AudioFormatManager& formatManager)
{
    if (! request.sourceFile.existsAsFile())
        return fail("The recording file is missing");

    std::unique_ptr<juce::AudioFormatReader> reader(
        formatManager.createReaderFor(request.sourceFile));
    if (reader == nullptr)
        return fail("The recording could not be read back");

    const double nominalRate = request.nominalSampleRate > 0.0 ? request.nominalSampleRate
                                                               : reader->sampleRate;
    const int channels = static_cast<int>(reader->numChannels);
    if (nominalRate <= 0.0 || channels <= 0)
        return fail("The recording has no usable audio");

    // Captured late by the round trip, so the head is trimmed rather than the
    // whole file being nudged at playback time.
    const auto latencySamples =
        juce::jlimit<juce::int64>(0, reader->lengthInSamples,
                                  static_cast<juce::int64>(request.latencyMs * nominalRate / 1000.0));
    const auto sourceSamples = reader->lengthInSamples - latencySamples;
    if (sourceSamples <= 0)
        return fail("The recording was shorter than the input latency");

    const double measuredRate = request.measuredSampleRate > 0.0 ? request.measuredSampleRate
                                                                 : nominalRate;
    const double driftPpm = (measuredRate - nominalRate) / nominalRate * 1.0e6;
    const bool correctDrift = std::abs(driftPpm) >= kMinCorrectablePpm;
    // Input samples consumed per output sample: the file must last the wall-clock
    // time it actually took when played back at the nominal rate. Clamped because
    // this corrects clock drift, not a wrongly reported sample rate.
    const double speedRatio =
        correctDrift ? juce::jlimit(0.5, 2.0, measuredRate / nominalRate) : 1.0;
    auto outputSamples =
        juce::jmax<juce::int64>(1, static_cast<juce::int64>(static_cast<double>(sourceSamples)
                                                            / speedRatio));

    // The capture always runs past the end of a bar-locked window by however long
    // the stop took to arrive. Trimming the tail here is what makes the beat count
    // the caller claims true of the file itself.
    bool exactLength = false;
    if (request.exactDurationMs > 0.0)
    {
        const auto targetSamples = juce::jmax<juce::int64>(
            1, static_cast<juce::int64>(std::llround(request.exactDurationMs * nominalRate
                                                     / 1000.0)));
        if (outputSamples >= targetSamples)
        {
            outputSamples = targetSamples;
            exactLength = true;
        }
    }

    request.destinationFile.deleteFile();
    std::unique_ptr<juce::OutputStream> stream(request.destinationFile.createOutputStream());
    if (stream == nullptr)
        return fail("Could not create the finished recording");

    juce::WavAudioFormat wav;
    const auto options = juce::AudioFormatWriterOptions{}
                             .withSampleRate(nominalRate)
                             .withNumChannels(channels)
                             .withBitsPerSample(kBitsPerSample);
    std::unique_ptr<juce::AudioFormatWriter> writer(wav.createWriterFor(stream, options));
    if (writer == nullptr)
        return fail("Could not create the finished recording");

    std::vector<juce::LagrangeInterpolator> interpolators(static_cast<size_t>(channels));
    juce::AudioBuffer<float> inputBlock(channels, kBlockSamples * 2 + 8);
    juce::AudioBuffer<float> outputBlock(channels, kBlockSamples);

    juce::int64 readPosition = latencySamples;
    juce::int64 written = 0;
    while (written < outputSamples)
    {
        const int outThisBlock =
            static_cast<int>(juce::jmin<juce::int64>(kBlockSamples, outputSamples - written));
        const int inThisBlock =
            correctDrift ? static_cast<int>(std::ceil(outThisBlock * speedRatio)) + 4 : outThisBlock;

        inputBlock.clear();
        const auto available = juce::jmax<juce::int64>(0, reader->lengthInSamples - readPosition);
        const int toRead = static_cast<int>(juce::jmin<juce::int64>(inThisBlock, available));
        if (toRead > 0 && ! reader->read(&inputBlock, 0, toRead, readPosition, true, true))
            return fail("The recording could not be read back");

        int consumed = outThisBlock;
        for (int channel = 0; channel < channels; ++channel)
        {
            if (correctDrift)
            {
                // Returns the input samples actually used, which is what keeps
                // successive blocks aligned across a fractional ratio.
                consumed = interpolators[static_cast<size_t>(channel)].process(
                    speedRatio, inputBlock.getReadPointer(channel),
                    outputBlock.getWritePointer(channel), outThisBlock);
            }
            else
            {
                outputBlock.copyFrom(channel, 0, inputBlock, channel, 0, outThisBlock);
            }
        }
        readPosition += consumed;

        if (! writer->writeFromAudioSampleBuffer(outputBlock, 0, outThisBlock))
            return fail("The finished recording could not be written");
        written += outThisBlock;
    }

    writer.reset();

    FinaliseResult result;
    result.ok = true;
    result.sampleRate = nominalRate;
    result.channelCount = channels;
    result.durationMs = static_cast<double>(outputSamples) * 1000.0 / nominalRate;
    result.driftPpm = driftPpm;
    result.latencyOffsetMs = static_cast<double>(latencySamples) * 1000.0 / nominalRate;
    result.exactLength = exactLength;
    log::info("recording", "finalised " + request.destinationFile.getFileName() + " drift="
                               + juce::String(driftPpm, 1) + "ppm latency="
                               + juce::String(result.latencyOffsetMs, 1) + "ms");
    return result;
}

} // namespace silverdaw::recording
