// AudioEngine: thread-safety of preview warp under rapid calls, bounded/safe
// playback priming, and the post-gain transport-gated output keep-alive floor.

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

// Author a short, real, decodable WAV so engine.addClip builds the full
// per-track source chain (AudioFormatReaderSource → OffsetSource →
// BufferingAudioSource → AudioTransportSource). A faint sine keeps it from
// being pure silence; content is otherwise irrelevant to these tests.
juce::File writeTestWav(const juce::File& dir, const juce::String& name,
                        double seconds, double sampleRate = 44100.0)
{
    auto file = dir.getChildFile(name);
    juce::WavAudioFormat format;
    std::unique_ptr<juce::FileOutputStream> stream(file.createOutputStream());
    require(stream != nullptr, "wav output stream should open");
    std::unique_ptr<juce::AudioFormatWriter> writer(
        format.createWriterFor(stream.get(), sampleRate, 2, 16, juce::StringPairArray(), 0));
    require(writer != nullptr, "wav writer should create");
    stream.release(); // writer owns the stream now

    const int numSamples = juce::jmax(1, static_cast<int>(seconds * sampleRate));
    juce::AudioBuffer<float> buffer(2, numSamples);
    for (int ch = 0; ch < 2; ++ch)
    {
        auto* data = buffer.getWritePointer(ch);
        for (int i = 0; i < numSamples; ++i)
        {
            data[i] = 0.1F * static_cast<float>(
                          std::sin(2.0 * juce::MathConstants<double>::pi * 220.0 * i / sampleRate));
        }
    }
    require(writer->writeFromAudioSampleBuffer(buffer, 0, numSamples), "wav write should succeed");
    writer.reset(); // flush + close
    return file;
}

void testAudioEngineSetPreviewWarpUnderRapidCalls()
{
    silverdaw::AudioEngine engine;

    constexpr int kCallCount = 2000; // > 100 Hz over a typical real-time second.
    std::atomic<bool> readerStop{false};
    std::atomic<long> readerLoops{0};

    // Fake "audio thread": continuously reads cheap engine getters that
    // the real audio callback also touches. Any iteration that hits a
    // crash or hang surfaces as a test failure (process abort) /
    // timeout.
    std::thread reader([&]() {
        while (!readerStop.load(std::memory_order_relaxed))
        {
            (void) engine.isPreviewLoaded();
            (void) engine.isPreviewPlaying();
            (void) engine.getPreviewPositionMs();
            (void) engine.getPreviewDurationMs();
            (void) engine.getPreviewGeneration();
            readerLoops.fetch_add(1, std::memory_order_relaxed);
        }
    });

    // Drive setPreviewWarp on the main thread. Each iteration toggles
    // mode + tempo + pitch so the call exercises the same branches
    // the live UI hits while the user drags the warp sliders.
    int okCount = 0;
    int falseCount = 0;
    for (int i = 0; i < kCallCount; ++i)
    {
        const bool enabled = (i & 1) == 0;
        const auto mode = juce::String((i % 3 == 0) ? "rhythmic" : (i % 3 == 1) ? "tonal" : "complex");
        const double tempoRatio = 1.0 + ((i % 11) - 5) * 0.02; // 0.90 .. 1.10
        const double semitones = static_cast<double>(((i % 25) - 12)); // -12 .. +12
        const double cents = static_cast<double>(((i % 201) - 100));   // -100 .. +100
        const bool ok = engine.setPreviewWarp(enabled, mode, tempoRatio, semitones, cents);
        if (ok) ++okCount;
        else ++falseCount;
    }

    readerStop.store(true, std::memory_order_relaxed);
    reader.join();

    require(okCount + falseCount == kCallCount, "every call should return a definite bool");
    // With no preview loaded, setPreviewWarp is documented as no-op
    // returning false. The assertion is intentionally loose — if a
    // future API change permits configuring without a preview, the
    // test still passes (the regression we care about is crashes /
    // UB under rapid invocation, not the return value).
    require(falseCount == kCallCount,
            "setPreviewWarp should no-op (return false) when no preview is loaded");
    require(readerLoops.load(std::memory_order_relaxed) > 0,
            "reader thread should have observed at least one engine state read");
}

