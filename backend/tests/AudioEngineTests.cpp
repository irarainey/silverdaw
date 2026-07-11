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
#include "Metronome.h"
#include "PayloadHelpers.h"
#include "PeaksCache.h"
#include "PreviewMetronomeSource.h"
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

void testAudioEngineAddClipConsumesPreOpenedReader()
{
    const auto dir = makeTempDir("preopen-reader");
    silverdaw::AudioEngine engine;
    engine.initialise({}, {}, nullptr); // registers WAV/etc. formats for the reader

    const auto wav = writeTestWav(dir, "pre.wav", 1.0);

    // createReaderForClip opens the file the same way addClip(File) would; project load calls it
    // in parallel across clips and hands the readers to the reader-accepting addClip overload.
    auto reader = engine.createReaderForClip(wav);
    require(reader != nullptr, "createReaderForClip should open a valid WAV");

    require(engine.addClip("t1", "cpre", std::move(reader), wav, 0.0),
            "addClip should build the chain from a pre-opened reader");
    require(engine.removeClip("cpre"),
            "the pre-opened clip should be attached (and thus removable)");

    // A missing file yields a null reader; the reader-accepting overload must fail cleanly.
    auto missing = engine.createReaderForClip(dir.getChildFile("does-not-exist.wav"));
    require(missing == nullptr, "createReaderForClip returns null for a missing file");
    juce::String err;
    require(!engine.addClip("t1", "cnull", nullptr, dir.getChildFile("does-not-exist.wav"), 0.0, 0.0,
                            0.0, 1.0F, &err),
            "addClip with a null reader must fail rather than attach a silent clip");
    require(err.isNotEmpty(), "a null-reader addClip failure should report an error");
}

