// Plugin delay compensation (ADR 0026): the LatencyDelayLine primitive that aligns tracks
// behind the slowest chain, and the BusGraph alignment it is driven from.

#include "TestRegistry.h"

#include "BusGraph.h"
#include "LatencyDelayLine.h"

#include <vector>

namespace silverdaw::tests
{
namespace
{

constexpr int kBlock = 64;

// Fills a stereo block with a ramp continuing from `firstSample` and returns what the line
// produced, so a caller can assert exactly which input samples came out where.
std::vector<float> pushRamp(LatencyDelayLine& line, int firstSample, int numSamples)
{
    juce::AudioBuffer<float> buffer(2, numSamples);
    for (int ch = 0; ch < 2; ++ch)
    {
        auto* d = buffer.getWritePointer(ch);
        for (int i = 0; i < numSamples; ++i) d[i] = static_cast<float>(firstSample + i);
    }
    line.process(buffer, 0, numSamples);

    std::vector<float> out(static_cast<size_t>(numSamples));
    const auto* left = buffer.getReadPointer(0);
    const auto* right = buffer.getReadPointer(1);
    for (int i = 0; i < numSamples; ++i)
    {
        require(left[i] == right[i], "LatencyDelayLine channels diverged");
        out[static_cast<size_t>(i)] = left[i];
    }
    return out;
}

void testZeroDelayIsBitExactPassthrough()
{
    LatencyDelayLine line;
    line.setDelaySamples(0);
    line.prepare(2, 1024, kBlock);

    for (int block = 0; block < 4; ++block)
    {
        const int first = block * kBlock;
        const auto out = pushRamp(line, first, kBlock);
        for (int i = 0; i < kBlock; ++i)
            require(out[static_cast<size_t>(i)] == static_cast<float>(first + i),
                    "Zero delay must be bit-exact passthrough");
    }
}

void testPreparedDelayShiftsBySampleCount()
{
    constexpr int kDelay = 100;
    LatencyDelayLine line;
    // Set before prepare, so the line starts already at the delay with no crossfade.
    line.setDelaySamples(kDelay);
    line.prepare(2, 1024, kBlock);
    require(line.getDelaySamples() == kDelay, "Delay target should be readable back");

    std::vector<float> stream;
    for (int block = 0; block < 6; ++block)
    {
        const auto out = pushRamp(line, block * kBlock, kBlock);
        stream.insert(stream.end(), out.begin(), out.end());
    }

    for (int i = 0; i < static_cast<int>(stream.size()); ++i)
    {
        const float expected = i < kDelay ? 0.0F : static_cast<float>(i - kDelay);
        require(stream[static_cast<size_t>(i)] == expected,
                "Prepared delay must shift the stream by exactly the sample count");
    }
}

void testDelayIsClampedToPreparedMaximum()
{
    constexpr int kMax = 128;
    LatencyDelayLine line;
    line.setDelaySamples(100000);
    line.prepare(2, kMax, kBlock);

    std::vector<float> stream;
    for (int block = 0; block < 6; ++block)
    {
        const auto out = pushRamp(line, block * kBlock, kBlock);
        stream.insert(stream.end(), out.begin(), out.end());
    }

    for (int i = 0; i < static_cast<int>(stream.size()); ++i)
    {
        const float expected = i < kMax ? 0.0F : static_cast<float>(i - kMax);
        require(stream[static_cast<size_t>(i)] == expected,
                "An oversized delay must clamp to the prepared maximum");
    }
}

void testDelayChangeCrossfadesThenSettles()
{
    constexpr int kDelay = 32;
    LatencyDelayLine line;
    line.prepare(2, 1024, kBlock);

    // Dry to begin with, so the crossfade has a known starting point.
    const auto dry = pushRamp(line, 0, kBlock);
    require(dry[0] == 0.0F && dry[kBlock - 1] == static_cast<float>(kBlock - 1),
            "Line should start dry");

    line.setDelaySamples(kDelay);
    const auto fading = pushRamp(line, kBlock, kBlock);
    // The crossfade must move monotonically from dry towards delayed without a jump.
    require(fading[0] > static_cast<float>(kBlock) - 2.0F,
            "The crossfade must start from the dry signal, not jump to the delayed one");
    require(fading[kBlock - 1] == static_cast<float>((2 * kBlock - 1) - kDelay),
            "The crossfade must land exactly on the delayed signal by the end of the block");

    for (int block = 2; block < 5; ++block)
    {
        const int first = block * kBlock;
        const auto out = pushRamp(line, first, kBlock);
        for (int i = 0; i < kBlock; ++i)
            require(out[static_cast<size_t>(i)] == static_cast<float>(first + i - kDelay),
                    "Once settled the delay must be exact");
    }
}

void testRequestResetDropsTheTailOnTheNextBlock()
{
    constexpr int kDelay = 32;
    LatencyDelayLine line;
    line.setDelaySamples(kDelay);
    line.prepare(2, 1024, kBlock);

    // Fill the line so it is holding real audio.
    pushRamp(line, 0, kBlock);
    pushRamp(line, kBlock, kBlock);

    line.requestReset();
    const auto out = pushRamp(line, 1000, kBlock);
    for (int i = 0; i < kDelay; ++i)
        require(out[static_cast<size_t>(i)] == 0.0F,
                "A reset must drop the held tail rather than replay stale audio");
    for (int i = kDelay; i < kBlock; ++i)
        require(out[static_cast<size_t>(i)] == static_cast<float>(1000 + i - kDelay),
                "A reset must keep the delay, only the history is cleared");
}

void testBusGraphHasNoAlignmentWithoutPlugins()
{
    BusGraph graph;
    graph.prepareToPlay(512, 48000.0);
    require(graph.getLatencyCompensationSamples() == 0,
            "A graph with no plugin inserts must not delay anything");
    require(graph.getPreparedBlockSize() == 512, "The prepared block size should be reported back");

    graph.resetLatencyCompensation();
    require(graph.getLatencyCompensationSamples() == 0,
            "Resetting compensation must not invent an alignment");
    graph.releaseResources();
}

} // namespace

void addPluginLatencyTests(std::vector<TestCase>& tests)
{
    tests.push_back({"LatencyDelayLine at zero delay is bit-exact passthrough", testZeroDelayIsBitExactPassthrough});
    tests.push_back({"LatencyDelayLine shifts the stream by exactly the prepared delay", testPreparedDelayShiftsBySampleCount});
    tests.push_back({"LatencyDelayLine clamps an oversized delay to the prepared maximum", testDelayIsClampedToPreparedMaximum});
    tests.push_back({"LatencyDelayLine crossfades a delay change and then settles exactly", testDelayChangeCrossfadesThenSettles});
    tests.push_back({"LatencyDelayLine requestReset drops the tail on the next block", testRequestResetDropsTheTailOnTheNextBlock});
    tests.push_back({"BusGraph reports no plugin alignment without inserts", testBusGraphHasNoAlignmentWithoutPlugins});
}

} // namespace silverdaw::tests
