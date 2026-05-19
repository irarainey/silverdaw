#include "BpmDetector.h"

#include "Log.h"

#include <BTrack.h>
#include <algorithm>
#include <juce_audio_basics/juce_audio_basics.h>
#include <numeric>
#include <samplerate.h>
#include <memory>
#include <vector>

namespace silverdaw
{

BpmAnalysis BpmDetector::analyse(const juce::File& audioFile, juce::AudioFormatManager& formatManager)
{
    BpmAnalysis result;
    if (!audioFile.existsAsFile())
    {
        return result;
    }

    std::unique_ptr<juce::AudioFormatReader> reader(formatManager.createReaderFor(audioFile));
    if (reader == nullptr)
    {
        silverdaw::log::warn("bpm", "createReaderFor failed for " + audioFile.getFileName());
        return result;
    }
    const double sourceSampleRate = reader->sampleRate;
    if (sourceSampleRate <= 0.0 || reader->numChannels == 0 || reader->lengthInSamples <= 0)
    {
        return result;
    }

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
            return result;
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

    // ──────────────────────────────────────────────────────────────────
    // Step 2: resample to BTrack's expected 44.1 kHz mono using
    // libsamplerate (`src_simple`, one-shot conversion of the whole
    // buffer).
    // ──────────────────────────────────────────────────────────────────
    std::vector<float> resampled;
    if (std::abs(sourceSampleRate - kAnalysisSampleRate) < 0.001)
    {
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
            return result;
        }
        resampled.resize(static_cast<size_t>(srcData.output_frames_gen));
    }

    // ──────────────────────────────────────────────────────────────────
    // Step 3: feed BTrack frame-by-frame and record beat events.
    // We map the analysis sample rate's frame index back to source
    // time so the beat positions remain meaningful regardless of the
    // source's original sample rate.
    // ──────────────────────────────────────────────────────────────────
    BTrack bt(kHopSize, kFrameSize);
    std::vector<double> hopBuffer(static_cast<size_t>(kHopSize), 0.0);
    std::vector<double> beatTimes;
    std::vector<double> tempoSamples;
    const size_t totalFrames = resampled.size();
    size_t hopIndex = 0;
    for (size_t pos = 0; pos + static_cast<size_t>(kHopSize) <= totalFrames;
         pos += static_cast<size_t>(kHopSize), ++hopIndex)
    {
        for (int i = 0; i < kHopSize; ++i)
        {
            hopBuffer[static_cast<size_t>(i)] = static_cast<double>(resampled[pos + static_cast<size_t>(i)]);
        }
        bt.processAudioFrame(hopBuffer.data());
        if (bt.beatDueInCurrentFrame())
        {
            const double beatTime = static_cast<double>(pos) / kAnalysisSampleRate;
            beatTimes.push_back(beatTime);
            tempoSamples.push_back(bt.getCurrentTempoEstimate());
        }
    }

    const double bpm = bt.getCurrentTempoEstimate();
    silverdaw::log::info("bpm",
                        "BTrack running estimate " + audioFile.getFileName() + ": " +
                            juce::String(bpm, 3) +
                            " (beats=" + juce::String(static_cast<int>(beatTimes.size())) + ", srcSR=" +
                            juce::String(sourceSampleRate) + ")");

    // Prefer a BPM *derived from the median beat interval* over BTrack's
    // running tempo estimate. The estimate is updated incrementally and
    // can be a fraction of a BPM off the true value implied by the beat
    // positions; using the median interval guarantees the project grid
    // we later seed lines up with the source beats we report. Median
    // (rather than mean) is robust to occasional doubled / missed beats.
    double derivedBpm = bpm;
    if (beatTimes.size() >= 6)
    {
        std::vector<double> intervals;
        intervals.reserve(beatTimes.size() - 1);
        for (size_t i = 1; i < beatTimes.size(); ++i)
        {
            const double dt = beatTimes[i] - beatTimes[i - 1];
            if (dt > 0.05 && dt < 2.0)
            {
                intervals.push_back(dt);
            }
        }
        if (intervals.size() >= 4)
        {
            std::sort(intervals.begin(), intervals.end());
            const double medianInterval = intervals[intervals.size() / 2];
            if (medianInterval > 0.0)
            {
                derivedBpm = 60.0 / medianInterval;
            }
        }
    }

    if (!std::isfinite(derivedBpm) || derivedBpm < kMinPlausibleBpm || derivedBpm > kMaxPlausibleBpm)
    {
        silverdaw::log::info("bpm",
                             "derived BPM out of range for " + audioFile.getFileName() + ": " +
                                 juce::String(derivedBpm));
        return result;
    }

    // ──────────────────────────────────────────────────────────────────
    // Step 4: tempo-stability check. BTrack's running estimate settles
    // over the first few beats; we skip those and look at the spread
    // of the remaining samples. A spread > 5 % of the mean flags the
    // clip as variable-tempo so the UI can warn the user (and the
    // first-clip-on-empty-project seeder can opt out).
    //
    // The thresholds are deliberately loose: real recordings of even
    // metronomically-perfect music carry a small amount of BTrack
    // estimator jitter (~1-3 %). 5 % keeps that out while still
    // catching clips whose tempo genuinely drifts. We also require
    // at least a dozen non-settling samples — very short clips
    // don't have enough data to draw a stable spread.
    // ──────────────────────────────────────────────────────────────────
    constexpr size_t kSettlingBeats = 4;
    constexpr size_t kMinSamplesForStabilityCheck = 12;
    constexpr double kStabilityThreshold = 0.05; // 5 %
    bool variable = false;
    if (tempoSamples.size() >= kSettlingBeats + kMinSamplesForStabilityCheck)
    {
        const auto first = tempoSamples.begin() + static_cast<std::ptrdiff_t>(kSettlingBeats);
        const double sum = std::accumulate(first, tempoSamples.end(), 0.0);
        const double count = static_cast<double>(std::distance(first, tempoSamples.end()));
        const double mean = count > 0 ? sum / count : 0.0;
        const double minV = *std::min_element(first, tempoSamples.end());
        const double maxV = *std::max_element(first, tempoSamples.end());
        if (mean > 0.0 && (maxV - minV) / mean > kStabilityThreshold)
        {
            variable = true;
            silverdaw::log::info("bpm", audioFile.getFileName() +
                                            " marked variable-tempo (min=" + juce::String(minV, 2) +
                                            " max=" + juce::String(maxV, 2) +
                                            " mean=" + juce::String(mean, 2) + ")");
        }
    }

    result.bpm = derivedBpm;
    result.beatTimesSec = std::move(beatTimes);
    result.variableTempo = variable;
    silverdaw::log::info("bpm", "estimated " + audioFile.getFileName() + " -> " +
                                    juce::String(derivedBpm, 2) + " BPM" + (variable ? " (variable)" : "") +
                                    " beats=" + juce::String(static_cast<int>(result.beatTimesSec.size())));
    return result;
}

} // namespace silverdaw

