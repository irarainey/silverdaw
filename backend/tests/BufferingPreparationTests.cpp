#include "AudioConstants.h"
#include "TestRegistry.h"

#include <atomic>
#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw::tests
{
namespace
{
class SlowPrefillSource final : public juce::PositionableAudioSource
{
  public:
    void prepareToPlay(int, double) override
    {
        ++generation;
    }
    void releaseResources() override {}
    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override
    {
        juce::Thread::sleep(10);
        const float value = static_cast<float>(generation.load());
        for (int channel = 0; channel < info.buffer->getNumChannels(); ++channel)
            juce::FloatVectorOperations::fill(info.buffer->getWritePointer(channel, info.startSample), value,
                                              info.numSamples);
        position.fetch_add(info.numSamples);
    }
    void setNextReadPosition(juce::int64 next) override
    {
        position.store(next);
    }
    juce::int64 getNextReadPosition() const override
    {
        return position.load();
    }
    juce::int64 getTotalLength() const override
    {
        return 96000;
    }
    bool isLooping() const override
    {
        return false;
    }

  private:
    std::atomic<int> generation{0};
    std::atomic<juce::int64> position{0};
};

void testPreparationRetainsColdAndRepreparedPrefix()
{
    SlowPrefillSource source;
    juce::TimeSliceThread readAhead("buffer-preparation-test");
    readAhead.startThread();
    {
        juce::BufferingAudioSource buffering(&source, readAhead, false, kTransportReadAheadSamples, 2);
        for (int generation = 1; generation <= 2; ++generation)
        {
            buffering.setNextReadPosition(generation == 1 ? 0 : 16000);
            buffering.prepareToPlay(512, generation == 1 ? 44100.0 : 48000.0);
            juce::AudioBuffer<float> block(2, kTransportReadAheadSamples / 2);
            block.clear();
            // No extra readiness wait: prepare itself must retain the deep prefill barrier.
            buffering.getNextAudioBlock({&block, 0, block.getNumSamples()});
            for (int channel = 0; channel < block.getNumChannels(); ++channel)
                for (int sample = 0; sample < block.getNumSamples(); ++sample)
                    require(block.getSample(channel, sample) == static_cast<float>(generation),
                            "cold and re-prepared prefixes must contain only the current source audio");
        }
        buffering.releaseResources();
    }
    readAhead.stopThread(2000);
}
} // namespace

void addBufferingPreparationTests(std::vector<TestCase>& tests)
{
    tests.push_back(
        {"Buffering preparation retains cold and re-prepared audio", testPreparationRetainsColdAndRepreparedPrefix});
}
} // namespace silverdaw::tests
