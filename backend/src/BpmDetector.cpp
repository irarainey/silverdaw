#include "BpmDetector.h"

#include "Log.h"

#include <BTrack.h>
#include <juce_audio_basics/juce_audio_basics.h>
#include <samplerate.h>
#include <memory>
#include <vector>

namespace silverdaw
{

double BpmDetector::estimateBpm(const juce::File& audioFile, juce::AudioFormatManager& formatManager)
{
    if (!audioFile.existsAsFile())
    {
        return 0.0;
    }

    std::unique_ptr<juce::AudioFormatReader> reader(formatManager.createReaderFor(audioFile));
    if (reader == nullptr)
    {
        silverdaw::log::warn("bpm", "createReaderFor failed for " + audioFile.getFileName());
        return 0.0;
    }
    const double sourceSampleRate = reader->sampleRate;
    if (sourceSampleRate <= 0.0 || reader->numChannels == 0 || reader->lengthInSamples <= 0)
    {
        return 0.0;
    }

    // Cap analysis duration so very long files don't drag detection
    // out. Two minutes' worth of input is plenty for a steady tempo.
    const juce::int64 maxSourceSamples =
        static_cast<juce::int64>(kMaxAnalysisSeconds * sourceSampleRate);
    const juce::int64 totalSourceSamples = juce::jmin(reader->lengthInSamples, maxSourceSamples);

    // ──────────────────────────────────────────────────────────────────
    // Step 1: decode the whole capped range into a single mono float
    // buffer. ~21 MB worst case (2 min of mono float32) — well within
    // headroom on any modern desktop, and one-shot decoding lets us
    // hand a single contiguous buffer to libsamplerate.
    // ──────────────────────────────────────────────────────────────────
    std::vector<float> mono(static_cast<size_t>(totalSourceSamples), 0.0F);
    const int numCh = static_cast<int>(reader->numChannels);
    const int decodeBlockSize = 4096;
    juce::AudioBuffer<float> decodeBuffer(numCh, decodeBlockSize);

    juce::int64 sourcePos = 0;
    while (sourcePos < totalSourceSamples)
    {
        const int toRead =
            static_cast<int>(juce::jmin(static_cast<juce::int64>(decodeBlockSize), totalSourceSamples - sourcePos));
        if (toRead <= 0) break;

        if (!reader->read(&decodeBuffer, 0, toRead, sourcePos, true, true))
        {
            silverdaw::log::warn("bpm", "reader read failed at " + juce::String(sourcePos));
            return 0.0;
        }
        // Downmix the just-read block into the mono buffer at the
        // matching offset.
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

    // ──────────────────────────────────────────────────────────────────
    // Step 2: resample to BTrack's expected 44.1 kHz mono using
    // libsamplerate (`src_simple`, one-shot conversion of the whole
    // buffer). This avoids the chunked-interpolator API pitfalls that
    // bit the earlier CatmullRom-based implementation.
    // ──────────────────────────────────────────────────────────────────
    std::vector<float> resampled;
    if (std::abs(sourceSampleRate - kAnalysisSampleRate) < 0.001)
    {
        // No resampling needed — saves an allocation + a copy.
        resampled = std::move(mono);
    }
    else
    {
        const double ratio = kAnalysisSampleRate / sourceSampleRate;
        const size_t outFrames =
            static_cast<size_t>(std::ceil(static_cast<double>(mono.size()) * ratio)) + 4;
        resampled.assign(outFrames, 0.0F);
        SRC_DATA srcData{};
        srcData.data_in = mono.data();
        srcData.input_frames = static_cast<long>(mono.size());
        srcData.data_out = resampled.data();
        srcData.output_frames = static_cast<long>(outFrames);
        srcData.src_ratio = ratio;
        srcData.end_of_input = 1;
        const int err = src_simple(&srcData, SRC_SINC_FASTEST, 1);
        if (err != 0)
        {
            silverdaw::log::warn("bpm", juce::String("src_simple failed: ") + src_strerror(err));
            return 0.0;
        }
        resampled.resize(static_cast<size_t>(srcData.output_frames_gen));
    }

    // ──────────────────────────────────────────────────────────────────
    // Step 3: feed BTrack frame-by-frame at kHopSize samples per call.
    // BTrack updates its tempo estimate internally whenever it
    // detects a beat; we read the final estimate after the last hop.
    // ──────────────────────────────────────────────────────────────────
    BTrack bt(kHopSize, kFrameSize);
    std::vector<double> hopBuffer(static_cast<size_t>(kHopSize), 0.0);
    const size_t totalFrames = resampled.size();
    int hopsProcessed = 0;
    for (size_t pos = 0; pos + static_cast<size_t>(kHopSize) <= totalFrames;
         pos += static_cast<size_t>(kHopSize))
    {
        for (int i = 0; i < kHopSize; ++i)
        {
            hopBuffer[static_cast<size_t>(i)] = static_cast<double>(resampled[pos + static_cast<size_t>(i)]);
        }
        bt.processAudioFrame(hopBuffer.data());
        ++hopsProcessed;
    }

    const double bpm = bt.getCurrentTempoEstimate();
    silverdaw::log::info("bpm",
                        "raw estimate " + audioFile.getFileName() + ": " + juce::String(bpm, 3) +
                            " (hops=" + juce::String(hopsProcessed) + ", srcSR=" +
                            juce::String(sourceSampleRate) + ")");
    if (!std::isfinite(bpm) || bpm < kMinPlausibleBpm || bpm > kMaxPlausibleBpm)
    {
        silverdaw::log::info("bpm",
                             "estimate out of range for " + audioFile.getFileName() + ": " + juce::String(bpm));
        return 0.0;
    }
    silverdaw::log::info("bpm", "estimated " + audioFile.getFileName() + " -> " + juce::String(bpm, 2) + " BPM");
    return bpm;
}

} // namespace silverdaw

