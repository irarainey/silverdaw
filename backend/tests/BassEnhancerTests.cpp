// BassEnhancer: offline bass-stem cleanup (subsonic high-pass + low-passed-
// detector downward expander with adaptive bypass). Verifies disabled
// passthrough, strength round-trip, subsonic removal vs bass-fundamental
// preservation, attenuation of high-frequency inter-note bleed with note
// preservation, the low-contrast self-bypass, and silence / NaN safety.

#include "TestRegistry.h"

#include "BassEnhancer.h"

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

// A bass test signal: repeating loud low-frequency notes separated by long quiet
// gaps that hold a low-level high-frequency bleed tone (the kind of cymbal/vocal
// leakage a bass stem should suppress). The note frequency drives the detector
// (it sits below the ~600 Hz detector low-pass) while the bleed is rejected by
// that low-pass, so the gaps read quiet and the expander closes over them. The
// gaps are deliberately long: bass uses a slow (~400 ms) release, so the
// expander only fully settles several hundred ms into a gap.
juce::AudioBuffer<float> makeNotesWithBleed(double noteAmp, double noteFreq,
                                            double bleedAmp, double bleedFreq)
{
    const int total = static_cast<int>(24.0 * kSr); // 24 s
    const int period = static_cast<int>(8.0 * kSr);  // a note every 8 s
    const int noteLen = static_cast<int>(1.0 * kSr); // 1 s note, then a 7 s gap
    juce::AudioBuffer<float> b(2, total);
    for (int ch = 0; ch < 2; ++ch)
    {
        float* d = b.getWritePointer(ch);
        for (int i = 0; i < total; ++i)
        {
            const bool inNote = (i % period) < noteLen;
            d[i] = static_cast<float>(
                (inNote ? noteAmp * std::sin(kTwoPi * noteFreq * i / kSr) : 0.0)
                + bleedAmp * std::sin(kTwoPi * bleedFreq * i / kSr));
        }
    }
    return b;
}

void testDisabledIsBitIdenticalPassthrough()
{
    auto buf = makeSine(80.0, 0.25, 8192);
    juce::AudioBuffer<float> original;
    original.makeCopyOf(buf);

    BassEnhancer::process(buf, kSr, {/*enabled*/ false, BassEnhanceStrength::Medium});

    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
        for (int i = 0; i < buf.getNumSamples(); ++i)
            require(buf.getSample(ch, i) == original.getSample(ch, i),
                    "disabled enhancer must leave the buffer untouched");
}

void testStrengthStringRoundTrip()
{
    require(bassEnhanceStrengthFromString("light") == BassEnhanceStrength::Light,
            "'light' parses to Light");
    require(bassEnhanceStrengthFromString("STRONG") == BassEnhanceStrength::Strong,
            "'STRONG' parses case-insensitively to Strong");
    require(bassEnhanceStrengthFromString("") == BassEnhanceStrength::Medium,
            "empty token falls back to Medium");
    require(bassEnhanceStrengthFromString("nonsense") == BassEnhanceStrength::Medium,
            "unknown token falls back to Medium");
    require(juce::String(bassEnhanceStrengthToString(BassEnhanceStrength::Strong)) == "strong",
            "Strong stringifies to 'strong'");
}

void testHighPassRemovesSubsonicKeepsFundamental()
{
    // Continuous tones so the low-contrast guard bypasses the expander, isolating
    // the subsonic high-pass.
    const int n = static_cast<int>(2.0 * kSr);
    auto sub = makeSine(12.0, 0.25, n);
    const double subBefore = rms(sub, 0, 0, n);
    BassEnhancer::process(sub, kSr, {true, BassEnhanceStrength::Strong});
    const double subAfter = rms(sub, 0, n / 4, n / 2);
    require(dbfs(subAfter) < dbfs(subBefore) - 6.0,
            "subsonic high-pass should attenuate a 12 Hz tone by >6 dB");

    auto note = makeSine(50.0, 0.25, n);
    const double noteBefore = rms(note, 0, 0, n);
    BassEnhancer::process(note, kSr, {true, BassEnhanceStrength::Strong});
    const double noteAfter = rms(note, 0, n / 4, n / 2);
    require(std::abs(dbfs(noteAfter) - dbfs(noteBefore)) < 1.0,
            "50 Hz bass fundamental must be preserved within ~1 dB");
}

