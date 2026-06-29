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
#include "TrackAutomationSnapshot.h"
#include "BreakpointCurve.h"
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

double toneGainRatio(float bassDb, float midDb, float trebleDb, float filter,
                     double freq)
{
    constexpr double sr = 44100.0;
    silverdaw::ToneEq eq;
    eq.prepare(sr, 2);
    eq.setParams(bassDb, midDb, trebleDb, filter, /*snap*/ true);

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
    // The bipolar Filter sweeps one corner at a time. Positive (+1) is a
    // 4th-order (24 dB/oct) high-pass (Low Cut) reaching ~2 kHz: highs above
    // the corner pass while lows are strongly removed. The inverted (low-pass)
    // regression fails the direction guard; a too-gentle 2nd-order voicing
    // fails the octave-slope guard below.
    const double passHigh = toneGainRatio(0.0F, 0.0F, 0.0F, 1.0F, 8000.0);
    const double cutLow = toneGainRatio(0.0F, 0.0F, 0.0F, 1.0F, 200.0);
    const double cutOctave = toneGainRatio(0.0F, 0.0F, 0.0F, 1.0F, 1000.0);
    require(passHigh > 0.9, "Low Cut (filter +1) must pass 8 kHz roughly unchanged");
    require(cutLow < 0.05, "Low Cut (filter +1) must strongly attenuate 200 Hz");
    // One octave below the ~2 kHz corner sits well under a 2nd-order voicing,
    // locking in the 24 dB/oct slope.
    require(cutOctave < 0.15, "Low Cut must have a 24 dB/oct slope (1 kHz well below 2nd-order)");
    require(passHigh > cutLow + 0.3, "Low Cut must pass highs more than lows (not inverted)");

    // Negative (-1) is a 4th-order (24 dB/oct) low-pass (High Cut) reaching
    // ~250 Hz: lows pass while highs are strongly removed (mirror of Low Cut).
    const double passLow = toneGainRatio(0.0F, 0.0F, 0.0F, -1.0F, 80.0);
    const double cutHigh = toneGainRatio(0.0F, 0.0F, 0.0F, -1.0F, 2000.0);
    const double cutOctaveHi = toneGainRatio(0.0F, 0.0F, 0.0F, -1.0F, 500.0);
    require(passLow > 0.9, "High Cut (filter -1) must pass 80 Hz roughly unchanged");
    require(cutHigh < 0.05, "High Cut (filter -1) must strongly attenuate 2 kHz");
    // One octave above the ~250 Hz corner sits well below a 2nd-order voicing.
    require(cutOctaveHi < 0.15, "High Cut must have a 24 dB/oct slope (500 Hz well below 2nd-order)");
    require(passLow > cutHigh + 0.3, "High Cut must pass lows more than highs (not inverted)");

    // The sweep is monotonic: a half-throw Low Cut cuts a low tone less than
    // the full throw (corner glides up with the control).
    const double halfCutLow = toneGainRatio(0.0F, 0.0F, 0.0F, 0.5F, 200.0);
    require(halfCutLow > cutLow, "A weaker filter must attenuate the band less than a stronger one");

    // Shelves / peak must deliver real range at the full ±15 dB. +15 dB ≈
    // 5.6× linear; assert clearly above unity. The clamp must also hold:
    // an over-range request resolves to the same gain as the +15 dB limit.
    const double bassMax = toneGainRatio(15.0F, 0.0F, 0.0F, 0.0F, 40.0);
    require(bassMax > 3.0, "Bass +15 dB should strongly boost 40 Hz");
    require(toneGainRatio(-15.0F, 0.0F, 0.0F, 0.0F, 40.0) < 0.4, "Bass -15 dB should strongly cut 40 Hz");
    require(toneGainRatio(0.0F, 0.0F, 15.0F, 0.0F, 12000.0) > 3.0, "Treble +15 dB should strongly boost 12 kHz");
    require(toneGainRatio(0.0F, 15.0F, 0.0F, 0.0F, 1000.0) > 3.0, "Mid +15 dB should strongly boost 1 kHz");
    const double bassOverdriven = toneGainRatio(40.0F, 0.0F, 0.0F, 0.0F, 40.0);
    require(std::abs(bassOverdriven - bassMax) < 0.05, "Tone gain must clamp at +15 dB");

    // Revoiced corners: Bass shelf (250 Hz) lifts low-mid body at 200 Hz;
    // Treble shelf (4 kHz) adds presence at 5 kHz — neither is parked out
    // at the spectral extremes where the controls felt inert.
    require(toneGainRatio(12.0F, 0.0F, 0.0F, 0.0F, 200.0) > 1.5, "Bass should act on low-mid body (~200 Hz)");
    require(toneGainRatio(0.0F, 0.0F, 12.0F, 0.0F, 5000.0) > 1.5, "Treble should act on presence (~5 kHz)");

    // Flat with the filter centred must be transparent (export-parity guarantee).
    const double flat = toneGainRatio(0.0F, 0.0F, 0.0F, 0.0F, 1000.0);
    require(std::abs(flat - 1.0) < 0.02, "Flat tone with the filter centred should be transparent");
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
            bg.setTrackTone("t1", 2.0F, -1.0F, 1.5F, 0.0F, false);
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

// M-auto: a track's filter automation that sweeps to a hard low-pass and back to
// neutral must reopen the high end; the level lane returning to 0 dB must restore
// full gain. Verifies the curve-clamp + ToneEq glide actually settle to identity.
void testBusGraphFilterAndLevelAutomationResetToNeutral()
{
    constexpr int kBlock = 256;
    constexpr double kRate = 44100.0;
    silverdaw::BusGraph bg;
    bg.prepareToPlay(kBlock, kRate);

    std::atomic<juce::int64> pos{0};
    bg.setTimelineSamplesSource(&pos);

    ConstantSource src(0.5F);
    bg.attachClip("t1", "c1", &src);

    auto snap = std::make_unique<silverdaw::TrackAutomationSnapshot>();
    {
        silverdaw::BreakpointCurve f(silverdaw::InterpDomain::linear);
        f.addPoint(0.0, 0.0F);
        f.addPoint(7000.0, -1.0F);  // hard low-pass
        f.addPoint(8000.0, 0.0F);   // back to neutral
        f.addPoint(20000.0, 0.0F);
        f.finalise();
        const int fi = static_cast<int>(silverdaw::AutomationParam::filter);
        snap->has[fi] = true;
        snap->curves[fi] = std::move(f);

        silverdaw::BreakpointCurve lv(silverdaw::InterpDomain::linear);
        lv.addPoint(0.0, 0.0F);
        lv.addPoint(7000.0, -60.0F); // silent
        lv.addPoint(8000.0, 0.0F);   // unity again
        lv.addPoint(20000.0, 0.0F);
        lv.finalise();
        const int li = static_cast<int>(silverdaw::AutomationParam::level);
        snap->has[li] = true;
        snap->curves[li] = std::move(lv);
    }
    bg.setTrackAutomationPtr("t1", snap.get());

    juce::AudioBuffer<float> out(2, kBlock);
    juce::AudioSourceChannelInfo info(&out, 0, kBlock);

    const auto runTo = [&](double ms) -> double {
        pos.store(static_cast<juce::int64>(ms / 1000.0 * kRate));
        double mag = 0.0;
        for (int b = 0; b < 8; ++b) { out.clear(); bg.getNextAudioBlock(info); mag = out.getMagnitude(0, 0, kBlock); }
        return mag;
    };

    const double dip = runTo(7000.0);
    const double after = runTo(12000.0);
    require(dip < 0.05, "filter+level dip should be near-silent (LPF closed, level -60dB)");
    requireNear(after, 0.5, 0.05, "after the sweep returns to neutral, full DC level is restored");

    // Clearing the lane mid-dip must restore neutral, not freeze the last value.
    runTo(7000.0);
    bg.setTrackAutomationPtr("t1", nullptr);
    bg.snapParamToDefault("t1", silverdaw::AutomationParam::filter);
    bg.snapParamToDefault("t1", silverdaw::AutomationParam::level);
    double cleared = 0.0;
    for (int b = 0; b < 8; ++b) { out.clear(); bg.getNextAudioBlock(info); cleared = out.getMagnitude(0, 0, kBlock); }
    requireNear(cleared, 0.5, 0.05, "clearing a lane restores the track to unity, not the last automated value");

    bg.releaseResources();
}

// M-auto: discontinuity matrix — a level lane must snap (not glide) when the
// transport seeks backwards, when cursors are force-snapped on play, and when the
// snapshot pointer swaps mid-stream. Each jump must land on the curve value in one
// block; a stuck/gliding value would fail the immediate-magnitude checks.
void testBusGraphAutomationSnapsAcrossDiscontinuities()
{
    constexpr int kBlock = 256;
    constexpr double kRate = 44100.0;
    silverdaw::BusGraph bg;
    bg.prepareToPlay(kBlock, kRate);

    std::atomic<juce::int64> pos{0};
    bg.setTimelineSamplesSource(&pos);
    ConstantSource src(1.0F);
    bg.attachClip("t1", "c1", &src);

    auto mk = [](float v0, float v1) {
        auto s = std::make_unique<silverdaw::TrackAutomationSnapshot>();
        silverdaw::BreakpointCurve lv(silverdaw::InterpDomain::linear);
        lv.addPoint(0.0, v0);          // 0 dB unity
        lv.addPoint(10000.0, v1);      // ramp to v1 dB
        lv.finalise();
        const int li = static_cast<int>(silverdaw::AutomationParam::level);
        s->has[li] = true; s->curves[li] = std::move(lv);
        return s;
    };
    auto snap = mk(0.0F, -60.0F);
    bg.setTrackAutomationPtr("t1", snap.get());

    juce::AudioBuffer<float> out(2, kBlock);
    juce::AudioSourceChannelInfo info(&out, 0, kBlock);
    const auto block = [&](double ms) -> double {
        pos.store(static_cast<juce::int64>(ms / 1000.0 * kRate));
        out.clear(); bg.getNextAudioBlock(info); return out.getMagnitude(0, 0, kBlock);
    };

    block(10000.0);                    // near silent at the end of the ramp
    bg.snapAutomationCursors();        // play-start snap
    require(block(0.0) > 0.9, "seek-to-start snaps level to unity in one block, no glide");
    require(block(10000.0) < 0.1, "seek to ramp end snaps to -60 dB in one block");

    auto snap2 = mk(0.0F, 0.0F);       // flat unity
    bg.setTrackAutomationPtr("t1", snap2.get());
    require(block(10000.0) > 0.9, "snapshot swap re-cursors and applies the new curve immediately");

    bg.setTrackAutomationPtr("t1", nullptr);
    bg.releaseResources();
}

// M3: the project-FX setters and resetSharedFx are now lock-free. Hammer them
// (plus the unlocked tone/leveler setters) from a writer thread while the audio
// callback pumps the shared FX: output must stay finite with no crash or deadlock.
void testBusGraphLockFreeProjectFxUpdatesAreSafe()
{
    constexpr int kBlock = 128;
    constexpr double kRate = 48000.0;
    silverdaw::BusGraph bg;
    bg.prepareToPlay(kBlock, kRate);

    ConstantSource src(0.25F);
    bg.attachClip("t1", "c1", &src);
    bg.setTrackSends("t1", 0.5F, 0.5F); // feed both shared FX

    std::atomic<bool> stop{false};
    std::thread writer([&]() {
        int i = 0;
        while (! stop.load(std::memory_order_relaxed))
        {
            const float u = static_cast<float>(i % 100) / 100.0F;
            bg.setProjectReverb(u, 1.0F - u, u, u, /*snap*/ (i % 7) == 0);
            bg.setProjectDelay(50.0 + 200.0 * u, 0.4F * u, u, u, /*snap*/ (i % 11) == 0,
                               /*applyTimeNow*/ (i % 3) == 0);
            bg.setTrackTone("t1", 6.0F * u, -3.0F * u, 4.0F * u, 2.0F * u - 1.0F,
                            (i % 13) == 0);
            bg.setTrackLeveler("t1", u, (i % 17) == 0);
            if ((i % 5) == 0) bg.resetSharedFx();
            ++i;
        }
    });

    juce::AudioBuffer<float> out(2, kBlock);
    juce::AudioSourceChannelInfo info(&out, 0, kBlock);
    for (int b = 0; b < 4000; ++b)
    {
        out.clear();
        bg.getNextAudioBlock(info);
        require(std::isfinite(out.getMagnitude(0, 0, kBlock))
                    && std::isfinite(out.getMagnitude(1, 0, kBlock)),
                "shared-FX output stays finite under concurrent lock-free project-FX churn");
    }

    stop.store(true, std::memory_order_relaxed);
    writer.join();
    bg.releaseResources();
}

// M3: resetSharedFx is deferred (requestReset) and consumed by the next audio
// block, so a ringing tail must be cut on the block after the reset is scheduled.
void testSharedFxRequestResetCutsTailNextBlock()
{
    silverdaw::SharedFx fx;
    const double sr = 48000.0;
    const int n = 512;
    fx.prepare(sr, n);
    fx.setReverbParams(1.0F, 1.0F, 1.0F, 1.0F, /*snap*/ true);
    fx.setDelayParams(250.0, 0.0F, 0.0F, 0.0F, /*snap*/ true, /*applyTimeNow*/ true); // Echo off

    juce::AudioBuffer<float> sendR(2, n), sendD(2, n), out(2, n);
    sendD.clear();
    for (int b = 0; b < 8; ++b) // prime the room so the tail builds up
    {
        for (int ch = 0; ch < 2; ++ch)
            for (int i = 0; i < n; ++i) sendR.setSample(ch, i, 0.5F);
        out.clear();
        fx.process(sendR, sendD, out, 0, n);
    }

    sendR.clear();
    out.clear();
    fx.process(sendR, sendD, out, 0, n); // let the tail ring, no further input
    const double tail = out.getMagnitude(0, 0, n);
    require(tail > 1.0e-4, "Room tail should be audible before the reset");

    fx.requestReset(); // lock-free: consumed at the top of the next process block
    out.clear();
    fx.process(sendR, sendD, out, 0, n);
    require(out.getMagnitude(0, 0, n) < tail * 0.01,
            "requestReset must clear the reverb tail on the next processed block");
}

// M3: snap is now a deferred flag consumed by process. A snapped Tone EQ must
// apply the full boost on the FIRST block, while a non-snap setter glides in.
void testToneEqSnapAppliesOnFirstBlock()
{
    constexpr double sr = 48000.0;
    constexpr int n = 128; // ~2.7 ms, far shorter than the 20 ms param glide
    const auto sine = [sr](juce::AudioBuffer<float>& b) {
        for (int ch = 0; ch < b.getNumChannels(); ++ch)
            for (int i = 0; i < b.getNumSamples(); ++i)
                b.setSample(ch, i, 0.25F * static_cast<float>(std::sin(
                                       2.0 * juce::MathConstants<double>::pi * 1000.0 * i / sr)));
    };

    silverdaw::ToneEq snapped;
    snapped.prepare(sr, 2);
    snapped.setParams(0.0F, 15.0F, 0.0F, 0.0F, /*snap*/ true); // +15 dB mid @1 kHz
    juce::AudioBuffer<float> a(2, n);
    sine(a);
    snapped.process(a, 0, n);
    const double snapRms = toneRms(a, 0, n);

    silverdaw::ToneEq glided;
    glided.prepare(sr, 2);
    glided.setParams(0.0F, 15.0F, 0.0F, 0.0F, /*snap*/ false);
    juce::AudioBuffer<float> b(2, n);
    sine(b);
    glided.process(b, 0, n);
    const double glideRms = toneRms(b, 0, n);

    require(snapRms > glideRms * 1.5,
            "snap applies the full Tone EQ boost on the first block; glide ramps in slowly");
}

// M3: a snapped Leveler must apply its makeup on the FIRST block; the non-snap
// setter glides in from passthrough, so a quiet signal is barely boosted yet.
void testLevelerSnapAppliesOnFirstBlock()
{
    constexpr double sr = 48000.0;
    constexpr int n = 128;
    const auto sine = [sr](juce::AudioBuffer<float>& b, float amp) {
        for (int ch = 0; ch < b.getNumChannels(); ++ch)
            for (int i = 0; i < b.getNumSamples(); ++i)
                b.setSample(ch, i, amp * static_cast<float>(std::sin(
                                       2.0 * juce::MathConstants<double>::pi * 220.0 * i / sr)));
    };

    silverdaw::Leveler snapped;
    snapped.prepare(sr, 2);
    snapped.setParams(1.0F, /*snap*/ true);
    juce::AudioBuffer<float> a(2, n);
    sine(a, 0.05F); // quiet -> auto-makeup should boost it
    snapped.process(a, 0, n);
    const double snapRms = toneRms(a, 0, n);

    silverdaw::Leveler glided;
    glided.prepare(sr, 2);
    glided.setParams(1.0F, /*snap*/ false);
    juce::AudioBuffer<float> b(2, n);
    sine(b, 0.05F);
    glided.process(b, 0, n);
    const double glideRms = toneRms(b, 0, n);

    require(snapRms > glideRms * 1.2,
            "snap applies the Leveler makeup on the first block; glide ramps in slowly");
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
    tests.push_back({"BusGraph filter+level automation resets to neutral after a sweep", testBusGraphFilterAndLevelAutomationResetToNeutral});
    tests.push_back({"BusGraph automation snaps across seek/snapshot discontinuities", testBusGraphAutomationSnapsAcrossDiscontinuities});
    tests.push_back({"BusGraph stays safe under concurrent lock-free param updates", testBusGraphConcurrentParamUpdatesAreSafe});
    tests.push_back({"BusGraph stays safe under concurrent lock-free project-FX updates", testBusGraphLockFreeProjectFxUpdatesAreSafe});
    tests.push_back({"SharedFx requestReset cuts the tail on the next audio block", testSharedFxRequestResetCutsTailNextBlock});
    tests.push_back({"ToneEq snap applies the full boost on the first block", testToneEqSnapAppliesOnFirstBlock});
    tests.push_back({"Leveler snap applies the makeup on the first block", testLevelerSnapAppliesOnFirstBlock});
}

} // namespace silverdaw::tests
