#include "Waveform.h"
#include "Log.h"

#include <algorithm>
#include <cstring>
#include <iostream>
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
        std::cerr << "[waveform] could not open reader for " << file.getFullPathName().toStdString() << '\n';
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
            std::cerr << "[waveform] read failure at sample " << readPos << '\n';
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

std::vector<std::string> encodeWaveformFrames(const juce::String& clipId, const PeaksResult& result)
{
    // Max payload bytes per chunk — chosen so each WebSocket binary
    // frame including JSON header stays well under typical loopback
    // TCP send-buffer sizes (often ~64 KB on Windows). A 512 KB single
    // frame reliably hangs IXWebSocket's I/O loop on Windows; 32 KB
    // chunks drain in O(ms) each.
    constexpr std::size_t kMaxChunkBytes = 32 * 1024;
    // Two bytes per int16, must be even so we never split a peak.
    constexpr std::size_t kMaxChunkInts = kMaxChunkBytes / sizeof(std::int16_t);

    std::vector<std::string> frames;
    const std::size_t totalInts = result.peaks.size();
    if (totalInts == 0)
    {
        return frames;
    }

    // Quantise the whole peaks array up front; we slice the int16 buffer
    // per chunk below.
    std::vector<std::int16_t> quantised(totalInts);
    for (std::size_t i = 0; i < totalInts; ++i)
    {
        const float v = std::clamp(result.peaks[i], -1.0F, 1.0F);
        quantised[i] = static_cast<std::int16_t>(v * 32767.0F);
    }

    const std::size_t chunkCount = (totalInts + kMaxChunkInts - 1) / kMaxChunkInts;
    frames.reserve(chunkCount);

    for (std::size_t chunkIndex = 0; chunkIndex < chunkCount; ++chunkIndex)
    {
        const std::size_t offsetInts = chunkIndex * kMaxChunkInts;
        const std::size_t chunkInts = std::min(kMaxChunkInts, totalInts - offsetInts);
        const std::size_t chunkBytes = chunkInts * sizeof(std::int16_t);

        auto* headerObj = new juce::DynamicObject();
        headerObj->setProperty("type", juce::String("WAVEFORM_DATA"));
        headerObj->setProperty("clipId", clipId);
        headerObj->setProperty("sampleRate", result.sampleRate);
        headerObj->setProperty("peaksPerSecond", result.peaksPerSecond);
        headerObj->setProperty("peakCount", static_cast<int>(totalInts / 2U));
        headerObj->setProperty("format", juce::String("int16le"));
        headerObj->setProperty("chunkIndex", static_cast<int>(chunkIndex));
        headerObj->setProperty("chunkCount", static_cast<int>(chunkCount));
        headerObj->setProperty("chunkOffset", static_cast<int>(offsetInts));

        const auto headerJson = juce::JSON::toString(juce::var(headerObj), true).toStdString();
        const auto headerLen = static_cast<std::uint32_t>(headerJson.size());

        std::string frame;
        frame.resize(sizeof(headerLen) + headerJson.size() + chunkBytes);
        auto* out = reinterpret_cast<std::uint8_t*>(frame.data());
        out[0] = static_cast<std::uint8_t>(headerLen & 0xFFU);
        out[1] = static_cast<std::uint8_t>((headerLen >> 8) & 0xFFU);
        out[2] = static_cast<std::uint8_t>((headerLen >> 16) & 0xFFU);
        out[3] = static_cast<std::uint8_t>((headerLen >> 24) & 0xFFU);
        // NOLINTNEXTLINE(bugprone-not-null-terminated-result)
        std::memcpy(out + 4, headerJson.data(), headerJson.size());
        // NOLINTNEXTLINE(bugprone-not-null-terminated-result)
        std::memcpy(out + 4 + headerJson.size(), quantised.data() + offsetInts, chunkBytes);

        frames.emplace_back(std::move(frame));
    }
    return frames;
}

} // namespace silverdaw::waveform
