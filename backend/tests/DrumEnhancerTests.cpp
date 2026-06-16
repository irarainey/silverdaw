// DrumEnhancer: offline drum-stem cleanup (subsonic high-pass + percentile-
// anchored downward expander with adaptive bypass). Verifies disabled
// passthrough, subsonic removal vs kick-band preservation, inter-hit bleed
// attenuation with transient preservation, the low-contrast self-bypass, and
// silence / NaN safety.

#include "TestRegistry.h"

#include "DrumEnhancer.h"

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

// A percussive test signal: repeating loud bursts (the "hits") separated by long
// quiet gaps holding a low-level bleed tone. Gives the expander clear gaps to act
// on while leaving the hits well above threshold.
juce::AudioBuffer<float> makeHitsWithBleed(double hitAmp, double bleedAmp, double freqHz)
{
    const int total = static_cast<int>(8.0 * kSr); // 8 s
    const int period = static_cast<int>(2.0 * kSr); // a hit every 2 s
    const int hitLen = static_cast<int>(0.6 * kSr); // 0.6 s hit (30% duty)
    juce::AudioBuffer<float> b(2, total);
    for (int ch = 0; ch < 2; ++ch)
    {
        float* d = b.getWritePointer(ch);
        for (int i = 0; i < total; ++i)
        {
            const bool inHit = (i % period) < hitLen;
            const double amp = inHit ? hitAmp : bleedAmp;
            d[i] = static_cast<float>(amp * std::sin(kTwoPi * freqHz * i / kSr));
        }
    }
    return b;
}

void testDisabledIsBitIdenticalPassthrough()
{
    auto buf = makeSine(120.0, 0.25, 8192);
    juce::AudioBuffer<float> original;
    original.makeCopyOf(buf);

    DrumEnhancer::process(buf, kSr, {/*enabled*/ false, DrumEnhanceStrength::Medium});

    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
        for (int i = 0; i < buf.getNumSamples(); ++i)
            require(buf.getSample(ch, i) == original.getSample(ch, i),
                    "disabled enhancer must leave the buffer untouched");
}

void testStrengthStringRoundTrip()
{
    require(drumEnhanceStrengthFromString("light") == DrumEnhanceStrength::Light,
            "'light' parses to Light");
    require(drumEnhanceStrengthFromString("STRONG") == DrumEnhanceStrength::Strong,
            "'STRONG' parses case-insensitively to Strong");
    require(drumEnhanceStrengthFromString("") == DrumEnhanceStrength::Medium,
            "empty token falls back to Medium");
    require(drumEnhanceStrengthFromString("nonsense") == DrumEnhanceStrength::Medium,
            "unknown token falls back to Medium");
    require(juce::String(drumEnhanceStrengthToString(DrumEnhanceStrength::Strong)) == "strong",
            "Strong stringifies to 'strong'");
}

void testHighPassRemovesSubsonicKeepsKickBand()
{
    // Continuous tones so the low-contrast guard bypasses the expander, isolating
    // the subsonic high-pass.
    const int n = static_cast<int>(2.0 * kSr);
    auto sub = makeSine(15.0, 0.25, n);
    const double subBefore = rms(sub, 0, 0, n);
    DrumEnhancer::process(sub, kSr, {true, DrumEnhanceStrength::Strong});
    const double subAfter = rms(sub, 0, n / 4, n / 2);
    require(dbfs(subAfter) < dbfs(subBefore) - 6.0,
            "subsonic high-pass should attenuate a 15 Hz tone by >6 dB");

    auto kick = makeSine(60.0, 0.25, n);
    const double kickBefore = rms(kick, 0, 0, n);
    DrumEnhancer::process(kick, kSr, {true, DrumEnhanceStrength::Strong});
    const double kickAfter = rms(kick, 0, n / 4, n / 2);
    require(std::abs(dbfs(kickAfter) - dbfs(kickBefore)) < 1.0,
            "60 Hz kick band must be preserved within ~1 dB");
}

void testExpanderAttenuatesBleedKeepsHits()
{
    auto buf = makeHitsWithBleed(0.6, 0.005, 200.0); // hits ~-4 dBFS, bleed ~-46 dBFS
    const int win = static_cast<int>(0.4 * kSr);
    const int hitStart = static_cast<int>(0.1 * kSr);              // inside the first hit
    const int gapStart = static_cast<int>(3.5 * kSr);             // deep in a settled gap
    const double hitBefore = rms(buf, 0, hitStart, win);
    const double bleedBefore = rms(buf, 0, gapStart, win);

    DrumEnhancer::process(buf, kSr, {true, DrumEnhanceStrength::Medium});

    const double hitAfter = rms(buf, 0, hitStart, win);
    const double bleedAfter = rms(buf, 0, gapStart, win);

    require(std::abs(dbfs(hitAfter) - dbfs(hitBefore)) < 1.0,
            "drum hits must be preserved by the expander");
    require(dbfs(bleedAfter) < dbfs(bleedBefore) - 4.0,
            "low-level inter-hit bleed should be attenuated by >4 dB");
}

