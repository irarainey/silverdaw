#include "TestRegistry.h"

#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <juce_audio_basics/juce_audio_basics.h>
#include <limits>
#include <optional>

// Compile the pinned unpatched state machine separately for differential checks.
namespace silverdaw_resampling_reference
{
using namespace juce;
}
// clang-format off: JUCE's amalgamated implementation needs its declarations first.
#include "SilverdawScalarResampling.h"
#include "SilverdawScalarResampling.cpp"
// clang-format on

namespace silverdaw::tests
{
namespace
{
struct ReadRequest
{
    juce::int64 position;
    int start;
    int count;
    bool operator==(const ReadRequest& other) const noexcept
    {
        return position == other.position && start == other.start && count == other.count;
    }
};

class RecordedSource final : public juce::AudioSource
{
  public:
    explicit RecordedSource(bool special) : special(special) {}
    void prepareToPlay(int, double) override
    {
        position = 0;
        reads.clear();
        reads.reserve(1024);
    }
    void releaseResources() override {}
    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override
    {
        reads.push_back({position, info.startSample, info.numSamples});
        for (int ch = 0; ch < info.buffer->getNumChannels(); ++ch)
            for (int i = 0; i < info.numSamples; ++i)
                info.buffer->setSample(ch, info.startSample + i, valueAt(position + i, ch));
        position += info.numSamples;
    }
    std::vector<ReadRequest> reads;

  private:
    float valueAt(juce::int64 sample, int channel) const noexcept
    {
        const auto index = static_cast<std::uint32_t>(sample) + static_cast<std::uint32_t>(channel * 7);
        if (special)
        {
            const std::array<float, 8> values{-0.0F,
                                              0.0F,
                                              std::numeric_limits<float>::quiet_NaN(),
                                              -std::numeric_limits<float>::quiet_NaN(),
                                              std::numeric_limits<float>::infinity(),
                                              -std::numeric_limits<float>::infinity(),
                                              std::numeric_limits<float>::denorm_min(),
                                              -std::numeric_limits<float>::denorm_min()};
            if (index % 31 < values.size())
                return values[index % 31];
        }
        return static_cast<float>(static_cast<int>((index * 1664525U + 1013904223U) % 1024) - 512) / 512.0F;
    }
    bool special;
    juce::int64 position = 0;
};

std::uint32_t sampleBits(float value) noexcept
{
    std::uint32_t bits;
    std::memcpy(&bits, &value, sizeof(bits));
    return bits;
}

void requireSameSamples(const juce::AudioBuffer<float>& actual, const juce::AudioBuffer<float>& expected)
{
    for (int ch = 0; ch < actual.getNumChannels(); ++ch)
        for (int i = 0; i < actual.getNumSamples(); ++i)
        {
            const float a = actual.getSample(ch, i), b = expected.getSample(ch, i);
            if (std::isnan(a) && std::isnan(b))
                continue;
            require(sampleBits(a) == sampleBits(b),
                    "resampling must match scalar output, including guards and signed zero");
        }
}

void compareResamplers(bool special, bool suppressDenormals, bool transitions)
{
    std::optional<juce::ScopedNoDenormals> denormals;
    if (suppressDenormals)
        denormals.emplace();
    for (int sourceChannels : {1, 2})
    {
        RecordedSource actualSource(special), referenceSource(special);
        juce::ResamplingAudioSource actual(&actualSource, false, sourceChannels);
        silverdaw_resampling_reference::ResamplingAudioSource reference(&referenceSource, false, sourceChannels);
        actual.prepareToPlay(512, 48000.0);
        reference.prepareToPlay(512, 48000.0);
        const std::vector<double> ratios = transitions ? std::vector<double>{1.0, 1.00005, 1.0, 0.5, 1.0, 2.0, 1.0}
                                                       : std::vector<double>{1.0, 1.0, 1.0};
        for (std::size_t phase = 0; phase < ratios.size(); ++phase)
        {
            actual.setResamplingRatio(ratios[phase]);
            reference.setResamplingRatio(ratios[phase]);
            if (phase == 3 || phase == 5)
            {
                actual.flushBuffers();
                reference.flushBuffers();
            }
            for (int callerChannels : {0, 1, 2, 3})
                for (int count : {0, 1, 2, 3, 63, 224, 256, 480, 1024, 2049})
                {
                    constexpr int offset = 5;
                    juce::AudioBuffer<float> result(callerChannels, count + offset + 3);
                    juce::AudioBuffer<float> expected(callerChannels, count + offset + 3);
                    for (int ch = 0; ch < callerChannels; ++ch)
                    {
                        juce::FloatVectorOperations::fill(result.getWritePointer(ch), -99.0F, result.getNumSamples());
                        juce::FloatVectorOperations::fill(expected.getWritePointer(ch), -99.0F,
                                                          expected.getNumSamples());
                    }
                    actual.getNextAudioBlock({&result, offset, count});
                    reference.getNextAudioBlock({&expected, offset, count});
                    require(actualSource.reads == referenceSource.reads,
                            "unity resampling must preserve source pulls, lookahead and positions");
                    requireSameSamples(result, expected);
                }
        }
        actual.setResamplingRatio(1.0);
        reference.setResamplingRatio(1.0);
        actual.prepareToPlay(256, 44100.0);
        reference.prepareToPlay(256, 44100.0);
        juce::AudioBuffer<float> a(2, 224), b(2, 224);
        a.clear();
        b.clear();
        actual.getNextAudioBlock({&a, 0, 224});
        reference.getNextAudioBlock({&b, 0, 224});
        require(actualSource.reads == referenceSource.reads, "reprepare must preserve input pulls");
        requireSameSamples(a, b);
        actual.releaseResources();
        reference.releaseResources();
    }
}
} // namespace

void addResamplingTests(std::vector<TestCase>& tests)
{
    tests.push_back({"Unity resampling matches scalar output and source advancement across wraps", []
                     {
                         compareResamplers(false, false, false);
                         compareResamplers(false, false, true);
                     }});
    tests.push_back({"Unity resampling preserves IEEE propagation and rate-transition state", []
                     {
                         compareResamplers(true, false, true);
                         compareResamplers(true, true, true);
                     }});
}
} // namespace silverdaw::tests
