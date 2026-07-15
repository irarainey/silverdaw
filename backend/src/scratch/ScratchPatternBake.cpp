#include "ScratchPatternBake.h"

#include "ScratchAudioSource.h"
#include "ScratchPatternEvaluator.h"

#include <algorithm>
#include <cmath>

namespace silverdaw::scratch
{

namespace
{
constexpr int kBakeBlockSize = 512;
constexpr int kBakeChannels = 2;
// Hard safety ceiling so a malformed pattern can never spin the render loop
// unbounded; 30 minutes at 96 kHz far exceeds any real take.
constexpr std::int64_t kMaxBakeSamples = 96000LL * 60 * 30;
} // namespace

juce::AudioBuffer<float> bakePatternToBuffer(
    const Pattern& pattern,
    std::shared_ptr<const juce::AudioBuffer<float>> preparedSource,
    double sampleRate)
{
    juce::AudioBuffer<float> output;

    if (preparedSource == nullptr || preparedSource->getNumSamples() <= 0
        || sampleRate <= 0.0)
    {
        return output;
    }

    const auto snapshot = ScratchPatternEvaluator::buildSnapshot(pattern);
    if (snapshot.empty())
        return output;

    const auto durationUs = snapshot.durationUs();
    if (durationUs <= 0)
        return output;

    auto totalSamples = static_cast<std::int64_t>(
        std::llround(static_cast<double>(durationUs) * sampleRate / 1000000.0));
    totalSamples = std::clamp<std::int64_t>(totalSamples, 1, kMaxBakeSamples);

    output.setSize(kBakeChannels, static_cast<int>(totalSamples));
    output.clear();

    ScratchAudioSource source(preparedSource, sampleRate);
    source.prepareToPlay(kBakeBlockSize, sampleRate);
    source.beginPatternReplay(&snapshot);
    source.setPlaying(true);

    juce::AudioBuffer<float> block(kBakeChannels, kBakeBlockSize);
    std::int64_t rendered = 0;
    while (rendered < totalSamples)
    {
        const auto want = static_cast<int>(
            std::min<std::int64_t>(kBakeBlockSize, totalSamples - rendered));
        block.clear();
        juce::AudioSourceChannelInfo info(&block, 0, want);
        source.getNextAudioBlock(info);

        for (int ch = 0; ch < kBakeChannels; ++ch)
            output.copyFrom(ch, static_cast<int>(rendered), block, ch, 0, want);

        rendered += want;

        // The pattern reached its end mid-block; the remaining tail is silence.
        if (source.consumeEndReached())
            break;
    }

    source.endPatternReplay();
    return output;
}

} // namespace silverdaw::scratch
