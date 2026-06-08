// FX / DSP: ToneEq shelves + low-cut, Leveler passthrough/compression, the
// SharedFx delay/room/echo behaviours, and BusGraph equal-power pan gains.

#include "TestRegistry.h"

#include "AudioEngine.h"
#include "AudioConstants.h"
#include "BridgeAuth.h"
#include "EdgeFadeSnapshot.h"
#include "LoudnessAnalyzer.h"
#include "Leveler.h"
#include "MixdownEngine.h"
#include "PayloadHelpers.h"
#include "PeaksCache.h"
#include "ProjectFile.h"
#include "ProjectState.h"
#include "SharedFx.h"
#include "ToneEq.h"
#include "ValueTreeJson.h"
#include "WarpProcessor.h"

#include <atomic>
#include <array>
#include <chrono>
#include <cmath>
#include <exception>
#include <limits>
#include <string>
#include <thread>
#include <vector>

#include <juce_events/juce_events.h>

namespace silverdaw::tests
{
namespace
{

double toneRms(const juce::AudioBuffer<float>& buf, int startSample, int numSamples)
{
    double sum = 0.0;
    int count = 0;
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
    {
        const float* d = buf.getReadPointer(ch);
        for (int i = 0; i < numSamples; ++i)
        {
            const double v = d[startSample + i];
            sum += v * v;
            ++count;
        }
    }
    return count > 0 ? std::sqrt(sum / count) : 0.0;
}

double toneGainRatio(float bassDb, float midDb, float trebleDb, bool lowCut, bool highCut,
                     double freq)
{
    constexpr double sr = 44100.0;
    silverdaw::ToneEq eq;
    eq.prepare(sr, 2);
    eq.setParams(bassDb, midDb, trebleDb, lowCut, highCut, /*snap*/ true);

    constexpr int n = 16384;
    juce::AudioBuffer<float> buf(2, n);
    for (int ch = 0; ch < 2; ++ch)
    {
        float* d = buf.getWritePointer(ch);
        for (int i = 0; i < n; ++i)
        {
            d[i] = 0.25F * static_cast<float>(
                       std::sin(2.0 * juce::MathConstants<double>::pi * freq * i / sr));
        }
    }
    const double inRms = toneRms(buf, n / 2, n / 2); // input is stationary
    eq.process(buf, 0, n);
    const double outRms = toneRms(buf, n / 2, n / 2); // measure past warm-up
    return inRms > 0.0 ? outRms / inRms : 0.0;
}

void testToneEqLowCutDirectionAndShelfRange()
{
    // Low Cut is a 4th-order (24 dB/oct) high-pass @ 120 Hz: 1 kHz passes
    // ~unchanged while lows are strongly removed. The inverted (low-pass)
    // regression fails the direction guard; a too-gentle 2nd-order voicing
    // fails the 60 Hz slope guard below.
    const double passHigh = toneGainRatio(0.0F, 0.0F, 0.0F, true, false, 1000.0);
    const double cutLow = toneGainRatio(0.0F, 0.0F, 0.0F, true, false, 40.0);
    const double cut60 = toneGainRatio(0.0F, 0.0F, 0.0F, true, false, 60.0);
    require(passHigh > 0.9, "Low Cut must pass 1 kHz roughly unchanged");
    require(cutLow < 0.1, "Low Cut must strongly attenuate 40 Hz");
    // A 2nd-order 120 Hz high-pass leaves 60 Hz near -6 dB (~0.25); the
    // 4th-order slope pushes it well below, so this locks in 24 dB/oct.
    require(cut60 < 0.15, "Low Cut must have a 24 dB/oct slope (60 Hz well below 2nd-order)");
    require(passHigh > cutLow + 0.3, "Low Cut must pass highs more than lows (not inverted)");

    // High Cut is a 4th-order (24 dB/oct) low-pass @ 6 kHz: 1 kHz passes
    // ~unchanged while highs are strongly removed (mirror of Low Cut).
    const double passLow = toneGainRatio(0.0F, 0.0F, 0.0F, false, true, 1000.0);
    const double cutHigh = toneGainRatio(0.0F, 0.0F, 0.0F, false, true, 12000.0);
    const double cut9k = toneGainRatio(0.0F, 0.0F, 0.0F, false, true, 9000.0);
    require(passLow > 0.9, "High Cut must pass 1 kHz roughly unchanged");
    require(cutHigh < 0.1, "High Cut must strongly attenuate 12 kHz");
    // A 2nd-order 6 kHz low-pass leaves 9 kHz near -8 dB (~0.41); the
    // 4th-order slope pushes it well below, so this locks in 24 dB/oct.
    require(cut9k < 0.3, "High Cut must have a 24 dB/oct slope (9 kHz well below 2nd-order)");
    require(passLow > cutHigh + 0.3, "High Cut must pass lows more than highs (not inverted)");

    // Shelves / peak must deliver real range at the full ±15 dB. +15 dB ≈
    // 5.6× linear; assert clearly above unity. The clamp must also hold:
    // an over-range request resolves to the same gain as the +15 dB limit.
    const double bassMax = toneGainRatio(15.0F, 0.0F, 0.0F, false, false, 40.0);
    require(bassMax > 3.0, "Bass +15 dB should strongly boost 40 Hz");
    require(toneGainRatio(-15.0F, 0.0F, 0.0F, false, false, 40.0) < 0.4, "Bass -15 dB should strongly cut 40 Hz");
    require(toneGainRatio(0.0F, 0.0F, 15.0F, false, false, 12000.0) > 3.0, "Treble +15 dB should strongly boost 12 kHz");
    require(toneGainRatio(0.0F, 15.0F, 0.0F, false, false, 1000.0) > 3.0, "Mid +15 dB should strongly boost 1 kHz");
    const double bassOverdriven = toneGainRatio(40.0F, 0.0F, 0.0F, false, false, 40.0);
    require(std::abs(bassOverdriven - bassMax) < 0.05, "Tone gain must clamp at +15 dB");

    // Revoiced corners: Bass shelf (250 Hz) lifts low-mid body at 200 Hz;
    // Treble shelf (4 kHz) adds presence at 5 kHz — neither is parked out
    // at the spectral extremes where the controls felt inert.
    require(toneGainRatio(12.0F, 0.0F, 0.0F, false, false, 200.0) > 1.5, "Bass should act on low-mid body (~200 Hz)");
    require(toneGainRatio(0.0F, 0.0F, 12.0F, false, false, 5000.0) > 1.5, "Treble should act on presence (~5 kHz)");

    // Flat with both cuts off must be transparent (export-parity guarantee).
    const double flat = toneGainRatio(0.0F, 0.0F, 0.0F, false, false, 1000.0);
    require(std::abs(flat - 1.0) < 0.02, "Flat tone with both cuts off should be transparent");
}

void testLevelerPassthroughAndCompression()
{
    constexpr double sr = 44100.0;
    constexpr int n = 8192;
    const auto fillSine = [sr](juce::AudioBuffer<float>& buf, float amp, double freq) {
        for (int ch = 0; ch < buf.getNumChannels(); ++ch)
        {
            float* d = buf.getWritePointer(ch);
            for (int i = 0; i < buf.getNumSamples(); ++i)
                d[i] = amp * static_cast<float>(
                                 std::sin(2.0 * juce::MathConstants<double>::pi * freq * i / sr));
        }
    };

    // Amount 0 (snapped) must leave every sample untouched, bit-for-bit.
    {
        silverdaw::Leveler lev;
        lev.prepare(sr, 2);
        lev.setParams(0.0F, /*snap*/ true);
        juce::AudioBuffer<float> buf(2, n);
        juce::AudioBuffer<float> ref(2, n);
        fillSine(buf, 0.8F, 220.0);
        fillSine(ref, 0.8F, 220.0);
        lev.process(buf, 0, n);
        bool identical = true;
        for (int ch = 0; ch < 2 && identical; ++ch)
            for (int i = 0; i < n; ++i)
                if (buf.getSample(ch, i) != ref.getSample(ch, i)) { identical = false; break; }
        require(identical, "Amount 0 Leveler must be bit-exact passthrough");
    }

    // Amount 1 must compress a hot signal: the steady-state peak (past the
    // attack ramp) is clearly below the input peak, and output stays finite.
    {
        silverdaw::Leveler lev;
        lev.prepare(sr, 2);
        lev.setParams(1.0F, /*snap*/ true);
        juce::AudioBuffer<float> buf(2, n);
        fillSine(buf, 0.9F, 220.0);
        lev.process(buf, 0, n);
        float peak = 0.0F;
        bool finite = true;
        for (int ch = 0; ch < 2; ++ch)
            for (int i = n / 2; i < n; ++i)
            {
                const float v = buf.getSample(ch, i);
                if (! std::isfinite(v)) finite = false;
                peak = juce::jmax(peak, std::abs(v));
            }
        require(finite, "Leveler output must stay finite");
        require(peak < 0.8F, "Leveler at Amount 1 must reduce a hot signal's peak");
    }

    // Digital silence must stay silent and finite (denormal / NaN guard).
    {
        silverdaw::Leveler lev;
        lev.prepare(sr, 2);
        lev.setParams(1.0F, /*snap*/ true);
        juce::AudioBuffer<float> buf(2, n);
        buf.clear();
        lev.process(buf, 0, n);
        float maxAbs = 0.0F;
        for (int ch = 0; ch < 2; ++ch)
            for (int i = 0; i < n; ++i)
                maxAbs = juce::jmax(maxAbs, std::abs(buf.getSample(ch, i)));
        require(maxAbs == 0.0F, "Leveler must keep digital silence silent");
    }

    // A live glide to Amount 0 (snap=false) must eventually return to a
    // bit-exact passthrough once the smoother and detector have settled —
    // otherwise a track dialled back to off would silently diverge from a
    // never-touched track on export.
    {
        silverdaw::Leveler lev;
        lev.prepare(sr, 2);
        lev.setParams(1.0F, /*snap*/ true);
        juce::AudioBuffer<float> buf(2, n);
        fillSine(buf, 0.9F, 220.0);
        lev.process(buf, 0, n); // compress a hot signal first
        lev.setParams(0.0F, /*snap*/ false); // dial back to off with a glide
        for (int b = 0; b < 80; ++b)
        {
            fillSine(buf, 0.9F, 220.0);
            lev.process(buf, 0, n); // let the glide + release settle
        }
        juce::AudioBuffer<float> ref(2, n);
        fillSine(buf, 0.7F, 330.0);
        fillSine(ref, 0.7F, 330.0);
        lev.process(buf, 0, n);
        bool identical = true;
        for (int ch = 0; ch < 2 && identical; ++ch)
            for (int i = 0; i < n; ++i)
                if (buf.getSample(ch, i) != ref.getSample(ch, i)) { identical = false; break; }
        require(identical,
                "Leveler must return to bit-exact passthrough after a live glide to Amount 0");
    }

    // A single non-finite input sample must not permanently poison the
    // detector: a later clean block must come out fully finite again.
    {
        silverdaw::Leveler lev;
        lev.prepare(sr, 2);
        lev.setParams(1.0F, /*snap*/ true);
        juce::AudioBuffer<float> buf(2, n);
        fillSine(buf, 0.5F, 220.0);
        buf.setSample(0, 100, std::numeric_limits<float>::quiet_NaN());
        buf.setSample(1, 200, std::numeric_limits<float>::infinity());
        lev.process(buf, 0, n);
        fillSine(buf, 0.5F, 220.0); // a clean block after the bad input
        lev.process(buf, 0, n);
        bool finite = true;
        for (int ch = 0; ch < 2 && finite; ++ch)
            for (int i = 0; i < n; ++i)
                if (! std::isfinite(buf.getSample(ch, i))) { finite = false; break; }
        require(finite, "Leveler must recover to finite output after a NaN/Inf input sample");
    }
}

void testSharedFxDelayNoteResolution()
{
    using silverdaw::delayNoteToMs;
    requireNear(delayNoteToMs("1/4", 120.0), 500.0, 1e-6, "1/4 @120 BPM = 500 ms");
    requireNear(delayNoteToMs("1/8", 120.0), 250.0, 1e-6, "1/8 @120 BPM = 250 ms");
    requireNear(delayNoteToMs("1/16", 120.0), 125.0, 1e-6, "1/16 @120 BPM = 125 ms");
    requireNear(delayNoteToMs("1/8T", 120.0), 1000.0 / 6.0, 1e-6, "1/8T @120 BPM = 1/3 beat");
    requireNear(delayNoteToMs("bogus", 120.0), 250.0, 1e-6, "unknown note falls back to 1/8");
    requireNear(delayNoteToMs("1/4", 0.0), 500.0, 1e-6, "non-positive BPM falls back to 120");
}

void testSharedFxUntouchedParityIsExactZero()
{
    silverdaw::SharedFx fx;
    fx.prepare(48000.0, 512);
    // Inactive FX: every knob (incl. mix) at 0, snapped.
    fx.setReverbParams(0.0F, 0.0F, 0.0F, 0.0F, /*snap*/ true);
    fx.setDelayParams(250.0, 0.0F, 0.0F, 0.0F, /*snap*/ true, /*applyTimeNow*/ true);

    juce::AudioBuffer<float> sendR(2, 512), sendD(2, 512), out(2, 512);
    sendR.clear();
    sendD.clear();
    for (int ch = 0; ch < 2; ++ch)
        for (int i = 0; i < 512; ++i)
            out.setSample(ch, i, std::sin(static_cast<float>(i) * 0.05F) * (ch ? 0.5F : 0.7F));

    juce::AudioBuffer<float> before;
    before.makeCopyOf(out);
    fx.process(sendR, sendD, out, 0, 512);

    for (int ch = 0; ch < 2; ++ch)
        for (int i = 0; i < 512; ++i)
            require(out.getSample(ch, i) == before.getSample(ch, i),
                    "inactive shared FX must not alter the dry bus by even one ULP");
}

void testSharedFxRoomTailRingsAndTerminates()
{
    silverdaw::SharedFx fx;
    const double sr = 48000.0;
    const int n = 512;
    fx.prepare(sr, n);
    fx.setReverbParams(/*size*/ 1.0F, /*decay*/ 1.0F, /*tone*/ 1.0F, /*mix*/ 1.0F, /*snap*/ true);
    fx.setDelayParams(250.0, 0.0F, 0.0F, 0.0F, /*snap*/ true, /*applyTimeNow*/ true); // Echo off

    juce::AudioBuffer<float> sendR(2, n), sendD(2, n), out(2, n);
    sendD.clear();
    sendR.clear();
    for (int ch = 0; ch < 2; ++ch)
        for (int i = 0; i < n; ++i)
            sendR.setSample(ch, i, 0.5F);
    out.clear();
    fx.process(sendR, sendD, out, 0, n);
    require(out.getMagnitude(0, 0, n) > 0.0, "Room must produce wet output while fed");
    require(! fx.reverbTerminated(), "Room must not report terminated while being fed");

    bool sawTail = false;
    bool terminated = false;
    sendR.clear();
    const int maxBlocks = static_cast<int>(std::ceil(10.0 * sr / n));
    for (int b = 0; b < maxBlocks; ++b)
    {
        out.clear();
        fx.process(sendR, sendD, out, 0, n);
        if (out.getMagnitude(0, 0, n) > 1.0e-5F) sawTail = true;
        if (fx.reverbTerminated())
        {
            terminated = true;
            break;
        }
    }
    require(sawTail, "Room tail must keep ringing after the input stops");
    require(terminated, "Room tail must self-terminate within the safety cap");
}

void testSharedFxEchoRepeatsAndTerminates()
{
    silverdaw::SharedFx fx;
    const double sr = 48000.0;
    const int n = 256;
    fx.prepare(sr, n);
    fx.setReverbParams(0.0F, 0.0F, 0.0F, 0.0F, /*snap*/ true); // Room off
    const double delayMs = 5.0; // 240 samples @48k, fits inside one block
    fx.setDelayParams(delayMs, 0.5F, 1.0F, 1.0F, /*snap*/ true, /*applyTimeNow*/ true);

    juce::AudioBuffer<float> sendR(2, n), sendD(2, n), out(2, n);
    sendR.clear();
    sendD.clear();
    sendD.setSample(0, 0, 1.0F);
    sendD.setSample(1, 0, 1.0F);
    out.clear();
    fx.process(sendR, sendD, out, 0, n);

    const int d = static_cast<int>(std::round(delayMs * sr / 1000.0));
    require(std::abs(out.getSample(0, 0)) < 1.0e-6F, "Echo is wet-only: no dry signal at t=0");
    require(std::abs(out.getSample(0, d)) > 0.5F,
            "Echo must reproduce a delayed copy at the resolved delay time");

    bool terminated = false;
    sendD.clear();
    const int maxBlocks = static_cast<int>(std::ceil(5.0 * sr / n));
    for (int b = 0; b < maxBlocks; ++b)
    {
        out.clear();
        fx.process(sendR, sendD, out, 0, n);
        if (fx.echoTerminated())
        {
            terminated = true;
            break;
        }
    }
    require(terminated, "Echo tail must self-terminate within the safety cap");
}

void testEqualPowerPanGains()
{
        float gL = 0.0F;
        float gR = 0.0F;

        // Centre is unity on both channels (0 dB) so a centred track matches
        // the no-pan path bit-for-bit.
        silverdaw::BusGraph::equalPowerPanGains(0.0F, gL, gR);
        requireNear(gL, 1.0, 1.0e-5, "centre left gain is unity");
        requireNear(gR, 1.0, 1.0e-5, "centre right gain is unity");

        // Hard left: the right channel is silent; left rises by +3 dB
        // (sqrt2) under the constant-power law.
        silverdaw::BusGraph::equalPowerPanGains(-1.0F, gL, gR);
        requireNear(gL, std::sqrt(2.0), 1.0e-5, "hard-left left gain is sqrt2");
        requireNear(gR, 0.0, 1.0e-5, "hard-left right gain is zero");

        // Hard right is the mirror image.
        silverdaw::BusGraph::equalPowerPanGains(1.0F, gL, gR);
        requireNear(gL, 0.0, 1.0e-5, "hard-right left gain is zero");
        requireNear(gR, std::sqrt(2.0), 1.0e-5, "hard-right right gain is sqrt2");

        // Constant power: gainL^2 + gainR^2 == 2 at every position.
        for (const float p : {-1.0F, -0.6F, -0.25F, 0.0F, 0.33F, 0.75F, 1.0F})
        {
            silverdaw::BusGraph::equalPowerPanGains(p, gL, gR);
            requireNear(static_cast<double>(gL * gL + gR * gR), 2.0, 1.0e-5,
                        "equal-power law keeps constant power across the sweep");
        }
}

// Regression guard for the atomic pan publication: a lock-free setTrackPan must
// still apply the equal-power gains through the audio-thread mix.
void testBusGraphPanAppliedThroughMix()
{
    constexpr int kBlock = 256;
    constexpr double kRate = 48000.0;
    silverdaw::BusGraph bg;
    bg.prepareToPlay(kBlock, kRate);

    ConstantSource src(0.5F);
    bg.attachClip("t1", "c1", &src);
    bg.setTrackPan("t1", -1.0F); // hard left

    juce::AudioBuffer<float> out(2, kBlock);
    out.clear();
    juce::AudioSourceChannelInfo info(&out, 0, kBlock);
    bg.getNextAudioBlock(info);

    requireNear(out.getMagnitude(0, 0, kBlock), 0.5 * std::sqrt(2.0), 1.0e-4,
                "hard-left pan boosts the left channel by sqrt2");
    requireNear(out.getMagnitude(1, 0, kBlock), 0.0, 1.0e-4,
                "hard-left pan silences the right channel");

    bg.releaseResources();
}

// Stress the lock-free setters (pan/sends/peaks) and the locked tone setter
// concurrently with the audio callback: output must stay finite, no crash or
// deadlock, and the final published state must take effect deterministically.
void testBusGraphConcurrentParamUpdatesAreSafe()
{
    constexpr int kBlock = 128;
    constexpr double kRate = 48000.0;
    silverdaw::BusGraph bg;
    bg.prepareToPlay(kBlock, kRate);

    ConstantSource src(0.25F);
    bg.attachClip("t1", "c1", &src);

    std::atomic<bool> stop{false};
    std::thread writer([&]() {
        int i = 0;
        std::vector<silverdaw::BusGraph::TrackPeakSnapshot> peaks;
        while (! stop.load(std::memory_order_relaxed))
        {
            const float pan = (static_cast<float>(i % 200) / 100.0F) - 1.0F; // sweep -1..1
            bg.setTrackPan("t1", pan);
            bg.setTrackSends("t1", 0.3F, 0.2F);
            bg.setTrackTone("t1", 2.0F, -1.0F, 1.5F, false, false, false);
            bg.drainAllTrackPeaks(peaks);
            ++i;
        }
    });

    juce::AudioBuffer<float> out(2, kBlock);
    juce::AudioSourceChannelInfo info(&out, 0, kBlock);
    for (int b = 0; b < 4000; ++b)
    {
        out.clear();
        bg.getNextAudioBlock(info);
        require(std::isfinite(out.getMagnitude(0, 0, kBlock)),
                "left output stays finite under concurrent param churn");
        require(std::isfinite(out.getMagnitude(1, 0, kBlock)),
                "right output stays finite under concurrent param churn");
    }

    stop.store(true, std::memory_order_relaxed);
    writer.join();

    // Settle to a known pan and confirm the lock-free publication took effect.
    // Assert on hard-left so the check is independent of the tone EQ the stress
    // loop left applied: the right channel is silenced by gainR=0 regardless.
    bg.setTrackPan("t1", -1.0F);
    out.clear();
    bg.getNextAudioBlock(info);
    requireNear(out.getMagnitude(1, 0, kBlock), 0.0, 1.0e-4,
                "settled hard-left pan silences the right channel");
    require(out.getMagnitude(0, 0, kBlock) > 0.01F,
            "settled hard-left pan keeps the left channel audible");

    bg.releaseResources();
}

} // namespace

void addFxDspTests(std::vector<TestCase>& tests)
{
    tests.push_back({"ToneEq low-cut is a high-pass and shelves have �15 dB range", testToneEqLowCutDirectionAndShelfRange});
    tests.push_back({"Leveler is bit-exact at Amount 0 and compresses a hot signal at Amount 1", testLevelerPassthroughAndCompression});
    tests.push_back({"SharedFx delayNoteToMs resolves note values per BPM", testSharedFxDelayNoteResolution});
    tests.push_back({"SharedFx is bit-exact transparent when inactive (mix=0)", testSharedFxUntouchedParityIsExactZero});
    tests.push_back({"SharedFx Room rings a tail after input stops and terminates", testSharedFxRoomTailRingsAndTerminates});
    tests.push_back({"SharedFx Echo reproduces a delayed copy and terminates", testSharedFxEchoRepeatsAndTerminates});
    tests.push_back({"BusGraph equal-power pan gains (unity centre, constant power)", testEqualPowerPanGains});
    tests.push_back({"BusGraph lock-free pan publishes equal-power gains through the mix", testBusGraphPanAppliedThroughMix});
    tests.push_back({"BusGraph stays safe under concurrent lock-free param updates", testBusGraphConcurrentParamUpdatesAreSafe});
}

} // namespace silverdaw::tests
