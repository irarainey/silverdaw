#include "Waveform.h"
#include "Log.h"

#include <algorithm>
#include <cstring>
#include <juce_audio_basics/juce_audio_basics.h>
#include <limits>

namespace silverdaw::waveform
{

namespace
{
constexpr int kChunkSamples = 1 << 15; // 32 768 samples per disk read
}

PeaksResult computePeaks(const juce::File& file, juce::AudioFormatManager& formatManager, int peaksPerSecond)
{
    const auto startMs = juce::Time::getMillisecondCounterHiRes();
    silverdaw::log::info("waveform", "compute start " + file.getFileName() + " ppS=" + juce::String(peaksPerSecond));
    PeaksResult result;
    result.peaksPerSecond = peaksPerSecond;

    if (!file.existsAsFile() || peaksPerSecond <= 0)
    {
        silverdaw::log::warn("waveform", "compute abort: file missing or bad ppS for " + file.getFileName());
        return result;
    }

    // Open a fresh reader independent of any reader the audio engine
    // already holds for this file; both can stream from the same file
    // simultaneously without sharing state.
    std::unique_ptr<juce::AudioFormatReader> reader(formatManager.createReaderFor(file));
    if (reader == nullptr)
    {
        // Same probe-the-bytes fallback as AudioEngine::addClip: some
        // JUCE format readers only advertise a narrow extension set even
        // though their decoder accepts a wider range.
        if (auto stream = file.createInputStream())
        {
            reader.reset(formatManager.createReaderFor(std::move(stream)));
        }
    }
    if (reader == nullptr || reader->sampleRate <= 0.0 || reader->lengthInSamples <= 0)
    {
        silverdaw::log::warn("waveform", "could not open reader for " + file.getFullPathName());
        return result;
    }

    result.sampleRate = reader->sampleRate;
    const auto totalSamples = reader->lengthInSamples;
    const int numChannels = static_cast<int>(reader->numChannels);
    const int samplesPerPeak = juce::jmax(1, static_cast<int>(reader->sampleRate / peaksPerSecond));
    const auto peakCount = static_cast<int>((totalSamples + samplesPerPeak - 1) / samplesPerPeak);

    // Pre-size so we can write into the vector by index without reallocating.
    // Two floats per bucket (min, max), default-initialised to 0.0F.
    result.peaks.assign(static_cast<std::size_t>(peakCount) * 2U, 0.0F);

    juce::AudioBuffer<float> buffer(numChannels, kChunkSamples);

    juce::int64 readPos = 0;
    int peakIndex = 0;
    int bucketCount = 0;
    // Sentinel values for std::min/max so the first sample of each
    // bucket always replaces them. Avoids a special-case branch on
    // the first sample of every bucket.
    float bucketMin = std::numeric_limits<float>::infinity();
    float bucketMax = -std::numeric_limits<float>::infinity();
    const float invChannels = numChannels > 0 ? 1.0F / static_cast<float>(numChannels) : 1.0F;

    while (readPos < totalSamples)
    {
        const int toRead = static_cast<int>(juce::jmin(static_cast<juce::int64>(kChunkSamples), totalSamples - readPos));
        if (!reader->read(&buffer, 0, toRead, readPos, true, true))
        {
            silverdaw::log::warn("waveform", "read failure at sample " + juce::String(readPos));
            break;
        }

        for (int i = 0; i < toRead; ++i)
        {
            // Average across channels for a mono peak — same convention
            // as the renderer's `computePeaks` in `audio.ts`.
            float sum = 0.0F;
            for (int c = 0; c < numChannels; ++c)
            {
                sum += buffer.getReadPointer(c)[i];
            }
            const float v = sum * invChannels;

            bucketMin = std::min(v, bucketMin);
            bucketMax = std::max(v, bucketMax);

            ++bucketCount;
            if (bucketCount >= samplesPerPeak)
            {
                if (peakIndex < peakCount)
                {
                    result.peaks[(static_cast<std::size_t>(peakIndex) * 2U)] = bucketMin;
                    result.peaks[(static_cast<std::size_t>(peakIndex) * 2U) + 1U] = bucketMax;
                }
                ++peakIndex;
                bucketCount = 0;
                bucketMin = std::numeric_limits<float>::infinity();
                bucketMax = -std::numeric_limits<float>::infinity();
            }
        }

        readPos += toRead;
    }

    if (bucketCount > 0 && peakIndex < peakCount)
    {
        result.peaks[(static_cast<std::size_t>(peakIndex) * 2U)] = bucketMin;
        result.peaks[(static_cast<std::size_t>(peakIndex) * 2U) + 1U] = bucketMax;
    }

    const auto elapsedMs = juce::Time::getMillisecondCounterHiRes() - startMs;
    silverdaw::log::info("waveform", "compute done " + file.getFileName() + " peaks=" + juce::String(peakCount) +
                                          " ms=" + juce::String(elapsedMs, 1));
    return result;
}

} // namespace silverdaw::waveform
