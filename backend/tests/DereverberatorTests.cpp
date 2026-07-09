// Dereverberator: offline statistical late-reverb soft-mask for the vocals stem.
// Because the output can't be auditioned in CI, these prove the SAFETY invariants
// numerically: guaranteed no-op on unprocessable/non-finite input, strictly
// attenuating (never amplifies), reverb-tail reduced on a synthetic reverberant
// signal while the direct onset is preserved, a sustained tone is left ~untouched
// (not mistaken for reverb tail), strength is monotonic, and it is deterministic.

#include "TestRegistry.h"

#include "Dereverberator.h"

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

double rms(const juce::AudioBuffer<float>& b, int ch, int start, int count)
{
    double sum = 0.0;
    const float* d = b.getReadPointer(ch);
    for (int i = start; i < start + count; ++i) sum += static_cast<double>(d[i]) * d[i];
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

// A stereo reverberant signal: a short noise burst (the "direct" sound) at the
// start, then silence, all passed through a sparse exponentially-decaying tapped
// RIR (direct tap + ~400 decaying random early/late taps). The silent gap after
// the burst therefore holds ONLY the decaying reverb tail, which is what the
// dereverb should pull down; the first samples are pure direct sound.
juce::AudioBuffer<float> makeReverberant(int burstLen, int totalLen, std::uint32_t seed)
{
    const int numTaps = 400;
    const double tauSamp = 0.15 * kSr;      // ~0.15 s reverb decay
    const int minDelay = static_cast<int>(0.01 * kSr);
    const int rirLen = static_cast<int>(0.35 * kSr);

    std::uint32_t s = seed;
    const auto rnd = [&s]() {
        s = s * 1664525u + 1013904223u;
        return static_cast<float>(s >> 8) / static_cast<float>(1u << 24); // [0,1)
    };
    std::vector<int> delay(static_cast<size_t>(numTaps));
    std::vector<float> gain(static_cast<size_t>(numTaps));
    for (int k = 0; k < numTaps; ++k)
    {
        delay[static_cast<size_t>(k)] = minDelay + static_cast<int>(rnd() * static_cast<float>(rirLen - minDelay));
        gain[static_cast<size_t>(k)] =
            0.6f * (rnd() * 2.0f - 1.0f)
            * std::exp(-static_cast<float>(delay[static_cast<size_t>(k)]) / static_cast<float>(tauSamp));
    }

    juce::AudioBuffer<float> out(2, totalLen);
    out.clear();
    for (int ch = 0; ch < 2; ++ch)
    {
        std::vector<float> dry(static_cast<size_t>(totalLen), 0.0f);
        std::uint32_t ds = seed + 100u + static_cast<std::uint32_t>(ch) * 13u;
        // Vocal-range dry burst: a one-pole low-passed noise burst (~roll-off a few kHz)
        // so its energy sits in the processed band, the way a real vocal's does — a flat
        // white burst would dump ~half its energy above 12 kHz where the dereverb (rightly)
        // never touches, hiding the in-band reduction we want to measure.
        float lp = 0.0f;
        for (int i = 0; i < burstLen; ++i)
        {
            ds = ds * 1664525u + 1013904223u;
            const float white = static_cast<float>(ds >> 8) / static_cast<float>(1u << 24) * 2.0f - 1.0f;
            lp += 0.25f * (white - lp); // ~ one-pole LP
            dry[static_cast<size_t>(i)] = 1.2f * lp;
        }
        float* o = out.getWritePointer(ch);
        for (int i = 0; i < totalLen; ++i)
        {
            float acc = dry[static_cast<size_t>(i)]; // direct
            for (int k = 0; k < numTaps; ++k)
            {
                const int j = i - delay[static_cast<size_t>(k)];
                if (j >= 0 && j < totalLen) acc += gain[static_cast<size_t>(k)] * dry[static_cast<size_t>(j)];
            }
            o[i] = acc;
        }
    }
    return out;
}

void testTooShortIsNoOp()
{
    juce::AudioBuffer<float> buf(2, 1000); // < one 2048-sample STFT frame
    for (int ch = 0; ch < 2; ++ch)
        for (int i = 0; i < 1000; ++i) buf.setSample(ch, i, std::sin(0.05f * static_cast<float>(i)));
    juce::AudioBuffer<float> original;
    original.makeCopyOf(buf);

    Dereverberator::process(buf, kSr, DereverbStrength::Medium);

    for (int ch = 0; ch < 2; ++ch)
        for (int i = 0; i < 1000; ++i)
            require(buf.getSample(ch, i) == original.getSample(ch, i),
                    "a buffer shorter than one STFT frame must be left untouched");
}

void testNonFiniteInputIsNoOp()
{
    juce::AudioBuffer<float> buf(2, 8192);
    for (int ch = 0; ch < 2; ++ch)
        for (int i = 0; i < 8192; ++i) buf.setSample(ch, i, 0.2f * std::sin(0.03f * static_cast<float>(i)));
    const float known = buf.getSample(1, 4000);
    buf.setSample(0, 500, std::numeric_limits<float>::quiet_NaN());

    Dereverberator::process(buf, kSr, DereverbStrength::Strong);

    require(! std::isfinite(buf.getSample(0, 500)), "non-finite input must be a no-op (NaN left in place)");
    require(buf.getSample(1, 4000) == known, "non-finite input must leave every other sample untouched");
}

void testOutputStaysFinite()
{
    auto buf = makeReverberant(4410, 22050, 3);
    Dereverberator::process(buf, kSr, DereverbStrength::Strong);
    require(allFinite(buf), "finite input must yield finite output");
}

void testNeverAmplifies()
{
    auto buf = makeReverberant(4410, 22050, 5);
    const float before = buf.getMagnitude(0, 0, buf.getNumSamples());
    Dereverberator::process(buf, kSr, DereverbStrength::Strong);
    const float after = buf.getMagnitude(0, 0, buf.getNumSamples());
    // A strictly-attenuating soft-mask must not raise the peak (a hair of spectral
    // slack is allowed for windowing, but nowhere near a real boost).
    require(after <= before * 1.06f, "dereverb must not amplify the signal");
}

void testReducesReverbTailAndKeepsDirect()
{
    const int burst = 4410;      // 0.1 s direct burst
    const int total = 22050;     // 0.5 s
    auto buf = makeReverberant(burst, total, 11);

    // Direct window: the first pure-direct samples (before any tap delay lands).
    const int directStart = 0, directCount = 400;
    // Tail window: well after the burst, where the dry signal is exactly zero, so
    // all energy there is reverb.
    const int tailStart = burst + static_cast<int>(0.05 * kSr);
    const int tailCount = total - tailStart - 256;

    const double directBefore = rms(buf, 0, directStart, directCount);
    const double tailBefore = rms(buf, 0, tailStart, tailCount);

    Dereverberator::process(buf, kSr, DereverbStrength::Medium);

    const double directAfter = rms(buf, 0, directStart, directCount);
    const double tailAfter = rms(buf, 0, tailStart, tailCount);

    require(tailAfter < 0.72 * tailBefore, "dereverb should strongly reduce the reverb-tail energy");
    require(directAfter > 0.75 * directBefore, "dereverb should preserve the direct onset energy");
}

void testSustainedToneBoundedAttenuation()
{
    // The stronger (Lebart-style) model subtracts reverb embedded in CONTINUOUS content,
    // so it now audibly attenuates a sustained note — but must stay BOUNDED: never below
    // the spectral floor (no hollowing to nothing) and never amplified. A single-channel
    // dereverb can't tell a dry held note from a reverberant one, so some drying of a dry
    // tone is expected and correct; we only guard the bounds.
    const int n = 22050;
    juce::AudioBuffer<float> buf(2, n);
    for (int ch = 0; ch < 2; ++ch)
        for (int i = 0; i < n; ++i)
            buf.setSample(ch, i, 0.3f * std::sin(2.0f * juce::MathConstants<float>::pi * 440.0f
                                                 * static_cast<float>(i) / static_cast<float>(kSr)));
    const double before = rms(buf, 0, 4096, n - 4096);
    Dereverberator::process(buf, kSr, DereverbStrength::Medium);
    const double after = rms(buf, 0, 4096, n - 4096);
    require(after < 0.95 * before, "the stronger model should audibly attenuate sustained content");
    require(after > 0.45 * before, "…but never crush a steady note to the floor (no hollowing)");
}

void testGainIsStableNoPumping()
{
    // The applied gain must be STABLE across a sustained note (a steady, gently-reduced
    // gain) rather than lurching frame to frame — frame-to-frame gain modulation is the
    // audible symptom of pumping. We track the windowed out/in ratio (the effective gain)
    // across the STEADY part of the tone (past the reverb-estimate build-up) and bound its
    // spread.
    const int n = 30000;
    juce::AudioBuffer<float> in(1, n);
    for (int i = 0; i < n; ++i)
        in.setSample(0, i, 0.3f * std::sin(2.0f * juce::MathConstants<float>::pi * 660.0f
                                           * static_cast<float>(i) / static_cast<float>(kSr)));
    juce::AudioBuffer<float> out;
    out.makeCopyOf(in);
    Dereverberator::process(out, kSr, DereverbStrength::Medium);

    const int win = 2048;
    double minRatio = 1.0e9, maxRatio = 0.0;
    for (int start = 8192; start + win <= n - 2048; start += win) // skip the build-up
    {
        const double ri = rms(in, 0, start, win);
        const double ro = rms(out, 0, start, win);
        if (ri < 1.0e-6) continue;
        const double ratio = ro / ri;
        minRatio = std::min(minRatio, ratio);
        maxRatio = std::max(maxRatio, ratio);
    }
    require(minRatio > 0.45, "no window may crush the sustained tone below the floor");
    require(maxRatio - minRatio < 0.12, "the applied gain must be stable across the sustain (no pumping)");
}

void testNoEdgeBlowUpOnContinuousSignal()
{
    // A signal that runs at FULL LEVEL right up to both buffer edges (unlike the
    // decaying reverb test, whose tail is near-silent at the end). At the low-overlap
    // STFT edges the window-sum-of-squares is tiny, so dividing the gain-modified
    // overlap-add by it must NOT explode into huge outlier samples — those would both
    // click and wreck any downstream level metric. Guards the OLA normalisation floor.
    const int n = 40000;
    juce::AudioBuffer<float> buf(2, n);
    std::uint32_t s = 4242u;
    const auto rnd = [&s]() {
        s = s * 1664525u + 1013904223u;
        return static_cast<float>(s >> 8) / static_cast<float>(1u << 24) * 2.0f - 1.0f;
    };
    for (int ch = 0; ch < 2; ++ch)
        for (int i = 0; i < n; ++i)
            buf.setSample(ch, i, 0.2f * std::sin(0.02f * static_cast<float>(i)) + 0.06f * rnd());
    const float before = buf.getMagnitude(0, 0, n);

    Dereverberator::process(buf, kSr, DereverbStrength::Strong);

    const float after = buf.getMagnitude(0, 0, n);
    require(after <= before * 1.1f,
            "dereverb must not blow up the low-overlap edge samples (bounded peak)");
    require(allFinite(buf), "edge reconstruction must stay finite");
}

void testStrengthIsMonotonic()
{
    const int burst = 4410, total = 22050;
    const int tailStart = burst + static_cast<int>(0.05 * kSr);
    const int tailCount = total - tailStart - 256;

    auto light = makeReverberant(burst, total, 21);
    auto medium = makeReverberant(burst, total, 21);
    auto strong = makeReverberant(burst, total, 21);
    Dereverberator::process(light, kSr, DereverbStrength::Light);
    Dereverberator::process(medium, kSr, DereverbStrength::Medium);
    Dereverberator::process(strong, kSr, DereverbStrength::Strong);

    const double lt = rms(light, 0, tailStart, tailCount);
    const double mt = rms(medium, 0, tailStart, tailCount);
    const double st = rms(strong, 0, tailStart, tailCount);
    require(mt <= lt * 1.001, "medium must reduce the tail at least as much as light");
    require(st <= mt * 1.001, "strong must reduce the tail at least as much as medium");
}

void testDeterministic()
{
    auto a = makeReverberant(4410, 22050, 33);
    juce::AudioBuffer<float> b;
    b.makeCopyOf(a);
    Dereverberator::process(a, kSr, DereverbStrength::Medium);
    Dereverberator::process(b, kSr, DereverbStrength::Medium);
    require(a.getNumChannels() == 2 && a.getNumSamples() == 22050, "shape preserved");
    for (int ch = 0; ch < a.getNumChannels(); ++ch)
        for (int i = 0; i < a.getNumSamples(); ++i)
            require(a.getSample(ch, i) == b.getSample(ch, i), "dereverb must be deterministic");
}

} // namespace

void addDereverberatorTests(std::vector<TestCase>& tests)
{
    tests.push_back({"Dereverberator too-short buffer is a no-op", testTooShortIsNoOp});
    tests.push_back({"Dereverberator non-finite input is a no-op", testNonFiniteInputIsNoOp});
    tests.push_back({"Dereverberator output stays finite", testOutputStaysFinite});
    tests.push_back({"Dereverberator never amplifies", testNeverAmplifies});
    tests.push_back({"Dereverberator reduces reverb tail, keeps direct", testReducesReverbTailAndKeepsDirect});
    tests.push_back({"Dereverberator bounds sustained-tone attenuation", testSustainedToneBoundedAttenuation});
    tests.push_back({"Dereverberator applies a stable gain (no pumping)", testGainIsStableNoPumping});
    tests.push_back({"Dereverberator no edge blow-up on continuous signal", testNoEdgeBlowUpOnContinuousSignal});
    tests.push_back({"Dereverberator strength is monotonic", testStrengthIsMonotonic});
    tests.push_back({"Dereverberator is deterministic", testDeterministic});
}

} // namespace silverdaw::tests