void testAudioEngineReclaimsRetiredPlaybackSnapshots()
{
    const auto dir = makeTempDir("retired-playback-snapshots");
    silverdaw::AudioEngine engine;
    engine.initialiseGraph();

    const auto wav = writeTestWav(dir, "effects.wav", 1.0);
    require(engine.addClip("t1", "c1", wav, 0.0),
            "snapshot reclamation test clip should load");

    require(engine.setClipBrake("c1", 0.2), "first clip brake should apply");
    require(engine.setClipBrake("c1", 0.3), "replacement clip brake should apply");
    require(engine.setClipBackspin("c1", 0.2), "clip backspin should replace the brake");
    require(engine.setClipBackspin("c1", 0.3), "replacement clip backspin should apply");
    require(engine.retiredPlaybackSnapshotCount() > 0,
            "replaced clip effects should remain retired until a quiescent boundary");

    engine.pause();
    require(engine.retiredPlaybackSnapshotCount() == 0,
            "pause should reclaim every retired clip and automation snapshot");

    require(engine.setClipBrake("c1", 0.2), "clip brake should apply after pause");
    require(engine.setClipBackspin("c1", 0.2), "clip backspin should replace it after pause");
    require(engine.retiredPlaybackSnapshotCount() > 0,
            "new replacements should enter retirement after pause");

    engine.stop();
    require(engine.retiredPlaybackSnapshotCount() == 0,
            "stop should reclaim every retired clip and automation snapshot");

    juce::String previewError;
    require(engine.loadPreview(wav, 0.0, 500.0, &previewError),
            "snapshot reclamation preview should load");
    require(engine.setPreviewBrake(0.2), "first preview brake should apply");
    require(engine.setPreviewBrake(0.3), "replacement preview brake should apply");
    require(engine.setPreviewBackspin(0.2), "preview backspin should replace the brake");
    require(engine.setPreviewBackspin(0.3), "replacement preview backspin should apply");
    require(engine.retiredPlaybackSnapshotCount() > 0,
            "preview effect replacements should enter retirement");

    engine.unloadPreview();
    require(engine.retiredPlaybackSnapshotCount() == 0,
            "preview teardown should release current and retired effect snapshots");

    require(engine.removeClip("c1"), "snapshot reclamation test clip should unload");
    engine.shutdown();
    dir.deleteRecursively();
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

// Regression guard: moving a clip while STOPPED must not leak the clip's pre-move audio on the next
// play. The per-track read-ahead lives in an owned juce::BufferingAudioSource, and changing the
// OffsetSource offset upstream does not invalidate that cache; the old far-then-near seek was a
// message-thread race that usually left the stale range intact (burst of old-position audio on
// play). rebuildTrackPrefetch now recreates the BufferingAudioSource when stopped — the only
// reliable flush. Audio content can't be asserted offline (no device on CI), so this exercises the
// stopped move -> commit (synchronous recreate) -> prime -> play path and asserts it stays
// crash-free and bounded, guarding the new setSource(nullptr)+recreate branch.
void testStoppedClipMoveRecreatesReadAheadSafely()
{
    const auto dir = makeTempDir("clip-move-recreate");
    silverdaw::AudioEngine engine;
    engine.initialise({}, {}, nullptr);

    const auto wav = writeTestWav(dir, "tone.wav", 2.0);
    require(engine.addClip("t1", "c1", wav, 0.0), "addClip should build the owned-buffer chain");
    engine.primeTracksForPlayback(silverdaw::kLoadPrimeBudgetMs);

    // Move the clip far right while stopped, then commit — commitClipOffset calls rebuildTrackPrefetch
    // synchronously, which (stopped) tears down and recreates the read-ahead buffer.
    require(engine.setClipOffsetMs("c1", 30000.0), "moving a stopped clip should succeed");
    const auto t0 = juce::Time::getMillisecondCounterHiRes();
    require(engine.commitClipOffset("c1"), "committing the move should rebuild the prefetch");
    require(juce::Time::getMillisecondCounterHiRes() - t0 < 3000.0,
            "the stopped-move buffer recreate must stay bounded (never hang)");

    // Play from the start through the freshly recreated chain: must prime and gate without crashing.
    engine.setPositionMs(0.0);
    const bool ready = engine.primeTracksForPlayback(silverdaw::kPlayPrimeBudgetMs);
    engine.play();
    require(engine.isPlaying() == ready, "play() must open the gate iff priming reports ready");
    engine.stop();

    require(engine.removeClip("c1"), "removeClip c1 should succeed");
    engine.shutdown();
    dir.deleteRecursively();
}

void testOutputKeepAliveFloorIsPostGainAndGated()
{
    const float threshold = static_cast<float>(silverdaw::kKeepAliveSilenceThreshold);
    const float ditherPeak = static_cast<float>(silverdaw::kKeepAliveDitherPeak);

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
        ka.prepare(48000.0); // reseed the dither PRNG for the device start
        require(! ka.shouldRun(), "default gate must be closed (no project, not playing)");

        juce::AudioBuffer<float> buf(2, 1024);
        const int n = buf.getNumSamples();
        buf.clear();
        require(! ka.maybeApplyFloor(buf, 0, n, 0.0F), "gate closed must not inject dither");
        require(blockPeak(buf) == 0.0F, "gate closed must leave true digital silence");

        // A loaded project NOW opens the gate: the continuous, inaudible dither holds the DAC
        // awake. Continuous noise keeps every sample non-zero with real energy the DAC's auto-mute
        // detector registers, while sitting at the format noise floor so it is inaudible.
        ka.setKeepAwakeEnabled(true); // off by default; this test exercises the enabled path
        ka.setContentLoaded(true);
        require(ka.shouldRun(), "a loaded project must open the keep-alive gate");

        // A fresh device start (prepare()) arms a one-time wake burst to rouse a *cold* amp: the
        // first silent blocks carry elevated — but still low — broadband energy that decays into the
        // holding dither. Verify the burst is present and bounded, then drain it before checking the
        // steady-state holding contract below.
        const float wakeBurstPeak = static_cast<float>(silverdaw::kWakeBurstPeak);
        buf.clear();
        require(ka.maybeApplyFloor(buf, 0, n, 0.0F), "armed wake burst must inject on the first block");
        const float firstBurstPeak = blockPeak(buf);
        require(firstBurstPeak > ditherPeak,
                "the wake burst must start above the holding-dither floor (to rouse a cold amp)");
        require(firstBurstPeak <= wakeBurstPeak,
                "the wake burst must not exceed its configured peak");
        const int burstBlocks = (48000 * silverdaw::kWakeBurstMs) / 1000 / n + 2;
        for (int b = 0; b < burstBlocks; ++b)
        {
            buf.clear();
            ka.maybeApplyFloor(buf, 0, n, 0.0F);
        }

        // The stream injects continuous dither immediately (no ramp): every block is filled, the
        // peak stays at/under the configured inaudible amplitude, BELOW the silence threshold.
        float peak = 0.0F;
        for (int b = 0; b < 4; ++b)
        {
            buf.clear();
            require(ka.maybeApplyFloor(buf, 0, n, 0.0F),
                    "loaded + silent: each block must carry the keep-alive dither");
            peak = juce::jmax(peak, blockPeak(buf));
            require(countNonZero(buf) > (n * 9) / 10,
                    "the dither must be continuous — essentially every sample non-zero");
        }
        require(peak > 0.0F && peak <= ditherPeak,
                "the keep-alive dither must stay at/under the configured inaudible amplitude");
        require(peak < threshold,
                "the keep-alive dither must stay below the silence threshold (inaudible, "
                "non-programme)");

        // The dither is zero-mean (DC-free): accumulate over several blocks; the mean sits ~0.
        double sum = 0.0;
        int count = 0;
        float mn = 0.0F;
        float mx = 0.0F;
        for (int b = 0; b < 8; ++b)
        {
            buf.clear();
            ka.maybeApplyFloor(buf, 0, n, 0.0F);
            for (int i = 0; i < n; ++i)
            {
                const float s = buf.getSample(0, i);
                sum += s;
                ++count;
                mn = juce::jmin(mn, s);
                mx = juce::jmax(mx, s);
            }
        }
        require(mx > 0.0F && mn < 0.0F,
                "the keep-alive dither must swing both signs (AC), not bias the output");
        require(std::abs(sum / juce::jmax(1, count)) < ditherPeak * 0.2,
                "the keep-alive dither must be DC-free (mean ~ 0)");

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
        require(ka.maybeApplyFloor(buf, 0, n, 0.0F), "playing + silent block must inject dither");

        // Closing the gate returns immediately to true digital silence (no decaying tail).
        ka.setPlaying(false);
        require(! ka.shouldRun(), "stopped with no project must close the gate");
        buf.clear();
        require(! ka.maybeApplyFloor(buf, 0, n, 0.0F), "closed gate must stop injecting dither");
        require(blockPeak(buf) == 0.0F, "closed gate must leave true digital silence");

        // An open output device opens the gate too — even with no project loaded and not
        // playing — so a freshly-opened or reconnected endpoint is held awake from the moment
        // the stream starts. This closes the cold-start digital-silence window that would
        // otherwise let a sleep-prone USB DAC auto-mute and clip the first play.
        ka.setDeviceActive(true);
        require(ka.shouldRun(), "an open output device must open the keep-alive gate");
        buf.clear();
        require(ka.maybeApplyFloor(buf, 0, n, 0.0F),
                "device-active + silent block must inject the keep-alive dither");

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
    }

    // ── MeteringSource integration: the tone survives a low master gain ──
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
        // Silent program + loaded project + low master gain. The dither is injected POST-gain,
        // so a low master volume must NOT attenuate it (regression guard).
        silverdaw::OutputKeepAlive ka;
        ka.setKeepAwakeEnabled(true); // off by default; exercise the enabled path
        ka.setContentLoaded(true);
        ConstantSource silentSource(0.0F);
        silverdaw::Metronome metro;
        silverdaw::MasterClockSource clock(silentSource, ka);
        silverdaw::MeteringSource meter(silentSource, ka, clock, metro);
        meter.setTargetGain(lowGain);
        meter.prepareToPlay(1024, 48000.0);

        juce::AudioBuffer<float> buf(2, 1024);
        juce::AudioSourceChannelInfo info(&buf, 0, buf.getNumSamples());
        // prepareToPlay arms the one-time wake burst; drain it so this guard measures the settled,
        // post-gain holding dither (not the louder opening burst).
        const int burstBlocks = (48000 * silverdaw::kWakeBurstMs) / 1000 / buf.getNumSamples() + 3;
        for (int b = 0; b < burstBlocks; ++b)
        {
            buf.clear();
            meter.getNextAudioBlock(info);
        }
        buf.clear();
        meter.getNextAudioBlock(info);

        const float peak = blockPeak(buf);
        require(peak > ditherPeak * 0.5F && peak <= ditherPeak,
                "post-gain dither must NOT be attenuated by a low master gain (regression guard)");

        float ml = 0.0F;
        float mr = 0.0F;
        meter.consumePeaks(ml, mr);
        require(juce::jmax(ml, mr) <= threshold,
                "UI meter must exclude the keep-alive dither (silent program reads ~silent)");
    }

    {
        // Real program at a low master gain: content passes through at gain, the dither stays
        // off, and the meter reflects the post-gain program.
        silverdaw::OutputKeepAlive ka;
        ka.setPlaying(true);
        ConstantSource toneSource(0.5F);
        silverdaw::Metronome metro;
        silverdaw::MasterClockSource clock(toneSource, ka);
        silverdaw::MeteringSource meter(toneSource, ka, clock, metro);
        meter.setTargetGain(lowGain);
        meter.prepareToPlay(1024, 48000.0);

        juce::AudioBuffer<float> buf(2, 1024);
        juce::AudioSourceChannelInfo info(&buf, 0, buf.getNumSamples());
        meter.getNextAudioBlock(info);

        const float expected = 0.5F * lowGain; // 0.125
        requireNear(blockPeak(buf), expected, 1.0e-4,
                    "real content must pass through at the master gain, uncoloured by the tone");

        float ml = 0.0F;
        float mr = 0.0F;
        meter.consumePeaks(ml, mr);
        requireNear(juce::jmax(ml, mr), expected, 1.0e-4,
                    "UI meter must reflect the post-gain program peak");
    }
}

