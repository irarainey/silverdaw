#include "Waveform.h"
#include "Log.h"

#include <algorithm>
#include <array>
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

    // Lane 0 is always the mono summary. Stereo (exactly 2-channel) files
    // additionally store per-channel left/right lanes so the renderer can
    // draw a stacked stereo waveform; mono and >2-channel files store the
    // summary only. Keep this policy in lockstep with the renderer's
    // `computePeaks` in `audio.ts`.
    const bool stereo = numChannels == 2;
    const int laneCount = stereo ? 3 : 1;
    result.laneCount = laneCount;

    // Channel-major layout: lane L spans [L*peakCount*2 .. (L+1)*peakCount*2).
    // Two floats per bucket (min, max), default-initialised to 0.0F.
    result.peaks.assign(static_cast<std::size_t>(peakCount) * 2U * static_cast<std::size_t>(laneCount), 0.0F);

    juce::AudioBuffer<float> buffer(numChannels, kChunkSamples);

    juce::int64 readPos = 0;
    int peakIndex = 0;
    int bucketCount = 0;
    // Sentinel values for std::min/max so the first sample of each
    // bucket always replaces them. Avoids a special-case branch on
    // the first sample of every bucket. One (min,max) accumulator per lane.
    constexpr int kMaxLanes = 3;
    const float inf = std::numeric_limits<float>::infinity();
    std::array<float, kMaxLanes> laneMin;
    std::array<float, kMaxLanes> laneMax;
    laneMin.fill(inf);
    laneMax.fill(-inf);
    const float invChannels = numChannels > 0 ? 1.0F / static_cast<float>(numChannels) : 1.0F;

    const auto flushBucket = [&]()
    {
        if (peakIndex < peakCount)
        {
            for (int lane = 0; lane < laneCount; ++lane)
            {
                const auto base = (static_cast<std::size_t>(lane) * static_cast<std::size_t>(peakCount) +
                                   static_cast<std::size_t>(peakIndex)) *
                                  2U;
                result.peaks[base] = laneMin[static_cast<std::size_t>(lane)];
                result.peaks[base + 1U] = laneMax[static_cast<std::size_t>(lane)];
            }
        }
    };

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
            // Lane 0: average across channels for a mono summary peak.
            float sum = 0.0F;
            for (int c = 0; c < numChannels; ++c)
            {
                sum += buffer.getReadPointer(c)[i];
            }
            const float summary = sum * invChannels;
            laneMin[0] = std::min(summary, laneMin[0]);
            laneMax[0] = std::max(summary, laneMax[0]);

            // Lanes 1..2: raw per-channel samples (stereo only).
            if (stereo)
            {
                for (int c = 0; c < 2; ++c)
                {
                    const float v = buffer.getReadPointer(c)[i];
                    const auto lane = static_cast<std::size_t>(c) + 1U;
                    laneMin[lane] = std::min(v, laneMin[lane]);
                    laneMax[lane] = std::max(v, laneMax[lane]);
                }
            }

            ++bucketCount;
            if (bucketCount >= samplesPerPeak)
            {
                flushBucket();
                ++peakIndex;
                bucketCount = 0;
                laneMin.fill(inf);
                laneMax.fill(-inf);
            }
        }

        readPos += toRead;
    }

    if (bucketCount > 0 && peakIndex < peakCount)
    {
        flushBucket();
    }

    const auto elapsedMs = juce::Time::getMillisecondCounterHiRes() - startMs;
    silverdaw::log::info("waveform", "compute done " + file.getFileName() + " peaks=" + juce::String(peakCount) +
                                          " lanes=" + juce::String(laneCount) + " ms=" + juce::String(elapsedMs, 1));
    return result;
}

} // namespace silverdaw::waveform
