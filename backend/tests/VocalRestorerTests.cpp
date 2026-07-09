// VocalRestorer: offline presence/level restoration applied to a de-reverbed vocal
// stem. It can't be auditioned in CI, so these prove the SAFETY + intent invariants
// numerically: a guaranteed no-op on empty/non-finite input, all-or-nothing so a bad
// filter result never corrupts the stem, brightness is genuinely lifted (more HF
// energy out than in), the active-loudness match restores a level that de-reverb
// dropped (while its loudness metric ignores silent gaps), the output never clips the
// peak ceiling, strength is monotonic, and it is deterministic.

#include "TestRegistry.h"

#include "VocalRestorer.h"

#include <cmath>
#include <limits>
#include <vector>

#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw::tests
{
namespace
{

constexpr double kSr = 44100.0;

double bandEnergy(const juce::AudioBuffer<float>& b, int ch)
{
    double sum = 0.0;
    const float* d = b.getReadPointer(ch);
    for (int i = 0; i < b.getNumSamples(); ++i) sum += static_cast<double>(d[i]) * d[i];
    return sum;
}

float peakMag(const juce::AudioBuffer<float>& b)
{
    float pk = 0.0f;
    for (int ch = 0; ch < b.getNumChannels(); ++ch)
        pk = std::max(pk, b.getMagnitude(ch, 0, b.getNumSamples()));
    return pk;
}

// A stereo tone at `hz`, amplitude `amp`.
juce::AudioBuffer<float> makeTone(double hz, float amp, int n)
{
    juce::AudioBuffer<float> b(2, n);
    for (int ch = 0; ch < 2; ++ch)
        for (int i = 0; i < n; ++i)
            b.setSample(ch, i, amp * std::sin(2.0f * juce::MathConstants<float>::pi
                                              * static_cast<float>(hz) * static_cast<float>(i)
                                              / static_cast<float>(kSr)));
    return b;
}

void testEmptyIsNoOp()
{
    juce::AudioBuffer<float> buf(2, 0);
    VocalRestorer::process(buf, kSr, DereverbStrength::Medium, 0.0f); // must not crash
    require(buf.getNumSamples() == 0, "an empty buffer stays empty");
}

void testNonFiniteInputIsNoOp()
{
    auto buf = makeTone(1000.0, 0.2f, 8192);
    const float known = buf.getSample(1, 4000);
    buf.setSample(0, 500, std::numeric_limits<float>::quiet_NaN());

    VocalRestorer::process(buf, kSr, DereverbStrength::Strong, 0.2f);

    require(! std::isfinite(buf.getSample(0, 500)), "non-finite input must be a no-op");
    require(buf.getSample(1, 4000) == known, "non-finite input must leave every other sample untouched");
}

void testOutputStaysFinite()
{
    auto buf = makeTone(4000.0, 0.3f, 16384);
    VocalRestorer::process(buf, kSr, DereverbStrength::Strong, 0.0f);
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
        for (int i = 0; i < buf.getNumSamples(); ++i)
            require(std::isfinite(buf.getSample(ch, i)), "finite input must yield finite output");
}

void testLiftsHighFrequencyPresence()
{
    // A presence-band tone (5 kHz) must come out louder (the high-shelf boost); a low
    // tone (200 Hz, below the shelf corner) must be essentially untouched — proving the
    // lift is a shelf, not a broadband gain. referenceLevel = 0 disables the level match
    // so only the tonal shelves act.
    auto hi = makeTone(5000.0, 0.2f, 16384);
    auto lo = makeTone(200.0, 0.2f, 16384);
    const double hiBefore = bandEnergy(hi, 0);
    const double loBefore = bandEnergy(lo, 0);

    VocalRestorer::process(hi, kSr, DereverbStrength::Strong, 0.0f);
    VocalRestorer::process(lo, kSr, DereverbStrength::Strong, 0.0f);

    const double hiAfter = bandEnergy(hi, 0);
    const double loAfter = bandEnergy(lo, 0);
    require(hiAfter / hiBefore > loAfter / loBefore * 1.15,
            "the presence high-shelf must lift high frequencies more than lows");
    require(hiAfter > hiBefore, "the presence band must be lifted");
    require(loAfter <= loBefore * 1.02, "a sub-shelf low tone must be ~untouched with no level match");
}

void testActiveLoudnessIgnoresSilence()
{
    const int n = 44100;
    // A tone that plays for the first half then goes silent.
    auto gappy = makeTone(300.0, 0.4f, n);
    for (int ch = 0; ch < 2; ++ch)
        for (int i = n / 2; i < n; ++i) gappy.setSample(ch, i, 0.0f);
    auto continuous = makeTone(300.0, 0.4f, n);

    const float gappyLoud = VocalRestorer::activeLoudness(gappy, kSr);
    const float contLoud = VocalRestorer::activeLoudness(continuous, kSr);

    // The gate must exclude the silent half, so the two report ~the same active
    // loudness even though the gappy signal's full-buffer RMS is √2 lower.
    require(std::abs(gappyLoud - contLoud) < contLoud * 0.1f,
            "active loudness must ignore silent gaps (match the continuous tone)");
    require(gappyLoud > contLoud * 0.7f, "the active loudness is the loud-frame RMS, not the full RMS");

    juce::AudioBuffer<float> silent(2, n);
    silent.clear();
    require(VocalRestorer::activeLoudness(silent, kSr) == 0.0f, "silence has zero active loudness");
}

void testLevelMatchRestoresDroppedLevel()
{
    // Simulate what de-reverb does — drop the level — then prove the restorer's active-
    // loudness match brings it back to the reference captured beforehand. A low (300 Hz)
    // tone keeps the shelves out of the way so this isolates the level match.
    auto buf = makeTone(300.0, 0.4f, 44100);
    const float reference = VocalRestorer::activeLoudness(buf, kSr);
    buf.applyGain(0.5f); // de-reverb-style energy loss (~ -6 dB)
    const float dropped = VocalRestorer::activeLoudness(buf, kSr);
    require(dropped < reference * 0.6f, "precondition: the level really dropped");

    VocalRestorer::process(buf, kSr, DereverbStrength::Medium, reference);

    const float restored = VocalRestorer::activeLoudness(buf, kSr);
    require(restored > reference * 0.88f, "the level match must restore the dropped loudness");
    require(restored < reference * 1.12f, "…without overshooting the reference");
    require(peakMag(buf) <= 1.0f, "the restored stem must not clip");
}

void testNeverClips()
{
    // A near-full-scale tone that the level match would double: reference set to twice
    // its own loudness. The soft-knee limiter must still keep the output under 0 dBFS.
    auto buf = makeTone(4000.0, 0.9f, 16384);
    const float ref = VocalRestorer::activeLoudness(buf, kSr) * 2.0f;
    VocalRestorer::process(buf, kSr, DereverbStrength::Strong, ref);
    require(peakMag(buf) <= 1.0f, "the restorer must never clip the stem past full scale");
}

void testStrengthIsMonotonic()
{
    // A stronger setting must lift the presence band at least as much as a weaker one
    // (level match off so this measures the tonal shelves only).
    auto light = makeTone(5000.0, 0.2f, 16384);
    auto medium = makeTone(5000.0, 0.2f, 16384);
    auto strong = makeTone(5000.0, 0.2f, 16384);
    VocalRestorer::process(light, kSr, DereverbStrength::Light, 0.0f);
    VocalRestorer::process(medium, kSr, DereverbStrength::Medium, 0.0f);
    VocalRestorer::process(strong, kSr, DereverbStrength::Strong, 0.0f);

    const double l = bandEnergy(light, 0);
    const double m = bandEnergy(medium, 0);
    const double s = bandEnergy(strong, 0);
    require(m >= l * 0.999, "medium must lift presence at least as much as light");
    require(s >= m * 0.999, "strong must lift presence at least as much as medium");
}

void testDeterministic()
{
    auto a = makeTone(3800.0, 0.25f, 16384);
    juce::AudioBuffer<float> b;
    b.makeCopyOf(a);
    VocalRestorer::process(a, kSr, DereverbStrength::Medium, 0.18f);
    VocalRestorer::process(b, kSr, DereverbStrength::Medium, 0.18f);
    for (int ch = 0; ch < a.getNumChannels(); ++ch)
        for (int i = 0; i < a.getNumSamples(); ++i)
            require(a.getSample(ch, i) == b.getSample(ch, i), "restoration must be deterministic");
}

} // namespace

void addVocalRestorerTests(std::vector<TestCase>& tests)
{
    tests.push_back({"VocalRestorer empty buffer is a no-op", testEmptyIsNoOp});
    tests.push_back({"VocalRestorer non-finite input is a no-op", testNonFiniteInputIsNoOp});
    tests.push_back({"VocalRestorer output stays finite", testOutputStaysFinite});
    tests.push_back({"VocalRestorer lifts high-frequency presence", testLiftsHighFrequencyPresence});
    tests.push_back({"VocalRestorer active loudness ignores silence", testActiveLoudnessIgnoresSilence});
    tests.push_back({"VocalRestorer level match restores dropped level", testLevelMatchRestoresDroppedLevel});
    tests.push_back({"VocalRestorer never clips", testNeverClips});
    tests.push_back({"VocalRestorer strength is monotonic", testStrengthIsMonotonic});
    tests.push_back({"VocalRestorer is deterministic", testDeterministic});
}

} // namespace silverdaw::tests