// A cold sleep-prone endpoint needs more than the inaudible holding dither to un-mute its amp.
// Every device (re)start arms a brief, decaying wake burst: verify it starts well above the holding
// floor, never exceeds its configured peak, decays back to the floor, and re-arms on the next start.
void testOutputKeepAliveWakeBurstRousesColdDeviceThenSettles()
{
    const float ditherPeak = static_cast<float>(silverdaw::kKeepAliveDitherPeak);
    const float wakeBurstPeak = static_cast<float>(silverdaw::kWakeBurstPeak);
    require(wakeBurstPeak > ditherPeak, "the wake burst must be louder than the holding dither");

    auto blockPeak = [](const juce::AudioBuffer<float>& buf) {
        float p = 0.0F;
        for (int ch = 0; ch < buf.getNumChannels(); ++ch)
            p = juce::jmax(p, buf.getMagnitude(ch, 0, buf.getNumSamples()));
        return p;
    };

    constexpr int n = 256;
    constexpr double sr = 48000.0;
    silverdaw::OutputKeepAlive ka;
    ka.setKeepAwakeEnabled(true);  // keep-awake is off by default; this test exercises the on path
    ka.setContentLoaded(true); // gate open (loaded project)
    ka.prepare(sr);            // device start — arms the wake burst

    juce::AudioBuffer<float> buf(2, n);

    // First block after a fresh device start carries the elevated wake burst.
    buf.clear();
    require(ka.maybeApplyFloor(buf, 0, n, 0.0F), "armed + silent: first block must inject the burst");
    const float firstPeak = blockPeak(buf);
    require(firstPeak > ditherPeak * 2.0F,
            "the wake burst must clearly exceed the holding floor on the first block (rouse a cold amp)");
    require(firstPeak <= wakeBurstPeak, "the wake burst must never exceed its configured peak");

    // Drain past the burst length; the floor must settle back to the inaudible holding dither.
    const int burstSamples = static_cast<int>(sr * (silverdaw::kWakeBurstMs / 1000.0));
    const int drainBlocks = burstSamples / n + 4;
    for (int b = 0; b < drainBlocks; ++b)
    {
        buf.clear();
        ka.maybeApplyFloor(buf, 0, n, 0.0F);
    }
    float settledPeak = 0.0F;
    for (int b = 0; b < 8; ++b)
    {
        buf.clear();
        ka.maybeApplyFloor(buf, 0, n, 0.0F);
        settledPeak = juce::jmax(settledPeak, blockPeak(buf));
    }
    require(settledPeak > 0.0F && settledPeak <= ditherPeak,
            "after the burst, the keep-alive must settle to the inaudible holding dither");
    require(firstPeak > settledPeak,
            "the burst must decay: the opening block must be louder than the settled floor");

    // A subsequent device (re)start (e.g. the DAC is unplugged and replugged) must re-arm the burst.
    ka.prepare(sr);
    buf.clear();
    ka.maybeApplyFloor(buf, 0, n, 0.0F);
    require(blockPeak(buf) > ditherPeak * 2.0F, "a later device restart must re-arm the wake burst");
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

    // The first played block must be at full level immediately — the MasterClockSource does not
    // apply a declick fade-in, so the opening transient is perfectly preserved.
    require(std::abs(buf.getSample(0, 0) - 0.1F) < 1.0e-4F,
            "the first sample of the first played block must be at full level (no declick fade)");

    buf.clear();
    master.getNextAudioBlock(info);
    require(std::abs(buf.getSample(0, 0) - 0.1F) < 1.0e-4F,
            "subsequent blocks remain at full level");

    master.releaseResources();
}