void testAudioEnginePrimeTracksForPlaybackIsSafeAndBounded()
{
    const auto dir = makeTempDir("prime-tracks");
    silverdaw::AudioEngine engine;
    engine.initialise({}, {}, nullptr); // registers WAV/etc. formats for addClip

    const auto a = writeTestWav(dir, "a.wav", 2.0);
    const auto b = writeTestWav(dir, "b.wav", 2.0);
    require(engine.addClip("t1", "c1", a, 0.0), "addClip c1 should build the owned-buffer chain");
    require(engine.addClip("t1", "c2", b, 500.0), "addClip c2 should build the owned-buffer chain");

    // Prime at the current position. Must be safe and bounded regardless of
    // whether a device is open on this host.
    const auto t0 = juce::Time::getMillisecondCounterHiRes();
    engine.primeTracksForPlayback(silverdaw::kLoadPrimeBudgetMs);
    const auto elapsed = juce::Time::getMillisecondCounterHiRes() - t0;
    require(elapsed < 3000.0, "primeTracksForPlayback must stay bounded (never hang)");

    // Jump-to-start then play-immediately path: seek, prime, play, stop. The
    // chain must survive all of it without crashing.
    engine.setPositionMs(0.0);
    const bool ready = engine.primeTracksForPlayback(silverdaw::kPlayPrimeBudgetMs);
    engine.play();  // play() primes internally before opening the gate
    // Fail-closed contract: the master gate opens only when priming reports
    // every track ready. With a device open the local test WAVs fill instantly
    // (ready == true → playing); with no device priming returns false and the
    // gate stays closed (ready == false → not playing) rather than advancing
    // through a cold buffer and swallowing the clip as silence. Either way the
    // two must agree.
    require(engine.isPlaying() == ready,
            "play() must open the gate iff priming reports ready (fail-closed)");
    engine.stop();

    require(engine.removeClip("c1"), "removeClip c1 should succeed");
    require(engine.removeClip("c2"), "removeClip c2 should succeed");

    engine.shutdown();
    dir.deleteRecursively();
}

