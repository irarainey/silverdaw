// AudioEngine: thread-safety of preview warp under rapid calls, bounded/safe
// playback priming, and the post-gain transport-gated output keep-alive floor.

#include "TestRegistry.h"

#include "AudioEngine.h"
#include "AudioConstants.h"
#include "BridgeAuth.h"
#include "DecodedCache.h"
#include "EdgeFadeSnapshot.h"
#include "LoudnessAnalyzer.h"
#include "Leveler.h"
#include "MixdownEngine.h"
#include "OutputDeviceClassifier.h"
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
    std::unique_ptr<juce::OutputStream> stream(file.createOutputStream());
    require(stream != nullptr, "wav output stream should open");
    const auto writerOptions = juce::AudioFormatWriterOptions{}
                                   .withSampleRate(sampleRate)
                                   .withNumChannels(2)
                                   .withBitsPerSample(16);
    std::unique_ptr<juce::AudioFormatWriter> writer(format.createWriterFor(stream, writerOptions));
    require(writer != nullptr, "wav writer should create");
    // The writer took ownership of the stream on success.

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
            (void) engine.isPreviewFinished();
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

    // Mute one clip while the master gate is closed, then prime again: this exercises the
    // play-start gain-settle (the throwaway one-sample pump that clears a stale transport
    // gain ramp so a freshly-muted track cannot leak a one-block fade-out on the next play).
    // It must remain crash-free and bounded with the gain change in flight.
    require(engine.setClipGain("c1", 0.0F), "muting a clip while gated should succeed");
    const auto tMute = juce::Time::getMillisecondCounterHiRes();
    engine.primeTracksForPlayback(silverdaw::kPlayPrimeBudgetMs);
    require(juce::Time::getMillisecondCounterHiRes() - tMute < 3000.0,
            "priming after a mute must stay bounded");
    engine.play();
    engine.stop();

    require(engine.removeClip("c1"), "removeClip c1 should succeed");
    require(engine.removeClip("c2"), "removeClip c2 should succeed");

    engine.shutdown();
    dir.deleteRecursively();
}

