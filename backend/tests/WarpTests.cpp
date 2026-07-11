// Warp: time-stretch correctness and timeline duration mapping.

#include "TestRegistry.h"

#include "AudioEngine.h"
#include "AudioConstants.h"
#include "BridgeAuth.h"
#include "EdgeFadeSnapshot.h"
#include "LoudnessAnalyzer.h"
#include "Leveler.h"
#include "MixdownEngine.h"
#include "OffsetSource.h"
#include "PayloadHelpers.h"
#include "PeaksCache.h"
#include "ProjectFile.h"
#include "ProjectState.h"
#include "SharedFx.h"
#include "ToneEq.h"
#include "ValueTreeJson.h"
#include "WarpProcessor.h"

#include <atomic>
#include <array>
#include <chrono>
#include <cmath>
#include <exception>
#include <limits>
#include <string>
#include <thread>
#include <vector>

#include <juce_events/juce_events.h>

namespace silverdaw::tests
{
namespace
{

void testWarpProcessorBasicStretch()
{
    // Smoke test: build a WarpProcessor, feed it a unit-amplitude sine
    // wave at native rate, and verify it produces samples that look
    // like audio (non-zero, finite, within range). This is enough to
    // confirm the Rubber Band integration actually links and runs;
    // detailed correctness tests (steady-state ratio, seek handling,
    // pitch independence) belong in the next pass.
    constexpr double kSampleRate = 48000.0;
    constexpr int kChannels = 2;
    constexpr int kBlockSamples = 512;
    silverdaw::WarpProcessor warp(kChannels, kSampleRate,
                                   RubberBand::RubberBandStretcher::OptionEngineFaster);
    warp.prepareToPlay(kBlockSamples);
    warp.setTempoRatio(1.25); // play 25 % faster
    warp.setPitchScale(1.0);

    std::vector<std::vector<float>> outBuffers(kChannels, std::vector<float>(kBlockSamples, 0.0f));
    std::vector<float*> outPtrs(kChannels);
    for (int c = 0; c < kChannels; ++c) outPtrs[c] = outBuffers[c].data();

    // Source-read callback feeds a 440 Hz sine wave at the requested
    // source position. Phase computed from the absolute sample index so
    // it stays continuous across blocks.
    auto readSource = [&](float* const* dest, juce::int64 sourcePos, int n)
    {
        for (int c = 0; c < kChannels; ++c)
        {
            for (int i = 0; i < n; ++i)
            {
                const double phase = 2.0 * juce::MathConstants<double>::pi * 440.0
                                     * static_cast<double>(sourcePos + i) / kSampleRate;
                dest[c][i] = static_cast<float>(std::sin(phase) * 0.5);
            }
        }
    };

    // Run a few blocks so the stretcher's start-pad + steady-state
    // ramp has time to produce real output.
    int totalProduced = 0;
    bool sawNonZero = false;
    for (int block = 0; block < 8; ++block)
    {
        const int produced = warp.process(outPtrs.data(), kBlockSamples, readSource);
        totalProduced += produced;
        for (int c = 0; c < kChannels; ++c)
        {
            for (int i = 0; i < produced; ++i)
            {
                const float v = outBuffers[c][i];
                require(std::isfinite(v), "warp produced non-finite sample");
                require(std::abs(v) <= 1.5f, "warp produced wildly out-of-range sample");
                if (std::abs(v) > 1e-4f) sawNonZero = true;
            }
        }
    }
    require(sawNonZero, "warp produced no audible output across 8 blocks");

    // Device reconfiguration may increase the host block size after audio has
    // already passed through Rubber Band. Preparing again must remain valid.
    warp.prepareToPlay(8192);
    const int producedAfterReprepare =
        warp.process(outPtrs.data(), kBlockSamples, readSource);
    require(producedAfterReprepare == kBlockSamples,
            "warp must keep producing after a larger re-prepare");
}

void testWarpTimelineDurationMapping()
{
    require(silverdaw::WarpProcessor::timelineSamplesForSourceSamples(4000, 1.0) == 4000,
            "unwarped duration should remain in source samples");

    silverdaw::WarpProcessor faster(2, 48000.0, RubberBand::RubberBandStretcher::OptionEngineFaster);
    faster.prepareToPlay(512);
    faster.setTempoRatio(2.0);
    require(silverdaw::WarpProcessor::timelineSamplesForSourceSamples(4000, faster.getTempoRatio()) == 2000,
            "2x tempo ratio should halve visible timeline duration");

    silverdaw::WarpProcessor slower(2, 48000.0, RubberBand::RubberBandStretcher::OptionEngineFaster);
    slower.prepareToPlay(512);
    slower.setTempoRatio(0.5);
    require(silverdaw::WarpProcessor::timelineSamplesForSourceSamples(4000, slower.getTempoRatio()) == 8000,
            "0.5x tempo ratio should double visible timeline duration");
}

void testOffsetSourceChunksOversizedWarpRequests()
{
    constexpr double sampleRate = 48000.0;
    constexpr int preparedBlock = 256;
    constexpr int requestedSamples = 10000;

    for (const double ratio : {0.25, 1.25, 4.0})
    {
        ConstantSource child(0.25F);
        silverdaw::WarpProcessor warp(
            1, sampleRate, RubberBand::RubberBandStretcher::OptionEngineFaster);
        warp.setTempoRatio(ratio);
        warp.setPitchScale(1.0);

        silverdaw::OffsetSource source(&child);
        source.setOffsetSamples(0);
        source.setInSourceSamples(0);
        source.setClipDurationSamples(50000);
        source.setWarpProcessor(&warp);
        source.prepareToPlay(preparedBlock, sampleRate);

        juce::AudioBuffer<float> output(2, requestedSamples);
        output.clear();
        juce::AudioSourceChannelInfo info(&output, 0, requestedSamples);
        source.getNextAudioBlock(info);

        bool sawAudio = false;
        int silentRun = 0;
        int longestSilentRun = 0;
        for (int ch = 0; ch < output.getNumChannels(); ++ch)
        {
            silentRun = 0;
            for (int i = 0; i < requestedSamples; ++i)
            {
                const float sample = output.getSample(ch, i);
                require(std::isfinite(sample), "oversized warped read must stay finite");
                if (std::abs(sample) > 1.0e-4F)
                {
                    sawAudio = true;
                    silentRun = 0;
                }
                else
                {
                    longestSilentRun = juce::jmax(longestSilentRun, ++silentRun);
                }
            }
        }
        require(sawAudio, "oversized warped read must produce audio across scratch chunks");
        require(longestSilentRun < preparedBlock,
                "oversized warped read must not insert a silent seam between chunks");
    }

    silverdaw::WarpProcessor boundedChannels(
        32, sampleRate, RubberBand::RubberBandStretcher::OptionEngineFaster);
    require(boundedChannels.getNumChannels() == silverdaw::WarpProcessor::kMaxChannels,
            "warp channel count must stay within the preallocated pointer capacity");

    ConstantSource unclippedChild(0.25F);
    silverdaw::WarpProcessor clippedWarp(
        1, sampleRate, RubberBand::RubberBandStretcher::OptionEngineFaster);
    clippedWarp.setPitchScale(1.1);
    silverdaw::OffsetSource clippedSource(&unclippedChild);
    clippedSource.setOffsetSamples(0);
    clippedSource.setInSourceSamples(100);
    clippedSource.setClipDurationSamples(512);
    clippedSource.setWarpProcessor(&clippedWarp);
    clippedSource.prepareToPlay(preparedBlock, sampleRate);

    juce::AudioBuffer<float> clippedOutput(1, 5000);
    juce::AudioSourceChannelInfo clippedInfo(&clippedOutput, 0, clippedOutput.getNumSamples());
    clippedSource.getNextAudioBlock(clippedInfo);
    require(clippedOutput.getMagnitude(0, 4000, 1000) < 1.0e-4F,
            "warped reads must not leak source audio beyond the trimmed clip window");
}

} // namespace

void addWarpTests(std::vector<TestCase>& tests)
{
    tests.push_back({"WarpProcessor basic real-time stretch", testWarpProcessorBasicStretch});
    tests.push_back({"Warp timeline duration mapping", testWarpTimelineDurationMapping});
    tests.push_back({"OffsetSource chunks oversized warp requests", testOffsetSourceChunksOversizedWarpRequests});
}

} // namespace silverdaw::tests
