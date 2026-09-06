#include "RecordingCleanup.h"

#include "Log.h"

#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <cmath>
#include <memory>

namespace silverdaw::recording
{
namespace
{
constexpr int kBitsPerSample = 24;
constexpr int kBlockSamples = 8192;
// Below this there is nothing worth rewriting the file for.
constexpr double kSkipBelowFloorDb = -75.0;
// Envelope timing. Fast enough to open on a consonant, slow enough that the
// release does not chatter between words.
constexpr double kAttackMs = 5.0;
constexpr double kReleaseMs = 120.0;

CleanupResult fail(juce::String message)
{
    CleanupResult result;
    result.error = std::move(message);
    return result;
}

double levelToDb(double level)
{
    return level > 1.0e-9 ? 20.0 * std::log10(level) : -100.0;
}
} // namespace

double noiseFloorDbFromWindowRms(std::vector<float>& windowRms)
{
    if (windowRms.empty()) return -100.0;
    const auto index = windowRms.size() / 10;
    std::nth_element(windowRms.begin(), windowRms.begin() + static_cast<std::ptrdiff_t>(index),
                     windowRms.end());
    return levelToDb(static_cast<double>(windowRms[index]));
}

float expanderGain(double levelDb, double thresholdDb)
{
    if (levelDb >= thresholdDb) return 1.0F;
    // One threshold-width of range below the knee takes the gain all the way to
    // the maximum reduction; further down it stays there rather than deepening
    // without limit, which is what keeps room tone sounding like room tone.
    const double range = juce::jmax(1.0, kThresholdAboveFloorDb);
    const double below = juce::jlimit(0.0, range, thresholdDb - levelDb);
    const double reductionDb = kMaxReductionDb * (below / range);
    return static_cast<float>(juce::Decibels::decibelsToGain(-reductionDb));
}

CleanupResult cleanRecording(const CleanupRequest& request,
                             juce::AudioFormatManager& formatManager)
{
    if (! request.file.existsAsFile()) return fail("The recording file is missing");

    std::unique_ptr<juce::AudioFormatReader> reader(formatManager.createReaderFor(request.file));
    if (reader == nullptr) return fail("The recording could not be read back");

    const double sampleRate = request.sampleRate > 0.0 ? request.sampleRate : reader->sampleRate;
    const int channels = static_cast<int>(reader->numChannels);
    const auto totalSamples = reader->lengthInSamples;
    if (sampleRate <= 0.0 || channels <= 0 || totalSamples <= 0)
        return fail("The recording has no usable audio");

    const int windowSamples =
        juce::jmax(16, static_cast<int>(sampleRate * kFloorWindowMs / 1000.0));

    // Pass one: what does this take's own noise bed measure at?
    std::vector<float> windowRms;
    windowRms.reserve(static_cast<size_t>(totalSamples / windowSamples) + 1);
    {
        juce::AudioBuffer<float> block(channels, kBlockSamples);
        juce::int64 position = 0;
        double sumOfSquares = 0.0;
        int inWindow = 0;
        while (position < totalSamples)
        {
            const int toRead =
                static_cast<int>(juce::jmin<juce::int64>(kBlockSamples, totalSamples - position));
            if (! reader->read(&block, 0, toRead, position, true, true))
                return fail("The recording could not be read back");
            for (int i = 0; i < toRead; ++i)
            {
                double mono = 0.0;
                for (int channel = 0; channel < channels; ++channel)
                    mono += block.getSample(channel, i);
                mono /= channels;
                sumOfSquares += mono * mono;
                if (++inWindow >= windowSamples)
                {
                    windowRms.push_back(static_cast<float>(std::sqrt(sumOfSquares / inWindow)));
                    sumOfSquares = 0.0;
                    inWindow = 0;
                }
            }
            position += toRead;
        }
        if (inWindow > 0)
            windowRms.push_back(static_cast<float>(std::sqrt(sumOfSquares / inWindow)));
    }

    CleanupResult result;
    result.noiseFloorDb = noiseFloorDbFromWindowRms(windowRms);
    result.thresholdDb =
        juce::jmin(kMaxThresholdDb, result.noiseFloorDb + kThresholdAboveFloorDb);

    if (result.noiseFloorDb <= kSkipBelowFloorDb)
    {
        // Already quieter than anything the expander would remove. Rewriting the
        // file could only lose quality, so the take is left exactly as captured.
        result.ok = true;
        result.skipped = true;
        log::info("recording", "cleanup skipped, floor " + juce::String(result.noiseFloorDb, 1)
                                   + " dB is already clean");
        return result;
    }

    const auto temporary = request.file.getSiblingFile(request.file.getFileNameWithoutExtension()
                                                       + ".cleanup.wav");
    temporary.deleteFile();
    std::unique_ptr<juce::OutputStream> stream(temporary.createOutputStream());
    if (stream == nullptr) return fail("Could not write the cleaned recording");

    juce::WavAudioFormat wav;
    const auto options = juce::AudioFormatWriterOptions{}
                             .withSampleRate(sampleRate)
                             .withNumChannels(channels)
                             .withBitsPerSample(kBitsPerSample);
    std::unique_ptr<juce::AudioFormatWriter> writer(wav.createWriterFor(stream, options));
    if (writer == nullptr) return fail("Could not write the cleaned recording");

    juce::dsp::ProcessSpec spec;
    spec.sampleRate = sampleRate;
    spec.maximumBlockSize = static_cast<juce::uint32>(kBlockSamples);
    spec.numChannels = static_cast<juce::uint32>(channels);
    juce::dsp::IIR::Filter<float> highPass[2];
    const auto coefficients =
        juce::dsp::IIR::Coefficients<float>::makeHighPass(sampleRate, kHighPassHz);
    for (int channel = 0; channel < juce::jmin(2, channels); ++channel)
    {
        highPass[channel].coefficients = coefficients;
        highPass[channel].prepare(spec);
    }

    // Per-sample envelope, so the expander follows the performance rather than
    // the block boundaries.
    const auto attackCoefficient =
        static_cast<float>(std::exp(-1.0 / (sampleRate * kAttackMs / 1000.0)));
    const auto releaseCoefficient =
        static_cast<float>(std::exp(-1.0 / (sampleRate * kReleaseMs / 1000.0)));
    float envelope = 0.0F;
    float smoothedGain = 1.0F;

    juce::AudioBuffer<float> block(channels, kBlockSamples);
    juce::int64 position = 0;
    while (position < totalSamples)
    {
        const int toRead =
            static_cast<int>(juce::jmin<juce::int64>(kBlockSamples, totalSamples - position));
        if (! reader->read(&block, 0, toRead, position, true, true))
        {
            temporary.deleteFile();
            return fail("The recording could not be read back");
        }

        for (int channel = 0; channel < juce::jmin(2, channels); ++channel)
        {
            auto* samples = block.getWritePointer(channel);
            for (int i = 0; i < toRead; ++i)
                samples[i] = highPass[channel].processSample(samples[i]);
        }

        for (int i = 0; i < toRead; ++i)
        {
            float magnitude = 0.0F;
            for (int channel = 0; channel < channels; ++channel)
                magnitude = juce::jmax(magnitude, std::abs(block.getSample(channel, i)));
            const float coefficient = magnitude > envelope ? attackCoefficient : releaseCoefficient;
            envelope = magnitude + coefficient * (envelope - magnitude);

            const float target = expanderGain(levelToDb(envelope), result.thresholdDb);
            // The gain itself is smoothed on the release timing, so even an abrupt
            // envelope change cannot step the level within a sample.
            smoothedGain = target + releaseCoefficient * (smoothedGain - target);
            for (int channel = 0; channel < channels; ++channel)
                block.setSample(channel, i, block.getSample(channel, i) * smoothedGain);
        }

        if (! writer->writeFromAudioSampleBuffer(block, 0, toRead))
        {
            temporary.deleteFile();
            return fail("The cleaned recording could not be written");
        }
        position += toRead;
    }

    writer.reset();
    reader.reset();

    if (! request.file.deleteFile() || ! temporary.moveFileTo(request.file))
    {
        temporary.deleteFile();
        return fail("The cleaned recording could not replace the original");
    }

    result.ok = true;
    log::info("recording", "cleanup floor=" + juce::String(result.noiseFloorDb, 1)
                               + "dB threshold=" + juce::String(result.thresholdDb, 1) + "dB");
    return result;
}

} // namespace silverdaw::recording
