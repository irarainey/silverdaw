#include "TestRegistry.h"

#include "scratch/BackingMonitorSource.h"

#include <cmath>
#include <memory>
#include <vector>

namespace silverdaw::tests
{
namespace
{
using silverdaw::scratch::BackingMonitorSource;

constexpr double kSampleRate = 48000.0;

// Build a stereo ramp buffer where sample n holds value n on both channels.
std::shared_ptr<const juce::AudioBuffer<float>> makeRamp(int numSamples)
{
    auto buffer = std::make_shared<juce::AudioBuffer<float>>(2, numSamples);
    for (int ch = 0; ch < buffer->getNumChannels(); ++ch)
        for (int i = 0; i < numSamples; ++i)
            buffer->setSample(ch, i, static_cast<float>(i));
    return buffer;
}

// Pull one block through the source. The mixer contract requires each input to
// overwrite its provided buffer, so start from a non-zero buffer to verify that.
void pullBlock(BackingMonitorSource& source, juce::AudioBuffer<float>& out)
{
    for (int ch = 0; ch < out.getNumChannels(); ++ch)
        for (int i = 0; i < out.getNumSamples(); ++i)
            out.setSample(ch, i, 99.0F);
    juce::AudioSourceChannelInfo info(&out, 0, out.getNumSamples());
    source.getNextAudioBlock(info);
}

void testBackingInactiveIsSilent()
{
    BackingMonitorSource source;
    source.prepareToPlay(512, kSampleRate);
    juce::AudioBuffer<float> out(2, 8);
    pullBlock(source, out);
    for (int i = 0; i < out.getNumSamples(); ++i)
        requireNear(out.getSample(0, i), 0.0F, 1.0e-9,
                    "inactive backing source should overwrite its buffer with silence");
}

void testBackingPlaysForwardAtNominalRate()
{
    BackingMonitorSource source;
    source.prepareToPlay(512, kSampleRate);
    source.activate(makeRamp(256), kSampleRate);
    source.setPlaying(true);
    juce::AudioBuffer<float> out(2, 8);
    pullBlock(source, out);
    for (int i = 0; i < out.getNumSamples(); ++i)
        requireNear(out.getSample(0, i), static_cast<float>(i), 1.0e-4,
                    "nominal-rate backing playback should read ascending source samples");
}

void testBackingLatchesEndReached()
{
    BackingMonitorSource source;
    source.prepareToPlay(512, kSampleRate);
    source.activate(makeRamp(16), kSampleRate);
    source.setPlaying(true);
    juce::AudioBuffer<float> out(2, 32);
    pullBlock(source, out);
    require(source.consumeEndReached(),
            "reaching the window end should latch end-reached exactly once");
    require(!source.consumeEndReached(),
            "end-reached should clear after being consumed");
    require(!source.isPlaying(),
            "reaching the window end should stop forward playback");
}

void testBackingSeekRepositionsCursor()
{
    BackingMonitorSource source;
    source.prepareToPlay(512, kSampleRate);
    source.activate(makeRamp(256), kSampleRate);
    const auto us = static_cast<std::int64_t>(100.0 * 1000000.0 / kSampleRate);
    source.seekUs(us);
    source.setPlaying(true);
    juce::AudioBuffer<float> out(2, 8);
    pullBlock(source, out);
    requireNear(out.getSample(0, 0), 100.0F, 2.0,
                "seek should reposition the read cursor near the requested sample");
}

void testBackingGainScalesOutput()
{
    BackingMonitorSource source;
    source.prepareToPlay(512, kSampleRate);
    source.activate(makeRamp(256), kSampleRate);
    source.setGain(0.5F);
    source.setPlaying(true);
    juce::AudioBuffer<float> out(2, 8);
    pullBlock(source, out);
    for (int i = 1; i < out.getNumSamples(); ++i)
        requireNear(out.getSample(0, i), 0.5F * static_cast<float>(i), 1.0e-4,
                    "monitor gain should scale the backing output linearly");
}

void testBackingDeactivateSilencesOutput()
{
    BackingMonitorSource source;
    source.prepareToPlay(512, kSampleRate);
    source.activate(makeRamp(256), kSampleRate);
    source.setPlaying(true);
    source.deactivate();
    require(!source.isActive(), "deactivate should mark the source inactive");
    juce::AudioBuffer<float> out(2, 8);
    pullBlock(source, out);
    for (int i = 0; i < out.getNumSamples(); ++i)
        requireNear(out.getSample(0, i), 0.0F, 1.0e-9,
                    "a deactivated backing source should output silence");
}

void testBackingReportsDuration()
{
    BackingMonitorSource source;
    source.prepareToPlay(512, kSampleRate);
    source.activate(makeRamp(static_cast<int>(kSampleRate)), kSampleRate);
    requireNear(static_cast<double>(source.durationUs()), 1000000.0, 1.0,
                "one second of source at the session rate should report a 1s duration");
}
} // namespace

void addBackingMonitorSourceTests(std::vector<TestCase>& tests)
{
    tests.push_back({"backing monitor inactive is silent", testBackingInactiveIsSilent});
    tests.push_back({"backing monitor plays forward at nominal rate", testBackingPlaysForwardAtNominalRate});
    tests.push_back({"backing monitor latches end-reached", testBackingLatchesEndReached});
    tests.push_back({"backing monitor seek repositions cursor", testBackingSeekRepositionsCursor});
    tests.push_back({"backing monitor gain scales output", testBackingGainScalesOutput});
    tests.push_back({"backing monitor deactivate silences output", testBackingDeactivateSilencesOutput});
    tests.push_back({"backing monitor reports duration", testBackingReportsDuration});
}

} // namespace silverdaw::tests
