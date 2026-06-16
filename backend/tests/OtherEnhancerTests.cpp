// OtherEnhancer: offline residual ("other") stem cleanup (subsonic high-pass +
// shallow STFT spectral attenuation with tonal protection and a mask-based
// self-bypass). Verifies disabled passthrough, strength round-trip, subsonic
// removal, preservation of strong tonal content, attenuation of a broadband
// noise floor, and silence / NaN safety.

#include "TestRegistry.h"

#include "OtherEnhancer.h"

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

// Deterministic low-level white noise standing in for the residual's musical-
// noise/bleed floor (no strong tonal content for the gate to protect).
juce::AudioBuffer<float> makeNoise(double amp, int numFrames, uint32_t seed, int numCh = 2)
{
    juce::AudioBuffer<float> b(numCh, numFrames);
    uint32_t s = seed;
    auto next = [&s]() {
        s = s * 1664525u + 1013904223u;
        return static_cast<double>(s) / 4294967295.0 * 2.0 - 1.0;
    };
    for (int ch = 0; ch < numCh; ++ch)
    {
        float* d = b.getWritePointer(ch);
        for (int i = 0; i < numFrames; ++i)
            d[i] = static_cast<float>(amp * next());
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

// RMS of the mid (mono sum) over a region. The stereo widener preserves the mid
// exactly, so this isolates what the spectral cleanup actually changed.
double rmsMid(const juce::AudioBuffer<float>& b, int start, int count)
{
    double sum = 0.0;
    const float* l = b.getReadPointer(0);
    const float* r = b.getReadPointer(b.getNumChannels() > 1 ? 1 : 0);
    for (int i = start; i < start + count; ++i)
    {
        const double mid = 0.5 * (static_cast<double>(l[i]) + r[i]);
        sum += mid * mid;
    }
    return std::sqrt(sum / juce::jmax(1, count));
}

// RMS of the side (L-R) over a region: how wide the stereo image is.
double rmsSide(const juce::AudioBuffer<float>& b, int start, int count)
{
    double sum = 0.0;
    const float* l = b.getReadPointer(0);
    const float* r = b.getReadPointer(b.getNumChannels() > 1 ? 1 : 0);
    for (int i = start; i < start + count; ++i)
    {
        const double side = 0.5 * (static_cast<double>(l[i]) - r[i]);
        sum += side * side;
    }
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
    auto buf = makeNoise(0.05, 88200, 12345);
    juce::AudioBuffer<float> original;
    original.makeCopyOf(buf);

    OtherEnhancer::process(buf, kSr, {/*enabled*/ false, OtherEnhanceStrength::Medium});

    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
        for (int i = 0; i < buf.getNumSamples(); ++i)
            require(buf.getSample(ch, i) == original.getSample(ch, i),
                    "disabled enhancer must leave the buffer untouched");
}

void testStrengthStringRoundTrip()
{
    require(otherEnhanceStrengthFromString("light") == OtherEnhanceStrength::Light,
            "'light' parses to Light");
    require(otherEnhanceStrengthFromString("STRONG") == OtherEnhanceStrength::Strong,
            "'STRONG' parses case-insensitively to Strong");
    require(otherEnhanceStrengthFromString("") == OtherEnhanceStrength::Medium,
            "empty token falls back to Medium");
    require(otherEnhanceStrengthFromString("nonsense") == OtherEnhanceStrength::Medium,
            "unknown token falls back to Medium");
    require(juce::String(otherEnhanceStrengthToString(OtherEnhanceStrength::Strong)) == "strong",
            "Strong stringifies to 'strong'");
}

void testHighPassRemovesSubsonic()
{
    const int n = 88200;
    auto sub = makeSine(12.0, 0.25, n);
    const double before = rms(sub, 0, 0, n);
    OtherEnhancer::process(sub, kSr, {true, OtherEnhanceStrength::Strong});
    const double after = rms(sub, 0, n / 4, n / 2);
    require(dbfs(after) < dbfs(before) - 6.0,
            "subsonic high-pass should attenuate a 12 Hz tone by >6 dB");
    require(allFinite(sub), "output must stay finite");
}

void testPreservesStrongTonalContent()
{
    // A loud, sustained 1 kHz tone is genuine content: the floor cap and the
    // mask-based self-bypass must leave it essentially untouched even on Strong.
    const int n = 88200;
    auto buf = makeSine(1000.0, 0.3, n);
    const double before = rms(buf, 0, n / 4, n / 2);
    OtherEnhancer::process(buf, kSr, {true, OtherEnhanceStrength::Strong});
    const double after = rms(buf, 0, n / 4, n / 2);
    require(std::abs(dbfs(after) - dbfs(before)) < 1.0,
            "strong tonal content must be preserved within ~1 dB");
}

void testAttenuatesBroadbandNoiseFloor()
{
    // A low-level broadband noise bed (no protected tonal content) should be
    // pulled down by the spectral gate, but never silenced. Measured on the mid
    // (mono sum) because the enhancement stage's widener intentionally boosts the
    // side — the spectral cleanup is what must reduce the mid.
    const int n = 88200;
    auto buf = makeNoise(0.02, n, 777);
    const double before = rmsMid(buf, n / 4, n / 2);
    OtherEnhancer::process(buf, kSr, {true, OtherEnhanceStrength::Strong});
    const double after = rmsMid(buf, n / 4, n / 2);
    require(allFinite(buf), "output must stay finite");
    require(dbfs(after) < dbfs(before) - 0.5,
            "broadband residual noise should be attenuated by >0.5 dB");
    require(after > 0.0, "the noise floor must be reduced, not gated to silence");
}

void testWidensDecorrelatedStereoImage()
{
    // Two distinct, loud per-channel tones carry real side energy and are
    // preserved by the spectral cleanup (tonal protection / self-bypass), so the
    // widener's effect is isolated: it should increase the side energy while
    // preserving the mid.
    const int n = 88200;
    juce::AudioBuffer<float> buf(2, n);
    for (int i = 0; i < n; ++i)
    {
        buf.getWritePointer(0)[i] = static_cast<float>(0.3 * std::sin(kTwoPi * 500.0 * i / kSr));
        buf.getWritePointer(1)[i] = static_cast<float>(0.3 * std::sin(kTwoPi * 700.0 * i / kSr));
    }
    const double sideBefore = rmsSide(buf, n / 4, n / 2);
    const double midBefore = rmsMid(buf, n / 4, n / 2);
    OtherEnhancer::process(buf, kSr, {true, OtherEnhanceStrength::Strong});
    const double sideAfter = rmsSide(buf, n / 4, n / 2);
    const double midAfter = rmsMid(buf, n / 4, n / 2);
    require(allFinite(buf), "output must stay finite");
    require(sideAfter > sideBefore,
            "the widener should increase the side (stereo) energy");
    // The mid is preserved by the widener; the gentle cleanup leaves loud tones
    // essentially untouched, so it must stay close to where it started.
    require(std::abs(dbfs(midAfter) - dbfs(midBefore)) < 1.0,
            "the widener must preserve the mid (mono sum)");
}

void testMonoSignalIsNotWidened()
{
    // Identical channels carry no side energy, so the widener must be a no-op:
    // the output stays mono (side stays at zero) regardless of strength.
    const int n = 44100;
    auto buf = makeSine(440.0, 0.2, n); // makeSine writes identical channels
    OtherEnhancer::process(buf, kSr, {true, OtherEnhanceStrength::Strong});
    require(rmsSide(buf, n / 4, n / 2) < 1.0e-4,
            "a mono (identical-channel) signal must not gain side energy");
    require(allFinite(buf), "output must stay finite");
}

void testSilenceStaysSilentNoNaN()
{
    juce::AudioBuffer<float> buf(2, 8192);
    buf.clear();
    OtherEnhancer::process(buf, kSr, {true, OtherEnhanceStrength::Strong});
    require(allFinite(buf), "silent input must stay finite");
    require(buf.getMagnitude(0, 0, buf.getNumSamples()) == 0.0F,
            "silent input must stay silent");
}

void testNonFiniteInputSanitised()
{
    auto buf = makeNoise(0.02, 88200, 999);
    buf.setSample(0, 100, std::numeric_limits<float>::quiet_NaN());
    buf.setSample(1, 200, std::numeric_limits<float>::infinity());
    OtherEnhancer::process(buf, kSr, {true, OtherEnhanceStrength::Medium});
    require(allFinite(buf), "NaN/Inf samples must be sanitised to finite output");
}

} // namespace

void addOtherEnhancerTests(std::vector<TestCase>& tests)
{
    tests.push_back({"OtherEnhancer disabled is a bit-identical passthrough",
                     testDisabledIsBitIdenticalPassthrough});
    tests.push_back({"OtherEnhancer strength string round-trips", testStrengthStringRoundTrip});
    tests.push_back({"OtherEnhancer high-pass removes subsonic", testHighPassRemovesSubsonic});
    tests.push_back({"OtherEnhancer preserves strong tonal content",
                     testPreservesStrongTonalContent});
    tests.push_back({"OtherEnhancer attenuates a broadband noise floor",
                     testAttenuatesBroadbandNoiseFloor});
    tests.push_back({"OtherEnhancer widens a decorrelated stereo image",
                     testWidensDecorrelatedStereoImage});
    tests.push_back({"OtherEnhancer does not widen a mono signal",
                     testMonoSignalIsNotWidened});
    tests.push_back({"OtherEnhancer keeps silence silent without NaN", testSilenceStaysSilentNoNaN});
    tests.push_back({"OtherEnhancer sanitises non-finite input", testNonFiniteInputSanitised});
}

} // namespace silverdaw::tests