void testOutputKeepAliveFloorIsPostGainAndGated()
{
    const float threshold = static_cast<float>(silverdaw::kKeepAliveSilenceThreshold);
    const float impulsePeak = static_cast<float>(silverdaw::kKeepAliveImpulse);

    auto blockPeak = [](const juce::AudioBuffer<float>& buf) {
        float p = 0.0F;
        for (int ch = 0; ch < buf.getNumChannels(); ++ch)
            p = juce::jmax(p, buf.getMagnitude(ch, 0, buf.getNumSamples()));
        return p;
    };

    auto countNonZero = [](const juce::AudioBuffer<float>& buf) {
        int c = 0;
        for (int i = 0; i < buf.getNumSamples(); ++i)
            if (buf.getSample(0, i) != 0.0F)
                ++c;
        return c;
    };

    // ── Direct OutputKeepAlive checks ──
    {
        silverdaw::OutputKeepAlive ka;
        ka.prepare(48000.0); // tune the fluctuate impulse intervals for the sample rate
        require(! ka.shouldRun(), "default gate must be closed (no project, not playing)");

        juce::AudioBuffer<float> buf(2, 1024);
        const int n = buf.getNumSamples();
        buf.clear();
        require(! ka.maybeApplyFloor(buf, 0, n, 0.0F), "gate closed must not inject impulses");
        require(blockPeak(buf) == 0.0F, "gate closed must leave true digital silence");

        // A loaded project NOW opens the gate: the inaudible, broadband fluctuate stream holds the
        // DAC awake so the first play is instant (this is the fix — the impulse is broadband so it
        // reaches the DAC's auto-mute detector, and sits near the format noise floor so it is
        // inaudible).
        ka.setContentLoaded(true);
        require(ka.shouldRun(), "a loaded project must open the keep-alive gate");

        // The stream injects sparse minimal-amplitude impulses immediately (no ramp): each block
        // carries at least one, and the peak sits at the inaudible impulse amplitude — BELOW the
        // silence threshold (the whole point: it must not register as programme audio).
        float peak = 0.0F;
        for (int b = 0; b < 4; ++b)
        {
            buf.clear();
            require(ka.maybeApplyFloor(buf, 0, n, 0.0F),
                    "loaded + silent: each block must carry a keep-alive impulse");
            peak = juce::jmax(peak, blockPeak(buf));
        }
        requireNear(peak, impulsePeak, 1.0e-6,
                    "the keep-alive impulse must sit at the configured inaudible amplitude");
        require(peak < threshold,
                "the keep-alive impulse must stay below the silence threshold (inaudible, "
                "non-programme)");

        // The impulses alternate sign across the stream (DC-free), so they cannot build a DC
        // offset that would thump a speaker. Accumulate over several blocks since impulses are
        // sparse (~1 per block at 50 Hz / 48 kHz).
        float mn = 0.0F;
        float mx = 0.0F;
        for (int b = 0; b < 8; ++b)
        {
            buf.clear();
            ka.maybeApplyFloor(buf, 0, n, 0.0F);
            for (int i = 0; i < n; ++i)
            {
                const float s = buf.getSample(0, i);
                mn = juce::jmin(mn, s);
                mx = juce::jmax(mx, s);
            }
        }
        require(mx > 0.0F && mn < 0.0F,
                "the keep-alive impulses must alternate sign (DC-free), not bias the output");

        // Real content (program peak above the threshold) is not coloured: the keep-alive stops
        // writing entirely under sustained content (no fade — it simply emits nothing).
        buf.clear();
        require(! ka.maybeApplyFloor(buf, 0, n, 0.5F),
                "the keep-alive must inject nothing under sustained content");
        require(blockPeak(buf) == 0.0F, "real content must pass through uncoloured by the keep-alive");

        // Playing opens the gate independently of a loaded project.
        ka.setContentLoaded(false);
        require(! ka.shouldRun(), "no project and not playing must close the gate");
        ka.setPlaying(true);
        require(ka.shouldRun(), "playing must open the gate");
        buf.clear();
        require(ka.maybeApplyFloor(buf, 0, n, 0.0F), "playing + silent block must inject impulses");

        // Closing the gate returns immediately to true digital silence (no decaying tail).
        ka.setPlaying(false);
        require(! ka.shouldRun(), "stopped with no project must close the gate");
        buf.clear();
        require(! ka.maybeApplyFloor(buf, 0, n, 0.0F), "closed gate must stop injecting impulses");
        require(blockPeak(buf) == 0.0F, "closed gate must leave true digital silence");

        // An open output device opens the gate too — even with no project loaded and not
        // playing — so a freshly-opened or reconnected endpoint is held awake from the moment
        // the stream starts. This closes the cold-start digital-silence window that would
        // otherwise let a sleep-prone USB DAC auto-mute and clip the first play.
        ka.setDeviceActive(true);
        require(ka.shouldRun(), "an open output device must open the keep-alive gate");
        buf.clear();
        require(ka.maybeApplyFloor(buf, 0, n, 0.0F),
                "device-active + silent block must inject keep-alive impulses");

        ka.setDeviceActive(false);
        require(! ka.shouldRun(),
                "closing the device with no project and not playing must close the gate");

        // ── Keep-awake policy gate: only sleep-prone (USB) endpoints run the stream ──
        ka.setDeviceActive(true);
        require(ka.shouldRun(), "device-active must open the gate when keep-awake is enabled");
        ka.setKeepAwakeEnabled(false);
        require(! ka.shouldRun(),
                "keep-awake disabled (non-USB endpoint) must keep the gate closed");
        buf.clear();
        require(! ka.maybeApplyFloor(buf, 0, n, 0.0F),
                "keep-awake disabled must inject nothing (true digital silence on non-USB devices)");
        ka.setKeepAwakeEnabled(true);
        require(ka.shouldRun(), "re-enabling keep-awake on an open device must reopen the gate");

        // ── One-time cold-wake handshake ──
        ka.clearNeedsWake();
        require(! ka.needsWake(), "wake flag starts cleared");
        ka.markDeviceStarted();
        require(ka.needsWake(), "a device (re)start must arm the one-time wake");
        ka.prepare(48000.0); // a device/sample-rate (re)start re-arms the wake
        require(ka.needsWake(), "prepare() (device start) must arm the one-time wake");
        ka.clearNeedsWake();
        require(! ka.needsWake(), "consuming the wake clears the one-shot flag (later plays skip it)");

        // ── Armed cold-wake stream is DENSER than maintenance, at the SAME amplitude ──
        ka.setContentLoaded(true);
        buf.clear();
        ka.maybeApplyFloor(buf, 0, n, 0.0F);
        const int maintNonZero = countNonZero(buf);
        const float maintPeak = blockPeak(buf);

        ka.arm();
        require(ka.isArmed(), "arm() must engage the denser cold-wake stream");
        buf.clear();
        ka.maybeApplyFloor(buf, 0, n, 0.0F);
        const int armedNonZero = countNonZero(buf);
        const float armedPeak = blockPeak(buf);

        require(armedNonZero > maintNonZero,
                "the armed cold-wake stream must emit MORE impulses per block than maintenance");
        requireNear(armedPeak, maintPeak, 1.0e-6,
                    "the cold-wake stream must use the same inaudible amplitude (denser, not louder)");
        require(armedPeak < threshold, "the cold-wake stream must stay below the silence threshold");
        ka.disarm();
        require(! ka.isArmed(), "disarm() must drop back to the sparse maintenance stream");
        buf.clear();
        ka.maybeApplyFloor(buf, 0, n, 0.0F);
        require(countNonZero(buf) < armedNonZero,
                "after disarm the stream must settle back to the sparse maintenance rate");
    }

    // ── Pure keep-awake policy: only USB (and unclassifiable) endpoints are kept awake ──
    {
        require(silverdaw::busPrefersKeepAwake(silverdaw::OutputBus::usb),
                "USB endpoints (the sleep-prone offenders) must be kept awake");
        require(silverdaw::busPrefersKeepAwake(silverdaw::OutputBus::unknown),
                "unknown endpoints must be kept awake (fail-safe: never drop a beat)");
        require(! silverdaw::busPrefersKeepAwake(silverdaw::OutputBus::onboard),
                "onboard endpoints must not incur the keep-awake stream or wake lead-in");
        require(! silverdaw::busPrefersKeepAwake(silverdaw::OutputBus::bluetooth),
                "Bluetooth endpoints must not be kept awake by the fluctuate stream");
        require(! silverdaw::busPrefersKeepAwake(silverdaw::OutputBus::other),
                "other endpoints must not be kept awake");
    }

    // ── MeteringSource integration: the stream survives a low master gain ──
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
        // Silent program + loaded project + low master gain. The stream is injected POST-gain,
        // so a low master volume must NOT attenuate it (regression guard).
        silverdaw::OutputKeepAlive ka;
        ka.setContentLoaded(true);
        ConstantSource silentSource(0.0F);
        silverdaw::MeteringSource meter(silentSource, ka);
        meter.setTargetGain(lowGain);
        meter.prepareToPlay(1024, 48000.0);

        juce::AudioBuffer<float> buf(2, 1024);
        juce::AudioSourceChannelInfo info(&buf, 0, buf.getNumSamples());
        meter.getNextAudioBlock(info);

        const float peak = blockPeak(buf);
        requireNear(peak, impulsePeak, 1.0e-6,
                    "post-gain impulse must NOT be attenuated by a low master gain (regression guard)");

        float ml = 0.0F;
        float mr = 0.0F;
        meter.consumePeaks(ml, mr);
        require(juce::jmax(ml, mr) <= threshold,
                "UI meter must exclude the keep-alive stream (silent program reads ~silent)");
    }

    {
        // Real program at a low master gain: content passes through at gain, the stream stays
        // off, and the meter reflects the post-gain program.
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
                    "real content must pass through at the master gain, uncoloured by the stream");

        float ml = 0.0F;
        float mr = 0.0F;
        meter.consumePeaks(ml, mr);
        requireNear(juce::jmax(ml, mr), expected, 1.0e-4,
                    "UI meter must reflect the post-gain program peak");
    }
}