// Reproduces the "missing first beat" symptom deterministically: after the device has been
// pulling silent idle blocks, the very first PLAYING block through the MasterClockSource ->
// MeteringSource chain must already be at full master gain. If the master gain smoother starts
// from ~0 at play-start, the opening transient is swallowed (the bug under investigation).
void testMasterGainIsSettledAtPlayStart()
{
    constexpr int kBlock = 480;
    constexpr double kRate = 48000.0;
    constexpr float kGain = 0.3F;
    constexpr float kSource = 0.5F;

    struct FullSource : juce::AudioSource
    {
        void prepareToPlay(int, double) override {}
        void releaseResources() override {}
        void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override
        {
            for (int ch = 0; ch < info.buffer->getNumChannels(); ++ch)
                juce::FloatVectorOperations::fill(
                    info.buffer->getWritePointer(ch, info.startSample), kSource, info.numSamples);
        }
    };

    silverdaw::OutputKeepAlive keepAlive;
    FullSource src;
    silverdaw::MasterClockSource master(src, keepAlive);
    silverdaw::Metronome metro;
    silverdaw::MeteringSource meter(master, keepAlive, master, metro);
    meter.setTargetGain(kGain);
    meter.prepareToPlay(kBlock, kRate);

    juce::AudioBuffer<float> buf(2, kBlock);
    juce::AudioSourceChannelInfo info(&buf, 0, kBlock);

    // Idle: the device pulls continuously. MasterClockSource clears to silence; MeteringSource
    // still applies gain (to silence) and ticks its gain smoother toward the target.
    for (int i = 0; i < 20; ++i)
    {
        buf.clear();
        meter.getNextAudioBlock(info);
    }

    // Play: the very first played block must already be at the full master gain
    // (kSource * kGain = 0.15), not ramped up from ~0.
    keepAlive.setPlaying(true);
    buf.clear();
    meter.getNextAudioBlock(info);
    requireNear(std::abs(buf.getSample(0, 0)), kSource * kGain, 1.0e-3,
                "the first played block must already be at full master gain (no play-start fade)");

    meter.releaseResources();
}

