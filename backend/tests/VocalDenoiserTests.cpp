// VocalDenoiser: offline RNNoise-based vocal-stem denoise. Verifies wet=0
// passthrough, broadband-noise reduction, silence / NaN safety, and that the
// stage preserves buffer shape and is deterministic.

#include "TestRegistry.h"

#include "VocalDenoiser.h"

#include <cmath>
#include <cstdint>
#include <limits>
#include <vector>

#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw::tests
{
namespace
{

constexpr double kSr = 44100.0;

// Deterministic pseudo-random noise in [-amp, amp], with an independent stream
// per channel so the two channels are not identical.
juce::AudioBuffer<float> makeNoise(double amp, int numFrames, int numCh, std::uint32_t seed)
{
    juce::AudioBuffer<float> b(numCh, numFrames);
    for (int ch = 0; ch < numCh; ++ch)
    {
        std::uint32_t s = seed + static_cast<std::uint32_t>(ch) * 7919u;
        float* d = b.getWritePointer(ch);
        for (int i = 0; i < numFrames; ++i)
        {
            s = s * 1664525u + 1013904223u;
            const float u = static_cast<float>(s >> 8) / static_cast<float>(1u << 24); // [0,1)
            d[i] = static_cast<float>(amp) * (u * 2.0f - 1.0f);
        }
    }
    return b;
}

double rms(const juce::AudioBuffer<float>& b, int ch, int start, int count)
{
    double sum = 0.0;
    const float* d = b.getReadPointer(ch);
    for (int i = start; i < start + count; ++i)
        sum += static_cast<double>(d[i]) * d[i];
    return std::sqrt(sum / juce::jmax(1, count));
}

bool allFinite(const juce::AudioBuffer<float>& b)
{
    for (int ch = 0; ch < b.getNumChannels(); ++ch)
    {
        const float* d = b.getReadPointer(ch);
        for (int i = 0; i < b.getNumSamples(); ++i)
            if (! std::isfinite(d[i])) return false;
    }
    return true;
}

void testWetZeroIsBitIdenticalPassthrough()
{
    auto buf = makeNoise(0.2, 8192, 2, 1);
    juce::AudioBuffer<float> original;
    original.makeCopyOf(buf);

    VocalDenoiser::process(buf, kSr, 0.0f);

    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
        for (int i = 0; i < buf.getNumSamples(); ++i)
            require(buf.getSample(ch, i) == original.getSample(ch, i),
                    "wet=0 must leave the buffer untouched");
}

void testReducesBroadbandNoise()
{
    const int n = static_cast<int>(kSr); // 1 s
    auto buf = makeNoise(0.1, n, 2, 42);
    const double before = rms(buf, 0, 0, n);

    VocalDenoiser::process(buf, kSr, 1.0f);

    require(allFinite(buf), "denoised output must stay finite");
    // Skip the first 0.2 s so the network warm-up doesn't dominate the measure.
    const int skip = static_cast<int>(0.2 * kSr);
    const double after = rms(buf, 0, skip, n - skip);
    require(after < 0.9 * before,
            "RNNoise should reduce broadband (non-speech) noise energy");
}

void testSilenceStaysSilent()
{
    juce::AudioBuffer<float> buf(2, 24000);
    buf.clear();
    VocalDenoiser::process(buf, kSr, 1.0f);
    require(allFinite(buf), "silent input must stay finite");
    require(buf.getMagnitude(0, 0, buf.getNumSamples()) < 1.0e-4f,
            "silent input must stay (near) silent");
}

void testNonFiniteInputSanitised()
{
    auto buf = makeNoise(0.2, 24000, 2, 7);
    buf.setSample(0, 1000, std::numeric_limits<float>::quiet_NaN());
    buf.setSample(1, 2000, std::numeric_limits<float>::infinity());
    VocalDenoiser::process(buf, kSr, 1.0f);
    require(allFinite(buf), "NaN/Inf samples must be sanitised to finite output");
}

void testPreservesShapeAndIsDeterministic()
{
    auto a = makeNoise(0.15, 16000, 2, 99);
    juce::AudioBuffer<float> b;
    b.makeCopyOf(a);

    VocalDenoiser::process(a, kSr, 0.75f);
    VocalDenoiser::process(b, kSr, 0.75f);

    require(a.getNumChannels() == 2 && a.getNumSamples() == 16000,
            "denoiser must preserve channel and sample counts");
    for (int ch = 0; ch < a.getNumChannels(); ++ch)
        for (int i = 0; i < a.getNumSamples(); ++i)
            require(a.getSample(ch, i) == b.getSample(ch, i),
                    "denoiser must be deterministic for identical input");
}

} // namespace

void addVocalDenoiserTests(std::vector<TestCase>& tests)
{
    tests.push_back({"VocalDenoiser wet=0 is a bit-identical passthrough",
                     testWetZeroIsBitIdenticalPassthrough});
    tests.push_back({"VocalDenoiser reduces broadband noise", testReducesBroadbandNoise});
    tests.push_back({"VocalDenoiser keeps silence silent", testSilenceStaysSilent});
    tests.push_back({"VocalDenoiser sanitises non-finite input", testNonFiniteInputSanitised});
    tests.push_back({"VocalDenoiser preserves shape and is deterministic",
                     testPreservesShapeAndIsDeterministic});
}

} // namespace silverdaw::tests