void testOutputKeepAliveFloorIsPostGainAndGated()
{
    const float threshold = static_cast<float>(silverdaw::kKeepAliveSilenceThreshold);
    const float amplitude = static_cast<float>(silverdaw::kKeepAliveDitherAmplitude);

    auto blockPeak = [](const juce::AudioBuffer<float>& buf) {
        float p = 0.0F;
        for (int ch = 0; ch < buf.getNumChannels(); ++ch)
            p = juce::jmax(p, buf.getMagnitude(ch, 0, buf.getNumSamples()));
        return p;
    };

    // ── Direct OutputKeepAlive checks ──
    {
        silverdaw::OutputKeepAlive ka;
        require(! ka.shouldRun(), "default gate must be closed (idle, paused)");

        juce::AudioBuffer<float> buf(2, 1024);
        buf.clear();
        require(! ka.maybeApplyFloor(buf, 0, buf.getNumSamples(), 0.0F),
                "gate closed must not inject a floor");
        require(blockPeak(buf) == 0.0F, "gate closed must leave true digital silence");

        // contentLoaded must NOT open the gate — a loaded-but-stopped project
        // stays truly silent (the regression we're fixing was idle hiss).
        ka.setContentLoaded(true);
        require(! ka.shouldRun(), "contentLoaded must not open the gate (idle stays silent)");
        buf.clear();
        require(! ka.maybeApplyFloor(buf, 0, buf.getNumSamples(), 0.0F),
                "a loaded-but-stopped project must emit true silence, not a floor");
        require(blockPeak(buf) == 0.0F, "idle-with-content must leave true digital silence");

        // The wake pre-roll opens the gate.
        ka.setWakePreroll(true);
        require(ka.shouldRun(), "wake pre-roll must open the gate while paused");
        buf.clear();
        require(ka.maybeApplyFloor(buf, 0, buf.getNumSamples(), 0.0F),
                "gate open + silent block must inject the floor");
        const float floorPeak = blockPeak(buf);
        require(floorPeak > threshold, "injected floor must clear the silence threshold");
        require(floorPeak <= amplitude * 1.2F, "injected floor must stay bounded near the dither amplitude");

        // Real content (program peak above threshold) is never coloured.
        buf.clear();
        for (int ch = 0; ch < buf.getNumChannels(); ++ch)
            buf.setSample(ch, 0, 0.5F);
        require(! ka.maybeApplyFloor(buf, 0, buf.getNumSamples(), 0.5F),
                "a block carrying real content must not be coloured");

        // Playing opens the gate independently of the pre-roll.
        ka.setWakePreroll(false);
        ka.setPlaying(true);
        require(ka.shouldRun(), "playing must open the gate regardless of wake pre-roll");
        buf.clear();
        require(ka.maybeApplyFloor(buf, 0, buf.getNumSamples(), 0.0F),
                "playing + silent block must inject the floor");

        // Stopped + no pre-roll → true silence again.
        ka.setPlaying(false);
        require(! ka.shouldRun(), "stopped with no pre-roll must close the gate");
        buf.clear();
        require(! ka.maybeApplyFloor(buf, 0, buf.getNumSamples(), 0.0F),
                "closed gate must not inject a floor");
        require(blockPeak(buf) == 0.0F, "closed gate must leave true digital silence");
    }

    // ── MeteringSource integration: the floor survives a low master gain ──
    struct ConstantSource : juce::AudioSource
    {
        explicit ConstantSource(float v) : value(v) {}
        void prepareToPlay(int, double) override {}
        void releaseResources() override {}
        void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override
        {
            for (int ch = 0; ch < info.buffer->getNumChannels(); ++ch)
                juce::FloatVectorOperations::fill(
                    info.buffer->getWritePointer(ch, info.startSample), value, info.numSamples);
        }
        float value;
    };

    constexpr float lowGain = 0.25F;
    {
        // Silent program + wake pre-roll active + low master gain. The old
        // upstream injection would deliver ~amplitude * lowGain (~0.001 here);
        // the post-gain injection must deliver the FULL floor.
        silverdaw::OutputKeepAlive ka;
        ka.setWakePreroll(true);
        ConstantSource silentSource(0.0F);
        silverdaw::MeteringSource meter(silentSource, ka);
        meter.setTargetGain(lowGain);
        meter.prepareToPlay(1024, 48000.0);

        juce::AudioBuffer<float> buf(2, 1024);
        juce::AudioSourceChannelInfo info(&buf, 0, buf.getNumSamples());
        meter.getNextAudioBlock(info);

        const float peak = blockPeak(buf);
        require(peak > amplitude * lowGain * 2.0F,
                "post-gain floor must NOT be attenuated by a low master gain (regression guard)");
        require(peak > threshold, "delivered floor must clear the silence threshold");
        require(peak <= amplitude * 1.2F, "delivered floor must stay bounded near the dither amplitude");

        float ml = 0.0F;
        float mr = 0.0F;
        meter.consumePeaks(ml, mr);
        require(juce::jmax(ml, mr) <= threshold,
                "UI meter must exclude the keep-alive floor (silent program reads ~silent)");
    }

    {
        // Real program at a low master gain: content passes through at gain,
        // the floor stays off, and the meter reflects the post-gain program.
        silverdaw::OutputKeepAlive ka;
        ka.setPlaying(true);
        ConstantSource toneSource(0.5F);
        silverdaw::MeteringSource meter(toneSource, ka);
        meter.setTargetGain(lowGain);
        meter.prepareToPlay(1024, 48000.0);

        juce::AudioBuffer<float> buf(2, 1024);
        juce::AudioSourceChannelInfo info(&buf, 0, buf.getNumSamples());
        meter.getNextAudioBlock(info);

        const float expected = 0.5F * lowGain; // 0.125
        requireNear(blockPeak(buf), expected, 1.0e-4,
                    "real content must pass through at the master gain, uncoloured by the floor");

        float ml = 0.0F;
        float mr = 0.0F;
        meter.consumePeaks(ml, mr);
        requireNear(juce::jmax(ml, mr), expected, 1.0e-4,
                    "UI meter must reflect the post-gain program peak");
    }
}

} // namespace

void addAudioEngineTests(std::vector<TestCase>& tests)
{
    tests.push_back({"AudioEngine setPreviewWarp survives rapid concurrent calls", testAudioEngineSetPreviewWarpUnderRapidCalls});
    tests.push_back({"AudioEngine primeTracksForPlayback is safe and bounded", testAudioEnginePrimeTracksForPlaybackIsSafeAndBounded});
    tests.push_back({"OutputKeepAlive floor is post-gain and transport-gated", testOutputKeepAliveFloorIsPostGainAndGated});
}

} // namespace silverdaw::tests