// MasterClockSource must publish block timing to atomics for off-thread logging
// (the audio thread no longer builds strings or touches the file logger).
void testMasterClockPublishesAudioPerfOffThread()
{
    constexpr int kBlock = 256;
    constexpr double kRate = 48000.0;
    silverdaw::OutputKeepAlive keepAlive;
    ConstantSource child(0.1F);
    silverdaw::MasterClockSource master(child, keepAlive);
    master.prepareToPlay(kBlock, kRate);

    juce::AudioBuffer<float> buf(2, kBlock);
    juce::AudioSourceChannelInfo info(&buf, 0, kBlock);

    // Idle: the keep-alive silence path still publishes timing but must not advance.
    for (int i = 0; i < 10; ++i)
    {
        buf.clear();
        master.getNextAudioBlock(info);
    }
    auto snap = master.drainAudioPerf();
    require(snap.callbackCount == 10, "callback count reflects pumped blocks");
    require(snap.numSamples == kBlock, "published block size matches");
    requireNear(snap.sampleRate, kRate, 1.0e-6, "published sample rate matches");
    require(std::isfinite(snap.maxElapsedMs) && snap.maxElapsedMs >= 0.0,
            "published elapsed time is finite and non-negative");
    require(! snap.playing, "idle snapshot reports not playing");
    require(snap.positionSamples == 0, "idle keep-alive path does not advance the transport");

    // Draining resets the worst-case accumulator.
    auto reset = master.drainAudioPerf();
    require(reset.maxElapsedMs == 0.0, "drain resets the worst-case elapsed accumulator");

    // Playing: the transport advances by one block and the counter keeps rising.
    keepAlive.setPlaying(true);
    buf.clear();
    master.getNextAudioBlock(info);
    auto playSnap = master.drainAudioPerf();
    require(playSnap.playing, "playing snapshot reports playing");
    require(playSnap.positionSamples == kBlock, "playing advances the transport by the block size");
    require(playSnap.callbackCount == 11, "callback count keeps incrementing");

    // The first played block after the idle→playing transition is declicked: a short fade-in
    // ramps the constant child (0.1) up from ~0 so the gate opening does not step and click.
    require(std::abs(buf.getSample(0, 0)) < 0.02F,
            "the first sample of the first played block must be ramped down by the declick fade-in");
    float firstBlockPeak = 0.0F;
    for (int i = 0; i < kBlock; ++i)
        firstBlockPeak = juce::jmax(firstBlockPeak, std::abs(buf.getSample(0, i)));
    require(firstBlockPeak > 0.05F,
            "the declick fade-in must reach (near) full level within the first block");
    require(std::abs(buf.getSample(0, kBlock - 1) - 0.1F) < 1.0e-4F,
            "the tail of the first block (past the short ramp) must be at full child level");

    // A subsequent block (still playing, no transition) is full level end-to-end — the ramp is
    // one-shot per play-start, not per block.
    buf.clear();
    master.getNextAudioBlock(info);
    require(std::abs(buf.getSample(0, 0) - 0.1F) < 1.0e-4F,
            "later blocks must not be re-ramped (declick is one-shot per play-start)");

    master.releaseResources();
}

