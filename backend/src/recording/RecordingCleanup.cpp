#include "RecordingCleanup.h"

#include "Log.h"
#include "dsp/VocalDenoiser.h"

#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <cmath>
#include <limits>
#include <memory>
#include <vector>

namespace silverdaw::recording
{
namespace
{
constexpr int kBitsPerSample = 24;
constexpr int kBlockSamples = 8192;
// Below this there is nothing worth rewriting the file for.
constexpr double kSkipBelowFloorDb = -75.0;
// Envelope timing. Fast enough to open on a consonant, and a release short enough
// that the gain is closed well inside a gap between two words: the coefficient is
// a time constant, so a 40 dB fall takes some four and a half of them, and the
// old 120 ms release could not close inside anything shorter than half a second.
constexpr double kAttackMs = 5.0;
constexpr double kReleaseMs = 30.0;

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

double measureNoiseFloorDb(const juce::AudioBuffer<float>& audio, double sampleRate)
{
    const int channels = audio.getNumChannels();
    const int frames = audio.getNumSamples();
    if (channels <= 0 || frames <= 0 || sampleRate <= 0.0) return -100.0;

    const int windowSamples =
        juce::jmax(16, static_cast<int>(sampleRate * kFloorWindowMs / 1000.0));
    std::vector<float> windowRms;
    windowRms.reserve(static_cast<std::size_t>(frames / windowSamples) + 1);

    double sumOfSquares = 0.0;
    int inWindow = 0;
    for (int i = 0; i < frames; ++i)
    {
        double mono = 0.0;
        for (int channel = 0; channel < channels; ++channel)
            mono += audio.getSample(channel, i);
        mono /= channels;
        sumOfSquares += mono * mono;
        if (++inWindow >= windowSamples)
        {
            windowRms.push_back(static_cast<float>(std::sqrt(sumOfSquares / inWindow)));
            sumOfSquares = 0.0;
            inWindow = 0;
        }
    }
    if (inWindow > 0) windowRms.push_back(static_cast<float>(std::sqrt(sumOfSquares / inWindow)));

    return noiseFloorDbFromWindowRms(windowRms);
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

void expandBelowFloorInPlace(juce::AudioBuffer<float>& audio, double sampleRate,
                             double thresholdDb)
{
    const int channels = audio.getNumChannels();
    const int frames = audio.getNumSamples();
    if (channels <= 0 || frames <= 0 || sampleRate <= 0.0) return;

    // Per-sample envelope, so the expander follows the performance rather than
    // any block boundary.
    const auto attackCoefficient =
        static_cast<float>(std::exp(-1.0 / (sampleRate * kAttackMs / 1000.0)));
    const auto releaseCoefficient =
        static_cast<float>(std::exp(-1.0 / (sampleRate * kReleaseMs / 1000.0)));
    float envelope = 0.0F;
    float smoothedGain = 1.0F;

    for (int i = 0; i < frames; ++i)
    {
        float magnitude = 0.0F;
        for (int channel = 0; channel < channels; ++channel)
            magnitude = juce::jmax(magnitude, std::abs(audio.getSample(channel, i)));
        const float envelopeCoefficient =
            magnitude > envelope ? attackCoefficient : releaseCoefficient;
        envelope = magnitude + envelopeCoefficient * (envelope - magnitude);

        const float target = expanderGain(levelToDb(envelope), thresholdDb);
        // The gain is smoothed on the envelope's own timing and in its own
        // direction: opening on the attack, so a consonant is not swallowed by a
        // gain that lags it, and closing on the release, so the bed fades out of a
        // gap rather than switching off inside it.
        const float gainCoefficient =
            target > smoothedGain ? attackCoefficient : releaseCoefficient;
        smoothedGain = target + gainCoefficient * (smoothedGain - target);
        for (int channel = 0; channel < channels; ++channel)
            audio.setSample(channel, i, audio.getSample(channel, i) * smoothedGain);
    }
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
    if (totalSamples > static_cast<juce::int64>(std::numeric_limits<int>::max()))
        return fail("The recording is too long to clean");

    // Whole-take processing, as the stem cleanup does: the denoiser needs the take
    // in one piece, and a recording is short beside a song.
    juce::AudioBuffer<float> audio(channels, static_cast<int>(totalSamples));
    if (! reader->read(&audio, 0, static_cast<int>(totalSamples), 0, true, true))
        return fail("The recording could not be read back");
    reader.reset();

    CleanupResult result;
    result.noiseFloorDb = measureNoiseFloorDb(audio, sampleRate);
    result.thresholdDb =
        juce::jmin(kMaxThresholdDb, result.noiseFloorDb + kThresholdAboveFloorDb);

    if (result.noiseFloorDb <= kSkipBelowFloorDb)
    {
        // Already quieter than anything the pass would remove. Rewriting the file
        // could only lose quality, so the take is left exactly as captured.
        result.ok = true;
        result.skipped = true;
        log::info("recording", "cleanup skipped, floor " + juce::String(result.noiseFloorDb, 1)
                                   + " dB is already clean");
        return result;
    }

    // Rumble first: mains hum, desk thumps and stand noise sit below anything sung
    // or spoken, and they are not what the denoiser was trained to remove.
    juce::dsp::ProcessSpec spec;
    spec.sampleRate = sampleRate;
    spec.maximumBlockSize = static_cast<juce::uint32>(kBlockSamples);
    spec.numChannels = 1;
    const auto coefficients =
        juce::dsp::IIR::Coefficients<float>::makeHighPass(sampleRate, kHighPassHz);
    for (int channel = 0; channel < channels; ++channel)
    {
        juce::dsp::IIR::Filter<float> highPass;
        highPass.coefficients = coefficients;
        highPass.prepare(spec);
        auto* samples = audio.getWritePointer(channel);
        for (int i = 0; i < audio.getNumSamples(); ++i)
            samples[i] = highPass.processSample(samples[i]);
    }

    // The pass that does the actual work: the same RNNoise suppressor the vocal
    // stem cleanup uses, which removes the bed from *under* the performance as
    // well as from between it — something no expander can do.
    VocalDenoiser::process(audio, sampleRate, kDenoiseWet);

    // Then the expander, on what the denoiser left, exactly as the vocal stem
    // chain does: it pushes down the residual bed between phrases without being
    // asked to remove the bed on its own. Its threshold has to come from the
    // denoised take — the floor measured before would sit far above the bed that
    // is left, and would take the performance with it.
    const auto residualFloorDb = measureNoiseFloorDb(audio, sampleRate);
    result.residualFloorDb = residualFloorDb;
    expandBelowFloorInPlace(audio, sampleRate,
                            juce::jmin(kMaxThresholdDb,
                                       residualFloorDb + kThresholdAboveFloorDb));

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

    for (int position = 0; position < audio.getNumSamples(); position += kBlockSamples)
    {
        const int toWrite = juce::jmin(kBlockSamples, audio.getNumSamples() - position);
        if (! writer->writeFromAudioSampleBuffer(audio, position, toWrite))
        {
            writer.reset();
            temporary.deleteFile();
            return fail("The cleaned recording could not be written");
        }
    }
    writer.reset();

    if (! request.file.deleteFile() || ! temporary.moveFileTo(request.file))
    {
        temporary.deleteFile();
        return fail("The cleaned recording could not replace the original");
    }

    result.ok = true;
    log::info("recording", "cleanup floor=" + juce::String(result.noiseFloorDb, 1)
                               + "dB residual=" + juce::String(result.residualFloorDb, 1)
                               + "dB wet=" + juce::String(kDenoiseWet, 2));
    return result;
}

} // namespace silverdaw::recording