// The cold-DAC fix: on a sleep-prone (USB) endpoint, the start of each play runs a short, audio-
// thread wake pre-roll — the master emits silence (which MeteringSource fills with the wake burst)
// WITHOUT advancing the transport — so the amp is roused before the downbeat and the opening beat is
// never swallowed. Non-sleep-prone endpoints skip the pre-roll and play from the first block.
void testMasterClockWakePrerollRousesUsbThenPlays()
{
    constexpr int kBlock = 480;
    constexpr double kRate = 48000.0;
    constexpr float kSource = 0.5F;

    struct FullSource : juce::AudioSource
    {
        void prepareToPlay(int, double) override {}
        void releaseResources() override {}
        void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override
        {
            for (int ch = 0; ch < info.buffer->getNumChannels(); ++ch)
                juce::FloatVectorOperations::fill(
                    info.buffer->getWritePointer(ch, info.startSample), kSource, info.numSamples);
        }
    };

    const int prerollSamples = static_cast<int>(kRate * (silverdaw::kWakePrerollMs / 1000.0));
    const int prerollBlocks = (prerollSamples + kBlock - 1) / kBlock;

    // ── Keep-awake ON: a wake pre-roll precedes programme without advancing time ──
    {
        silverdaw::OutputKeepAlive ka;
        ka.setKeepAwakeEnabled(true); // explicit per-device toggle (off by default)
        FullSource src;
        silverdaw::MasterClockSource master(src, ka);
        master.prepareToPlay(kBlock, kRate);
        juce::AudioBuffer<float> buf(2, kBlock);
        juce::AudioSourceChannelInfo info(&buf, 0, kBlock);

        master.setPlaying(true);
        // First block is pre-roll: the master source emits silence and the transport stays put.
        buf.clear();
        buf.setSample(0, 0, 1.0F); // poison; must be cleared by the pre-roll
        master.getNextAudioBlock(info);
        require(buf.getSample(0, 0) == 0.0F, "wake pre-roll must emit silence from the master source");
        require(master.getPositionSamples() == 0, "wake pre-roll must not advance the transport");

        for (int b = 1; b < prerollBlocks; ++b)
        {
            buf.clear();
            master.getNextAudioBlock(info);
        }
        require(master.getPositionSamples() == 0,
                "the transport must stay put for the whole wake pre-roll");

        // After the pre-roll, programme plays at full level and the transport advances.
        buf.clear();
        master.getNextAudioBlock(info);
        requireNear(std::abs(buf.getSample(0, 0)), kSource, 1.0e-4,
                    "programme must play at full level immediately after the wake pre-roll");
        require(master.getPositionSamples() == kBlock,
                "the transport must advance once programme starts");
        master.releaseResources();
    }

    // ── Non-USB (keep-awake off): no pre-roll, programme from the very first block ──
    {
        silverdaw::OutputKeepAlive ka;
        ka.setKeepAwakeEnabled(false);
        FullSource src;
        silverdaw::MasterClockSource master(src, ka);
        master.prepareToPlay(kBlock, kRate);
        juce::AudioBuffer<float> buf(2, kBlock);
        juce::AudioSourceChannelInfo info(&buf, 0, kBlock);

        master.setPlaying(true);
        buf.clear();
        master.getNextAudioBlock(info);
        requireNear(std::abs(buf.getSample(0, 0)), kSource, 1.0e-4,
                    "non-sleep-prone endpoints must play instantly (no wake pre-roll)");
        require(master.getPositionSamples() == kBlock,
                "non-sleep-prone endpoints advance the transport from the first block");
        master.releaseResources();
    }
}

// The Clip Editor / preview window must follow the same cold-DAC rules as the main transport: on a
// sleep-prone (USB) endpoint the first block of each preview play is a silent wake pre-roll (the
// PreviewMetronomeSource wrapper holds the transport WITHOUT pulling it, so OutputKeepAlive can emit
// its wake burst before the first audible sample); non-sleep-prone endpoints play from the first
// block. Mirrors testMasterClockWakePrerollRousesUsbThenPlays for the preview path.
void testPreviewWakePrerollRousesUsbThenPlays()
{
    constexpr int kBlock = 480;
    constexpr double kRate = 48000.0;
    const auto dir = makeTempDir("preview-wake-preroll");
    const auto wav = writeTestWav(dir, "tone.wav", 2.0, kRate);

    juce::AudioFormatManager fm;
    fm.registerBasicFormats();

    const int prerollSamples = static_cast<int>(kRate * (silverdaw::kWakePrerollMs / 1000.0));
    const int prerollBlocks = (prerollSamples + kBlock - 1) / kBlock;

    auto peakOf = [](const juce::AudioBuffer<float>& b) {
        float p = 0.0F;
        for (int ch = 0; ch < b.getNumChannels(); ++ch)
            p = juce::jmax(p, b.getMagnitude(ch, 0, b.getNumSamples()));
        return p;
    };

    // ── Keep-awake ON: a silent pre-roll precedes programme, transport held put ──
    {
        auto* reader = fm.createReaderFor(wav);
        require(reader != nullptr, "reader should open the test wav");
        juce::AudioFormatReaderSource readerSource(reader, true);
        juce::AudioTransportSource transport;
        transport.setSource(&readerSource, 0, nullptr, kRate, 2);
        transport.setGain(1.0F);

        silverdaw::OutputKeepAlive ka;
        ka.setKeepAwakeEnabled(true); // explicit per-device toggle (off by default)
        silverdaw::PreviewMetronomeSource preview(transport, ka);
        preview.prepareToPlay(kBlock, kRate);

        transport.setPosition(0.5); // mid-tone, away from the zero-crossing start
        const double startPos = transport.getCurrentPosition();
        transport.start();

        juce::AudioBuffer<float> buf(2, kBlock);
        juce::AudioSourceChannelInfo info(&buf, 0, kBlock);

        for (int b = 0; b < prerollBlocks; ++b)
        {
            buf.clear();
            buf.setSample(0, 0, 1.0F); // poison; the pre-roll must clear it
            preview.getNextAudioBlock(info);
            require(peakOf(buf) == 0.0F, "preview wake pre-roll must emit silence");
        }
        requireNear(transport.getCurrentPosition(), startPos, 1.0e-3,
                    "preview wake pre-roll must not advance the transport");

        // After the pre-roll, programme plays and the transport advances.
        buf.clear();
        preview.getNextAudioBlock(info);
        require(peakOf(buf) > 0.05F, "programme must play right after the preview wake pre-roll");
        require(transport.getCurrentPosition() > startPos,
                "the transport must advance once the preview programme starts");
        preview.releaseResources();
    }

    // ── Keep-awake ON but endpoint warm: no pre-roll, programme from the first block ──
    {
        auto* reader = fm.createReaderFor(wav);
        require(reader != nullptr, "reader should open the test wav");
        juce::AudioFormatReaderSource readerSource(reader, true);
        juce::AudioTransportSource transport;
        transport.setSource(&readerSource, 0, nullptr, kRate, 2);
        transport.setGain(1.0F);

        silverdaw::OutputKeepAlive ka;
        ka.setKeepAwakeEnabled(true);
        ka.setDeviceActive(true);
        ka.prepare(kRate);
        // Real programme just played (above-threshold peak) opens the warm window, so a fresh play
        // must NOT emit a wake burst (which would be an audible start-of-play hiss on a warm amp).
        juce::AudioBuffer<float> loud(2, kBlock);
        loud.clear();
        ka.maybeApplyFloor(loud, 0, kBlock, 0.5F);
        require(ka.isWarm(), "above-threshold programme must mark the endpoint warm");

        silverdaw::PreviewMetronomeSource preview(transport, ka);
        preview.prepareToPlay(kBlock, kRate);
        transport.setPosition(0.5);
        transport.start();

        juce::AudioBuffer<float> buf(2, kBlock);
        juce::AudioSourceChannelInfo info(&buf, 0, kBlock);
        buf.clear();
        preview.getNextAudioBlock(info);
        require(peakOf(buf) > 0.05F,
                "a warm endpoint must play the preview instantly (no silent wake pre-roll)");
        require(transport.getCurrentPosition() > 0.5,
                "a warm endpoint advances the preview transport from the first block");
        preview.releaseResources();
    }

    // ── Non-USB (keep-awake off): programme from the very first block, no pre-roll ──
    {
        auto* reader = fm.createReaderFor(wav);
        require(reader != nullptr, "reader should open the test wav");
        juce::AudioFormatReaderSource readerSource(reader, true);
        juce::AudioTransportSource transport;
        transport.setSource(&readerSource, 0, nullptr, kRate, 2);
        transport.setGain(1.0F);

        silverdaw::OutputKeepAlive ka;
        ka.setKeepAwakeEnabled(false);
        silverdaw::PreviewMetronomeSource preview(transport, ka);
        preview.prepareToPlay(kBlock, kRate);

        transport.setPosition(0.5);
        transport.start();

        juce::AudioBuffer<float> buf(2, kBlock);
        juce::AudioSourceChannelInfo info(&buf, 0, kBlock);
        buf.clear();
        preview.getNextAudioBlock(info);
        require(peakOf(buf) > 0.05F, "non-sleep-prone endpoints must play the preview instantly");
        require(transport.getCurrentPosition() > 0.5,
                "non-sleep-prone endpoints advance the preview transport from the first block");
        preview.releaseResources();
    }

    dir.deleteRecursively();
}

