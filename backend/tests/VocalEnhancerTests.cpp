// VocalEnhancer: offline vocal-stem cleanup (sub-bass high-pass + downward
// expander). Verifies disabled passthrough, sub-bass removal vs mid-band
// preservation, inter-phrase bleed attenuation, and silence / NaN safety.

#include "TestRegistry.h"

#include "VocalEnhancer.h"

#include <cmath>
#include <limits>
#include <vector>

#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw::tests
{
namespace
{

constexpr double kSr = 44100.0;
constexpr double kTwoPi = 2.0 * 3.14159265358979323846;

juce::AudioBuffer<float> makeSine(double freqHz, double amp, int numFrames, int numCh = 2)
{
    juce::AudioBuffer<float> b(numCh, numFrames);
    for (int ch = 0; ch < numCh; ++ch)
    {
        float* d = b.getWritePointer(ch);
        for (int i = 0; i < numFrames; ++i)
            d[i] = static_cast<float>(amp * std::sin(kTwoPi * freqHz * i / kSr));
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

double dbfs(double linear) { return 20.0 * std::log10(linear + 1.0e-12); }

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

void testDisabledIsBitIdenticalPassthrough()
{
    auto buf = makeSine(1000.0, 0.25, 8192);
    juce::AudioBuffer<float> original;
    original.makeCopyOf(buf);

    VocalEnhancer::process(buf, kSr, {/*enabled*/ false, VocalEnhanceStrength::Medium});

    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
        for (int i = 0; i < buf.getNumSamples(); ++i)
            require(buf.getSample(ch, i) == original.getSample(ch, i),
                    "disabled enhancer must leave the buffer untouched");
}

void testStrengthStringRoundTrip()
{
    require(vocalEnhanceStrengthFromString("light") == VocalEnhanceStrength::Light,
            "'light' parses to Light");
    require(vocalEnhanceStrengthFromString("STRONG") == VocalEnhanceStrength::Strong,
            "'STRONG' parses case-insensitively to Strong");
    require(vocalEnhanceStrengthFromString("") == VocalEnhanceStrength::Medium,
            "empty token falls back to Medium");
    require(vocalEnhanceStrengthFromString("nonsense") == VocalEnhanceStrength::Medium,
            "unknown token falls back to Medium");
    require(juce::String(vocalEnhanceStrengthToString(VocalEnhanceStrength::Light)) == "light",
            "Light stringifies to 'light'");
}

void testHighPassRemovesSubBassKeepsMidband()
{
    const int n = static_cast<int>(kSr); // 1 s
    auto sub = makeSine(30.0, 0.25, n);
    const double subBefore = rms(sub, 0, 0, n);
    VocalEnhancer::process(sub, kSr, {true, VocalEnhanceStrength::Medium});
    const double subAfter = rms(sub, 0, n / 4, n / 2); // central, past filter settle
    require(dbfs(subAfter) < dbfs(subBefore) - 10.0,
            "80 Hz high-pass should attenuate a 30 Hz tone by >10 dB");

    auto mid = makeSine(1000.0, 0.25, n);
    const double midBefore = rms(mid, 0, 0, n);
    VocalEnhancer::process(mid, kSr, {true, VocalEnhanceStrength::Medium});
    const double midAfter = rms(mid, 0, n / 4, n / 2);
    require(std::abs(dbfs(midAfter) - dbfs(midBefore)) < 1.5,
            "1 kHz tone above threshold should pass within ~1.5 dB");
}

void testExpanderAttenuatesQuietBleed()
{
    // Slow (150 ms) release means the envelope takes ~0.8 s to fully open after a
    // loud passage, so use a long gap and measure its settled tail.
    const int loud = static_cast<int>(kSr);      // 1 s loud
    const int quiet = static_cast<int>(3.0 * kSr); // 3 s quiet
    juce::AudioBuffer<float> buf(2, loud + quiet);
    for (int ch = 0; ch < 2; ++ch)
    {
        float* d = buf.getWritePointer(ch);
        for (int i = 0; i < loud; ++i)
            d[i] = static_cast<float>(0.7 * std::sin(kTwoPi * 1000.0 * i / kSr)); // ~-3 dBFS
        for (int i = 0; i < quiet; ++i)
            d[loud + i] = static_cast<float>(0.003 * std::sin(kTwoPi * 1000.0 * i / kSr)); // ~-50 dBFS
    }
    const int win = static_cast<int>(0.5 * kSr);
    const int loudStart = loud / 4;
    const int quietStart = (loud + quiet) - win; // settled tail of the gap
    const double loudBefore = rms(buf, 0, loudStart, win);
    const double quietBefore = rms(buf, 0, quietStart, win);

    VocalEnhancer::process(buf, kSr, {true, VocalEnhanceStrength::Medium});

    const double loudAfter = rms(buf, 0, loudStart, win);
    const double quietAfter = rms(buf, 0, quietStart, win);

    require(std::abs(dbfs(loudAfter) - dbfs(loudBefore)) < 1.0,
            "loud vocal section must be preserved by the expander");
    require(dbfs(quietAfter) < dbfs(quietBefore) - 3.0,
            "quiet inter-phrase bleed should be attenuated by >3 dB");
}

void testSilenceStaysSilentNoNaN()
{
    juce::AudioBuffer<float> buf(2, 4096);
    buf.clear();
    VocalEnhancer::process(buf, kSr, {true, VocalEnhanceStrength::Strong});
    require(allFinite(buf), "silent input must stay finite");
    require(buf.getMagnitude(0, 0, buf.getNumSamples()) == 0.0F,
            "silent input must stay silent");
}

void testNonFiniteInputSanitised()
{
    auto buf = makeSine(1000.0, 0.25, 4096);
    buf.setSample(0, 100, std::numeric_limits<float>::quiet_NaN());
    buf.setSample(1, 200, std::numeric_limits<float>::infinity());
    VocalEnhancer::process(buf, kSr, {true, VocalEnhanceStrength::Medium});
    require(allFinite(buf), "NaN/Inf samples must be sanitised to finite output");
}

} // namespace

void addVocalEnhancerTests(std::vector<TestCase>& tests)
{
    tests.push_back({"VocalEnhancer disabled is a bit-identical passthrough",
                     testDisabledIsBitIdenticalPassthrough});
    tests.push_back({"VocalEnhancer strength string round-trips", testStrengthStringRoundTrip});
    tests.push_back({"VocalEnhancer high-pass removes sub-bass, keeps mid-band",
                     testHighPassRemovesSubBassKeepsMidband});
    tests.push_back({"VocalEnhancer expander attenuates quiet bleed",
                     testExpanderAttenuatesQuietBleed});
    tests.push_back({"VocalEnhancer keeps silence silent without NaN", testSilenceStaysSilentNoNaN});
    tests.push_back({"VocalEnhancer sanitises non-finite input", testNonFiniteInputSanitised});
}

} // namespace silverdaw::tests