// Issue 1: a source that is already a WAV must NOT be transcoded into the central
// decoded cache — playback should use the original file directly. This removes the
// wasteful (and, for float stems, lossy) duplicate while leaving non-WAV sources to
// decode as before.
void testDecodedCacheSkipsWavSources()
{
    const auto dir = makeTempDir("decoded-cache-wav");
    DecodedCache cache;
    juce::AudioFormatManager formatManager;
    formatManager.registerBasicFormats();

    const auto wav = writeTestWav(dir, "loop.wav", 0.25);
    const auto resolved = cache.ensureDecoded(wav, formatManager);

    requireEqual(resolved.getFullPathName(), wav.getFullPathName(),
                 "an already-WAV source resolves to itself (no decoded duplicate)");
    require(! cache.getCacheFilePath(wav).existsAsFile(),
            "no central cache file is written for a WAV source");

    dir.deleteRecursively();
}

} // namespace

void addAudioEngineTests(std::vector<TestCase>& tests)
{
    tests.push_back({"AudioEngine setPreviewWarp survives rapid concurrent calls", testAudioEngineSetPreviewWarpUnderRapidCalls});
    tests.push_back({"AudioEngine primeTracksForPlayback is safe and bounded", testAudioEnginePrimeTracksForPlaybackIsSafeAndBounded});
    tests.push_back({"OutputKeepAlive floor is post-gain and transport-gated", testOutputKeepAliveFloorIsPostGainAndGated});
    tests.push_back({"MasterClockSource publishes audio-thread timing for off-thread logging", testMasterClockPublishesAudioPerfOffThread});
    tests.push_back({"DecodedCache skips transcoding WAV sources", testDecodedCacheSkipsWavSources});
}

} // namespace silverdaw::tests