// Reproduces the prime->play path at the JUCE buffering/transport level to check whether the
// FIRST played block delivers programme audio or silence. Mirrors primeTracksForPlayback:
// setPosition -> start -> settle-pump 1 sample -> re-seek -> start -> wait for read-ahead, then
// pulls block 0 and asserts it carries the source's audio (the "missing first beat" check).
void testPrimedTransportDeliversFirstBlock()
{
    const auto dir = makeTempDir("prime-first-block");
    const double sr = 44100.0;
    const auto wav = writeTestWav(dir, "tone.wav", 2.0, sr);

    juce::AudioFormatManager fm;
    fm.registerBasicFormats();
    auto* reader = fm.createReaderFor(wav);
    require(reader != nullptr, "reader should open the test wav");

    juce::TimeSliceThread readAhead("test-read-ahead");
    readAhead.startThread();
    {
        juce::AudioFormatReaderSource readerSource(reader, true);
        juce::BufferingAudioSource buffering(&readerSource, readAhead, false, 8192, 2);
        juce::AudioTransportSource transport;
        transport.setSource(&buffering, 0, nullptr, sr, 2);
        transport.setGain(1.0F);
        transport.prepareToPlay(480, sr);

        constexpr double seekSeconds = 0.5; // mid-tone, far from the zero-crossing start
        // Mirror primeTracksForPlayback exactly.
        transport.setPosition(seekSeconds);
        transport.start();
        juce::AudioBuffer<float> scratch(2, 480);
        juce::AudioSourceChannelInfo settleInfo(&scratch, 0, 1);
        scratch.clear(0, 1);
        transport.getNextAudioBlock(settleInfo);
        transport.setPosition(seekSeconds);
        transport.start();

        // Wait for the read-ahead to cover the seek position (bounded).
        const double deadline = juce::Time::getMillisecondCounterHiRes() + 2000.0;
        juce::AudioBuffer<float> waitBuf(2, 4096);
        juce::AudioSourceChannelInfo waitInfo(&waitBuf, 0, 4096);
        while (! buffering.waitForNextAudioBlockReady(waitInfo, 50) &&
               juce::Time::getMillisecondCounterHiRes() < deadline)
        {
        }

        // Pull the first played block and measure its peak.
        juce::AudioBuffer<float> block(2, 480);
        block.clear();
        juce::AudioSourceChannelInfo blockInfo(&block, 0, 480);
        transport.getNextAudioBlock(blockInfo);
        float peak = 0.0F;
        for (int ch = 0; ch < 2; ++ch)
            peak = juce::jmax(peak, block.getMagnitude(ch, 0, 480));

        require(peak > 0.05F,
                "the first primed transport block must carry the source audio (~0.1), not silence — "
                "if this fails, the prime/buffering path drops the opening block");

        transport.releaseResources();
    }
    readAhead.stopThread(2000);
    dir.deleteRecursively();
}