void testExpanderAttenuatesBleedKeepsNotes()
{
    // Notes ~-4 dBFS at 80 Hz, HF bleed ~-46 dBFS at 4 kHz (above the detector LP).
    auto buf = makeNotesWithBleed(0.6, 80.0, 0.005, 4000.0);
    const int win = static_cast<int>(0.4 * kSr);
    const int noteStart = static_cast<int>(0.3 * kSr);   // inside the first note
    const int gapStart = static_cast<int>(7.0 * kSr);    // deep in a settled 7 s gap
    const double noteBefore = rms(buf, 0, noteStart, win);
    const double bleedBefore = rms(buf, 0, gapStart, win);

    BassEnhancer::process(buf, kSr, {true, BassEnhanceStrength::Medium});

    const double noteAfter = rms(buf, 0, noteStart, win);
    const double bleedAfter = rms(buf, 0, gapStart, win);

    require(std::abs(dbfs(noteAfter) - dbfs(noteBefore)) < 1.5,
            "bass notes must be preserved by the expander");
    require(dbfs(bleedAfter) < dbfs(bleedBefore) - 4.0,
            "low-level inter-note HF bleed should be attenuated by >4 dB");
}

void testLowContrastSelfBypass()
{
    // A near-continuous sustained bass tone has no gaps: the expander must self-
    // bypass and leave the level essentially untouched (only the subsonic high-
    // pass, inaudible at 80 Hz, applies).
    const int n = static_cast<int>(3.0 * kSr);
    auto buf = makeSine(80.0, 0.2, n);
    const double before = rms(buf, 0, 0, n);
    BassEnhancer::process(buf, kSr, {true, BassEnhanceStrength::Strong});
    const double after = rms(buf, 0, n / 4, n / 2);
    require(std::abs(dbfs(after) - dbfs(before)) < 1.0,
            "sustained/continuous bass must not be gated (self-bypass)");
}

void testSilenceStaysSilentNoNaN()
{
    juce::AudioBuffer<float> buf(2, 4096);
    buf.clear();
    BassEnhancer::process(buf, kSr, {true, BassEnhanceStrength::Strong});
    require(allFinite(buf), "silent input must stay finite");
    require(buf.getMagnitude(0, 0, buf.getNumSamples()) == 0.0F,
            "silent input must stay silent");
}

void testNonFiniteInputSanitised()
{
    auto buf = makeNotesWithBleed(0.6, 80.0, 0.005, 4000.0);
    buf.setSample(0, 100, std::numeric_limits<float>::quiet_NaN());
    buf.setSample(1, 200, std::numeric_limits<float>::infinity());
    BassEnhancer::process(buf, kSr, {true, BassEnhanceStrength::Medium});
    require(allFinite(buf), "NaN/Inf samples must be sanitised to finite output");
}

} // namespace

void addBassEnhancerTests(std::vector<TestCase>& tests)
{
    tests.push_back({"BassEnhancer disabled is a bit-identical passthrough",
                     testDisabledIsBitIdenticalPassthrough});
    tests.push_back({"BassEnhancer strength string round-trips", testStrengthStringRoundTrip});
    tests.push_back({"BassEnhancer high-pass removes subsonic, keeps fundamental",
                     testHighPassRemovesSubsonicKeepsFundamental});
    tests.push_back({"BassEnhancer expander attenuates bleed, keeps notes",
                     testExpanderAttenuatesBleedKeepsNotes});
    tests.push_back({"BassEnhancer self-bypasses low-contrast material",
                     testLowContrastSelfBypass});
    tests.push_back({"BassEnhancer keeps silence silent without NaN", testSilenceStaysSilentNoNaN});
    tests.push_back({"BassEnhancer sanitises non-finite input", testNonFiniteInputSanitised});
}

} // namespace silverdaw::tests