void testTransientDesignerEmphasisesAttack()
{
    // A burst with a hard onset: amplitude jumps from a quiet bleed straight to a
    // loud, constant-amplitude tone (makeHitsWithBleed). The constant amplitude
    // means the only thing the transient designer can latch onto is the leading
    // edge, so attack emphasis shows up as the onset window gaining level relative
    // to the sustained body. Measured on the second hit (the buffer opens on the
    // first, where both envelopes start together).
    auto buf = makeHitsWithBleed(0.5, 0.005, 200.0);
    const int hitStart = static_cast<int>(2.0 * kSr);            // start of the 2nd hit
    const int onsetWin = static_cast<int>(0.008 * kSr);          // first 8 ms
    const int sustainStart = hitStart + static_cast<int>(0.2 * kSr);
    const int sustainWin = static_cast<int>(0.2 * kSr);

    const double onsetBefore = rms(buf, 0, hitStart, onsetWin);
    const double sustainBefore = rms(buf, 0, sustainStart, sustainWin);

    DrumEnhancer::process(buf, kSr, {true, DrumEnhanceStrength::Strong});

    const double onsetAfter = rms(buf, 0, hitStart, onsetWin);
    const double sustainAfter = rms(buf, 0, sustainStart, sustainWin);

    const double contrastBefore = dbfs(onsetBefore) - dbfs(sustainBefore);
    const double contrastAfter = dbfs(onsetAfter) - dbfs(sustainAfter);
    require(contrastAfter > contrastBefore + 1.0,
            "transient designer should emphasise the attack relative to the sustain");
    require(allFinite(buf), "output must stay finite");
}

void testLowContrastSelfBypass()
{
    // A near-continuous mid-level tone has no gaps: the expander must self-bypass
    // and leave the level essentially untouched (only the subsonic high-pass,
    // inaudible at 200 Hz, applies).
    const int n = static_cast<int>(3.0 * kSr);
    auto buf = makeSine(200.0, 0.2, n);
    const double before = rms(buf, 0, 0, n);
    DrumEnhancer::process(buf, kSr, {true, DrumEnhanceStrength::Strong});
    const double after = rms(buf, 0, n / 4, n / 2);
    require(std::abs(dbfs(after) - dbfs(before)) < 1.0,
            "dense/continuous material must not be gated (self-bypass)");
}

void testSilenceStaysSilentNoNaN()
{
    juce::AudioBuffer<float> buf(2, 4096);
    buf.clear();
    DrumEnhancer::process(buf, kSr, {true, DrumEnhanceStrength::Strong});
    require(allFinite(buf), "silent input must stay finite");
    require(buf.getMagnitude(0, 0, buf.getNumSamples()) == 0.0F,
            "silent input must stay silent");
}

void testNonFiniteInputSanitised()
{
    auto buf = makeHitsWithBleed(0.6, 0.005, 200.0);
    buf.setSample(0, 100, std::numeric_limits<float>::quiet_NaN());
    buf.setSample(1, 200, std::numeric_limits<float>::infinity());
    DrumEnhancer::process(buf, kSr, {true, DrumEnhanceStrength::Medium});
    require(allFinite(buf), "NaN/Inf samples must be sanitised to finite output");
}

} // namespace

void addDrumEnhancerTests(std::vector<TestCase>& tests)
{
    tests.push_back({"DrumEnhancer disabled is a bit-identical passthrough",
                     testDisabledIsBitIdenticalPassthrough});
    tests.push_back({"DrumEnhancer strength string round-trips", testStrengthStringRoundTrip});
    tests.push_back({"DrumEnhancer high-pass removes subsonic, keeps kick band",
                     testHighPassRemovesSubsonicKeepsKickBand});
    tests.push_back({"DrumEnhancer expander attenuates bleed, keeps hits",
                     testExpanderAttenuatesBleedKeepsHits});
    tests.push_back({"DrumEnhancer transient designer emphasises the attack",
                     testTransientDesignerEmphasisesAttack});
    tests.push_back({"DrumEnhancer self-bypasses low-contrast material",
                     testLowContrastSelfBypass});
    tests.push_back({"DrumEnhancer keeps silence silent without NaN", testSilenceStaysSilentNoNaN});
    tests.push_back({"DrumEnhancer sanitises non-finite input", testNonFiniteInputSanitised});
}

} // namespace silverdaw::tests