// Narrows the "missing first beat" to the live bus path: pulls the primed transport through a
// juce::MixerAudioSource (as BusGraph's per-track innerMixer does), in the engine's order
// (prepare mixer -> addInputSource -> prime -> pull). If the FIRST mixer block is silent while a
// directly-pulled transport is full, the mixer/attach order is dropping the opening block.
void testPrimedMixerDeliversFirstBlock()
{
    const auto dir = makeTempDir("prime-mixer-first-block");
    const double sr = 44100.0;
    const auto wav = writeTestWav(dir, "tone.wav", 2.0, sr);

    juce::AudioFormatManager fm;
    fm.registerBasicFormats();
    auto* reader = fm.createReaderFor(wav);
    require(reader != nullptr, "reader should open the test wav");

    juce::TimeSliceThread readAhead("test-read-ahead-mix");
    readAhead.startThread();
    {
        juce::AudioFormatReaderSource readerSource(reader, true);
        juce::BufferingAudioSource buffering(&readerSource, readAhead, false, 8192, 2);
        juce::AudioTransportSource transport;
        transport.setSource(&buffering, 0, nullptr, sr, 2);
        transport.setGain(1.0F);

        // Engine order: the per-track MixerAudioSource is prepared, then the transport is attached
        // (which re-prepares it), and only afterwards does play-time priming run.
        juce::MixerAudioSource mixer;
        mixer.prepareToPlay(480, sr);
        mixer.addInputSource(&transport, false);

        constexpr double seekSeconds = 0.5;
        transport.setPosition(seekSeconds);
        transport.start();
        juce::AudioBuffer<float> scratch(2, 480);
        juce::AudioSourceChannelInfo settleInfo(&scratch, 0, 1);
        scratch.clear(0, 1);
        transport.getNextAudioBlock(settleInfo);
        transport.setPosition(seekSeconds);
        transport.start();

        const double deadline = juce::Time::getMillisecondCounterHiRes() + 2000.0;
        juce::AudioBuffer<float> waitBuf(2, 4096);
        juce::AudioSourceChannelInfo waitInfo(&waitBuf, 0, 4096);
        while (! buffering.waitForNextAudioBlockReady(waitInfo, 50) &&
               juce::Time::getMillisecondCounterHiRes() < deadline)
        {
        }

        // Pull the first played block THROUGH THE MIXER (as the bus graph would).
        juce::AudioBuffer<float> block(2, 480);
        block.clear();
        juce::AudioSourceChannelInfo blockInfo(&block, 0, 480);
        mixer.getNextAudioBlock(blockInfo);
        float peak = 0.0F;
        for (int ch = 0; ch < 2; ++ch)
            peak = juce::jmax(peak, block.getMagnitude(ch, 0, 480));

        require(peak > 0.05F,
                "the first block pulled THROUGH THE MIXER must carry the source audio (~0.1), not "
                "silence — if this fails, the mixer/attach drops the opening block (the live bug)");

        mixer.removeAllInputs();
        mixer.releaseResources();
        transport.releaseResources();
    }
    readAhead.stopThread(2000);
    dir.deleteRecursively();
}

// Final isolation: reproduce the EXACT engine source chain reader -> OffsetSource -> buffering ->
// transport and pull the first block after a deep mid-clip seek (no silent-leading region, like the
// reported case: playhead ~31 ms inside the clip). If block 0 is silent here, OffsetSource drops
// the opening block after a discontinuous seek.
void testPrimedOffsetSourceDeliversFirstBlock()
{
    const auto dir = makeTempDir("prime-offset-first-block");
    const double sr = 44100.0;
    const auto wav = writeTestWav(dir, "tone.wav", 3.0, sr);

    juce::AudioFormatManager fm;
    fm.registerBasicFormats();
    auto* reader = fm.createReaderFor(wav);
    require(reader != nullptr, "reader should open the test wav");

    juce::TimeSliceThread readAhead("test-read-ahead-offset");
    readAhead.startThread();
    {
        juce::AudioFormatReaderSource readerSource(reader, true);
        silverdaw::OffsetSource offset(&readerSource);
        offset.setOffsetSamples(0);                                   // clip at timeline 0
        offset.setInSourceSamples(0);
        offset.setClipDurationSamples(static_cast<juce::int64>(3.0 * sr)); // whole file

        juce::BufferingAudioSource buffering(&offset, readAhead, false, 8192, 2);
        juce::AudioTransportSource transport;
        transport.setSource(&buffering, 0, nullptr, sr, 2);
        transport.setGain(1.0F);
        transport.prepareToPlay(480, sr);

        constexpr double seekSeconds = 1.5; // deep inside the clip, no silent-leading
        transport.setPosition(seekSeconds);
        transport.start();
        juce::AudioBuffer<float> scratch(2, 480);
        juce::AudioSourceChannelInfo settleInfo(&scratch, 0, 1);
        scratch.clear(0, 1);
        transport.getNextAudioBlock(settleInfo);
        transport.setPosition(seekSeconds);
        transport.start();

        const double deadline = juce::Time::getMillisecondCounterHiRes() + 2000.0;
        juce::AudioBuffer<float> waitBuf(2, 4096);
        juce::AudioSourceChannelInfo waitInfo(&waitBuf, 0, 4096);
        while (! buffering.waitForNextAudioBlockReady(waitInfo, 50) &&
               juce::Time::getMillisecondCounterHiRes() < deadline)
        {
        }

        juce::AudioBuffer<float> block(2, 480);
        block.clear();
        juce::AudioSourceChannelInfo blockInfo(&block, 0, 480);
        transport.getNextAudioBlock(blockInfo);
        float peak = 0.0F;
        for (int ch = 0; ch < 2; ++ch)
            peak = juce::jmax(peak, block.getMagnitude(ch, 0, 480));

        require(peak > 0.05F,
                "the first block through OffsetSource (deep mid-clip seek) must carry the source "
                "audio (~0.1), not silence — if this fails, OffsetSource drops the opening block");

        transport.releaseResources();
    }
    readAhead.stopThread(2000);
    dir.deleteRecursively();
}

