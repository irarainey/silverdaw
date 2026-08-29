#include "BpmAudioLoader.h"

#include "Log.h"

#include <algorithm>
#include <cmath>
#include <juce_audio_basics/juce_audio_basics.h>
#include <memory>
#include <samplerate.h>
#include <utility>

namespace silverdaw
{

BpmDecodeResult decodeMonoForAnalysis(const juce::File& audioFile,
                                      juce::AudioFormatManager& formatManager, double maxSeconds,
                                      double analysisSampleRate,
                                      const std::function<bool()>& shouldAbort)
{
    BpmDecodeResult result;
    const auto aborted = [&shouldAbort]() -> bool { return shouldAbort && shouldAbort(); };

    if (!audioFile.existsAsFile())
    {
        result.status = BpmDecodeStatus::MissingFile;
        return result;
    }

    std::unique_ptr<juce::AudioFormatReader> reader(formatManager.createReaderFor(audioFile));
    if (reader == nullptr)
    {
        silverdaw::log::warn("bpm", "createReaderFor failed for " + audioFile.getFileName());
        result.status = BpmDecodeStatus::NoReader;
        return result;
    }

    const double sourceSampleRate = reader->sampleRate;
    if (sourceSampleRate <= 0.0 || reader->numChannels == 0 || reader->lengthInSamples <= 0)
    {
        result.status = BpmDecodeStatus::UnusableFormat;
        return result;
    }
    result.sourceSampleRate = sourceSampleRate;

    // Decode the whole track (bounded only by the generous maxSeconds ceiling)
    // so a period fit downstream can span the entire piece.
    const juce::int64 maxSourceSamples = static_cast<juce::int64>(maxSeconds * sourceSampleRate);
    const juce::int64 totalSourceSamples = juce::jmin(reader->lengthInSamples, maxSourceSamples);

    // One contiguous mono buffer keeps the libsamplerate handoff simple.
    std::vector<float> mono(static_cast<size_t>(totalSourceSamples), 0.0F);
    const int numCh = static_cast<int>(reader->numChannels);
    const int decodeBlockSize = 4096;
    juce::AudioBuffer<float> decodeBuffer(numCh, decodeBlockSize);

    juce::int64 sourcePos = 0;
    while (sourcePos < totalSourceSamples)
    {
        const int toRead = static_cast<int>(
            juce::jmin(static_cast<juce::int64>(decodeBlockSize), totalSourceSamples - sourcePos));
        if (toRead <= 0) break;
        // ~every 4 MB decoded (large tracks only); cheap clock read, no hot-path cost.
        if ((sourcePos % (static_cast<juce::int64>(decodeBlockSize) * 256)) == 0 && aborted())
        {
            result.status = BpmDecodeStatus::TimedOut;
            return result;
        }

        if (!reader->read(&decodeBuffer, 0, toRead, sourcePos, true, true))
        {
            // A mid-file read failure is NOT fatal. JUCE's MP3 reader routinely
            // reports a `lengthInSamples` a little longer than it can actually
            // decode (an ID3/VBR length-estimate quirk), so the final block of a
            // perfectly good track fails to read. Discarding the whole pass over
            // that would report "no tempo" for a track we decoded ~entirely, which
            // is exactly the failure this path used to produce. Keep what we have
            // whenever it is enough to analyse, and only give up when it is not.
            const double decodedSeconds = static_cast<double>(sourcePos) / sourceSampleRate;
            if (decodedSeconds < kMinUsableAnalysisSeconds)
            {
                silverdaw::log::warn("bpm", "reader read failed at " + juce::String(sourcePos)
                                                + " after only " + juce::String(decodedSeconds, 1)
                                                + "s of " + audioFile.getFileName()
                                                + " — too little audio to analyse");
                result.status = BpmDecodeStatus::ReadFailed;
                return result;
            }

            silverdaw::log::info("bpm", "reader read failed at " + juce::String(sourcePos) + " for "
                                            + audioFile.getFileName() + " — analysing the "
                                            + juce::String(decodedSeconds, 1)
                                            + "s decoded successfully");
            mono.resize(static_cast<size_t>(sourcePos));
            result.truncated = true;
            break;
        }
        const float invCh = 1.0F / static_cast<float>(numCh);
        const size_t writeBase = static_cast<size_t>(sourcePos);
        for (int ch = 0; ch < numCh; ++ch)
        {
            const float* src = decodeBuffer.getReadPointer(ch);
            for (int i = 0; i < toRead; ++i)
            {
                mono[writeBase + static_cast<size_t>(i)] += src[i] * invCh;
            }
        }
        sourcePos += toRead;
    }

    // Estimators expect the analysis rate; use one-shot libsamplerate conversion.
    if (std::abs(sourceSampleRate - analysisSampleRate) < 0.001)
    {
        result.mono = std::move(mono);
        result.status = BpmDecodeStatus::Ok;
        return result;
    }

    const double ratio = analysisSampleRate / sourceSampleRate;
    const size_t outFrames =
        static_cast<size_t>(std::ceil(static_cast<double>(mono.size()) * ratio)) + 4;
    std::vector<float> resampled(outFrames, 0.0F);
    SRC_DATA srcData{};
    srcData.data_in = mono.data();
    srcData.input_frames = static_cast<long>(mono.size());
    srcData.data_out = resampled.data();
    srcData.output_frames = static_cast<long>(outFrames);
    srcData.src_ratio = ratio;
    srcData.end_of_input = 1;
    const int err = src_simple(&srcData, SRC_SINC_BEST_QUALITY, 1);
    if (err != 0)
    {
        silverdaw::log::warn("bpm", juce::String("src_simple failed: ") + src_strerror(err));
        result.status = BpmDecodeStatus::ResampleFailed;
        return result;
    }
    resampled.resize(static_cast<size_t>(srcData.output_frames_gen));

    result.mono = std::move(resampled);
    result.status = BpmDecodeStatus::Ok;
    return result;
}

} // namespace silverdaw