// Issue 1: a source that is already a WAV must NOT be transcoded into the central
// decoded cache — playback should use the original file directly.
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

// Metronome: clicks land exactly on beat boundaries (phase-locked to absolute transport position),
// stay silent off-beat, and produce nothing when disabled or when a block "didn't advance".
void testMetronomeClicksOnBeatBoundaries()
{
    constexpr double sr = 48000.0;
    constexpr double bpm = 120.0; // beat period = 48000 * 60 / 120 = 24000 samples
    const auto beatPeriod = static_cast<juce::int64>(sr * 60.0 / bpm);

    silverdaw::Metronome metro;
    metro.prepare(sr);
    metro.setBpm(bpm);

    auto blockMagnitude = [](const juce::AudioBuffer<float>& buf) {
        return buf.getMagnitude(0, 0, buf.getNumSamples());
    };

    // Disabled: render adds nothing even across a beat boundary.
    {
        juce::AudioBuffer<float> buf(2, 512);
        buf.clear();
        metro.render(buf, 0, 512, 0, sr);
        require(blockMagnitude(buf) == 0.0F, "disabled metronome must inject nothing");
    }

    metro.setEnabled(true);

    // Beat 0 sits at transport sample 0: a block starting at 0 must contain the click.
    {
        juce::AudioBuffer<float> buf(2, 512);
        buf.clear();
        metro.render(buf, 0, 512, 0, sr);
        require(blockMagnitude(buf) > 0.05F, "a click must fire on the downbeat (transport sample 0)");
        // Both channels carry the mono click identically.
        require(std::abs(buf.getSample(0, 0) - buf.getSample(1, 0)) < 1e-6F,
                "the click is mixed equally to both channels");
    }

    // Mid-beat block with no boundary stays silent (click from beat 0 has long decayed).
    {
        juce::AudioBuffer<float> buf(2, 512);
        buf.clear();
        metro.render(buf, 0, 512, beatPeriod / 2, sr); // 12000..12512, no beat, prior click ended
        require(blockMagnitude(buf) == 0.0F, "no click off-beat");
    }

    // A block straddling the next beat boundary fires the click at the right offset.
    {
        const juce::int64 start = beatPeriod - 100; // 23900; beat at 24000 lands 100 samples in
        juce::AudioBuffer<float> buf(2, 512);
        buf.clear();
        metro.render(buf, 0, 512, start, sr);
        require(buf.getMagnitude(0, 0, 100) == 0.0F, "silence before the beat boundary in the block");
        require(buf.getMagnitude(0, 100, 412) > 0.05F, "click begins exactly on the beat boundary");
    }
}

} // namespace

void addAudioEngineTests(std::vector<TestCase>& tests)
{
    tests.push_back({"AudioEngine setPreviewWarp survives rapid concurrent calls", testAudioEngineSetPreviewWarpUnderRapidCalls});
    tests.push_back({"AudioEngine primeTracksForPlayback is safe and bounded", testAudioEnginePrimeTracksForPlaybackIsSafeAndBounded});
    tests.push_back({"Stopped clip move recreates the read-ahead buffer safely", testStoppedClipMoveRecreatesReadAheadSafely});
    tests.push_back({"AudioEngine addClip consumes a pre-opened reader (and fails cleanly on null)", testAudioEngineAddClipConsumesPreOpenedReader});
    tests.push_back({"AudioEngine reclaims retired playback snapshots", testAudioEngineReclaimsRetiredPlaybackSnapshots});
    tests.push_back({"OutputKeepAlive floor is post-gain and transport-gated", testOutputKeepAliveFloorIsPostGainAndGated});
    tests.push_back({"OutputKeepAlive wake burst rouses a cold device then settles", testOutputKeepAliveWakeBurstRousesColdDeviceThenSettles});
    tests.push_back({"MasterClockSource publishes audio-thread timing for off-thread logging", testMasterClockPublishesAudioPerfOffThread});
    tests.push_back({"Master gain is settled at play-start (no first-block fade)", testMasterGainIsSettledAtPlayStart});
    tests.push_back({"MasterClockSource wake pre-roll rouses a USB endpoint then plays", testMasterClockWakePrerollRousesUsbThenPlays});
    tests.push_back({"Preview wake pre-roll rouses a USB endpoint then plays", testPreviewWakePrerollRousesUsbThenPlays});
    tests.push_back({"Primed transport delivers the first played block", testPrimedTransportDeliversFirstBlock});
    tests.push_back({"Primed mixer delivers the first played block", testPrimedMixerDeliversFirstBlock});
    tests.push_back({"Primed OffsetSource delivers the first played block", testPrimedOffsetSourceDeliversFirstBlock});
    tests.push_back({"DecodedCache skips transcoding WAV sources", testDecodedCacheSkipsWavSources});
    tests.push_back({"Metronome clicks land on beat boundaries", testMetronomeClicksOnBeatBoundaries});
}

} // namespace silverdaw::tests
