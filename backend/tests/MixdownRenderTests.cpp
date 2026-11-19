// Characterization tests for the offline mixdown render worker
// (MixdownRender.cpp::runMixdownJob). These lock the rendered audio output for
// representative paths so the ongoing domain-split refactors (writer-factory
// dedup, normalize pass-2 extraction) can be proven behaviour-neutral. Dither
// is forced OFF so the 16-bit output is fully deterministic run-to-run.

#include "BridgeServer.h"
#include "DecodedCache.h"
#include "Log.h"
#include "MixdownEngine.h"
#include "MixdownRender.h"
#include "ProjectState.h"
#include "TestRegistry.h"
#include "TrackExport.h"

#include <atomic>
#include <cmath>
#include <iostream>
#include <juce_audio_formats/juce_audio_formats.h>

namespace silverdaw::tests
{
namespace
{

// Author a deterministic stereo sine WAV so the render has real, non-silent
// content to decode and sum through the full per-clip source graph.
juce::File writeSineWav(const juce::File& dir, const juce::String& name,
                        double seconds, double sampleRate, double freqHz, float amplitude)
{
    auto file = dir.getChildFile(name);
    juce::WavAudioFormat format;
    std::unique_ptr<juce::OutputStream> stream(file.createOutputStream());
    require(stream != nullptr, "sine wav output stream should open");
    const auto writerOptions = juce::AudioFormatWriterOptions{}
                                   .withSampleRate(sampleRate)
                                   .withNumChannels(2)
                                   .withBitsPerSample(16);
    std::unique_ptr<juce::AudioFormatWriter> writer(format.createWriterFor(stream, writerOptions));
    require(writer != nullptr, "sine wav writer should create");
    // The writer took ownership of the stream on success.

    const int numSamples = juce::jmax(1, static_cast<int>(seconds * sampleRate));
    juce::AudioBuffer<float> buffer(2, numSamples);
    for (int i = 0; i < numSamples; ++i)
    {
        const auto s = amplitude * std::sin(2.0 * juce::MathConstants<double>::pi
                                             * freqHz * static_cast<double>(i) / sampleRate);
        buffer.setSample(0, i, static_cast<float>(s));
        buffer.setSample(1, i, static_cast<float>(s));
    }
    writer->writeFromAudioSampleBuffer(buffer, 0, numSamples);
    writer.reset();
    return file;
}

// Decoded fingerprint of a rendered file: enough to catch any change to the
// summing / resample / quantisation path without depending on container bytes.
struct RenderFingerprint
{
    juce::int64 frames{0};
    int channels{0};
    double sampleRate{0.0};
    double peak{0.0};
    double sumAbs{0.0};
};

RenderFingerprint fingerprint(const juce::File& file)
{
    juce::AudioFormatManager fm;
    fm.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(fm.createReaderFor(file));
    require(reader != nullptr, "rendered file should be decodable");

    RenderFingerprint fp;
    fp.frames = reader->lengthInSamples;
    fp.channels = static_cast<int>(reader->numChannels);
    fp.sampleRate = reader->sampleRate;

    const int block = 4096;
    juce::AudioBuffer<float> buf(juce::jmax(1, fp.channels), block);
    juce::int64 pos = 0;
    while (pos < fp.frames)
    {
        const int chunk = static_cast<int>(std::min<juce::int64>(block, fp.frames - pos));
        buf.clear(0, chunk);
        reader->read(&buf, 0, chunk, pos, true, true);
        for (int ch = 0; ch < fp.channels; ++ch)
        {
            const auto* d = buf.getReadPointer(ch);
            for (int i = 0; i < chunk; ++i)
            {
                const double a = std::abs(static_cast<double>(d[i]));
                fp.peak = juce::jmax(fp.peak, a);
                fp.sumAbs += a;
            }
        }
        pos += chunk;
    }
    return fp;
}

// Build a single-track, single-clip project pointing at a real WAV and render
// it through runMixdownJob (synchronous; clientless BridgeServer => broadcasts
// are no-ops). Returns the decoded fingerprint of the produced file.
RenderFingerprint renderOnce(const juce::File& sourceWav, const juce::File& outFile, MixdownOptions::Format format,
                             int bitDepth, MixdownOptions::LoudnessMode loudness, int bitrateKbps = 192)
{
    ProjectState state;
    require(state.addTrack("t1"), "addTrack should succeed");
    require(state.addLibraryItem("lib1", sourceWav.getFullPathName(), sourceWav.getFileName(),
                                 1000.0, 44100, 2),
            "addLibraryItem should succeed");
    require(state.addClip("t1", "c1", "lib1", 0.0, 1000.0), "addClip should succeed");

    auto snapshot = snapshotProjectForMixdown(state);
    require(!snapshot.tracks.empty() && !snapshot.tracks[0].clips.empty(),
            "snapshot should carry the authored track + clip");

    MixdownOptions options;
    options.outputFile = outFile;
    options.outputSampleRate = 44100;
    options.format = format;
    options.bitDepth = bitDepth;
    options.bitrateKbps = bitrateKbps;
    options.dither = false; // determinism
    options.tailSeconds = 0.0;
    options.loudnessMode = loudness;
    options.lengthMs = 1000.0;

    BridgeServer bridge("", nullptr);
    std::atomic<bool> cancel{false};
    std::atomic<bool> busy{false};
    runMixdownJob(std::move(snapshot), std::move(options), bridge, cancel, busy);

    require(!busy.load(), "busy flag should be cleared after the render completes");
    if (!outFile.existsAsFile())
    {
        juce::String present;
        for (const auto& f : outFile.getParentDirectory().findChildFiles(
                 juce::File::findFiles, false))
            present << f.getFileName() << " ";
        throw std::runtime_error(std::string("render produced no output file; dir has: ")
                                 + present.toStdString());
    }
    RenderFingerprint fp;
    if (format == MixdownOptions::Format::Mp3)
    {
        DecodedCache cache;
        juce::AudioFormatManager noFallbackFormats;
        const auto decoded = cache.ensureDecoded(outFile, noFallbackFormats);
        require(decoded.existsAsFile(), "the bundled LAME decoder must decode the MP3 without a JUCE fallback");
        fp = fingerprint(decoded);
        require(decoded.deleteFile(), "the test's decoded cache entry should be removed");
    }
    else
    {
        fp = fingerprint(outFile);
    }
    std::cout << "    [fingerprint] " << outFile.getFileName().toStdString()
              << " frames=" << fp.frames << " ch=" << fp.channels
              << " sr=" << fp.sampleRate << " peak=" << fp.peak
              << " sumAbs=" << fp.sumAbs << '\n';
    return fp;
}

void testMp3ExportRoundTripsThroughBundledDecoder()
{
    const auto dir = makeTempDir("mixdown-mp3");
    const auto src = writeSineWav(dir, "source.wav", 1.0, 44100.0, 440.0, 0.5F);
    for (const int bitrate : {128, 192, 320})
    {
        const auto out = dir.getChildFile("out-" + juce::String(bitrate) + ".mp3");
        const auto fp =
            renderOnce(src, out, MixdownOptions::Format::Mp3, 16, MixdownOptions::LoudnessMode::Off, bitrate);
        require(fp.channels == 2, "MP3 round-trip preserves stereo");
        requireNear(fp.sampleRate, 44100.0, 1.0, "MP3 round-trip preserves sample rate");
        require(fp.frames == 45056, "MP3 round-trip preserves the rendered length after gapless trimming");
        require(fp.peak > 0.4 && fp.peak < 0.55, "MP3 output retains the input signal level");
    }
    dir.deleteRecursively();
}

void testMp3DecoderReplacesSupersededCache()
{
    const auto dir = makeTempDir("mp3-cache-migration");
    const auto src = writeSineWav(dir, "source.wav", 1.0, 44100.0, 440.0, 0.5F);
    const auto mp3 = dir.getChildFile("out.mp3");
    renderOnce(src, mp3, MixdownOptions::Format::Mp3, 16, MixdownOptions::LoudnessMode::Off);

    DecodedCache cache;
    const auto oldKey = mp3.getFullPathName() + "|" + juce::String(mp3.getLastModificationTime().toMilliseconds()) +
                        "|" + juce::String(mp3.getSize()) + "|g3";
    const auto oldName = juce::String::toHexString(static_cast<juce::int64>(oldKey.hashCode64())) + ".wav";
    const auto oldCache = cache.getCacheFilePath(mp3).getSiblingFile(oldName);
    require(src.copyFileTo(oldCache), "the previous decoder's cache entry should be staged");

    juce::AudioFormatManager noFallbackFormats;
    const auto decoded = cache.ensureDecoded(mp3, noFallbackFormats);
    require(decoded.existsAsFile(), "the replacement decoder should populate the cache");
    const auto fp = fingerprint(decoded);
    const bool migrated = decoded != oldCache && !oldCache.existsAsFile();
    decoded.deleteFile();
    oldCache.deleteFile();
    dir.deleteRecursively();
    require(migrated, "the previous decoder's cache must be replaced, not reused");
    require(fp.frames == 45056, "the replacement cache must contain the complete MP3 decode");
}

// ── Tests ────────────────────────────────────────────────────────────────────

void testWav16RenderIsDeterministicAndCorrect()
{
    auto dir = makeTempDir("mixdown-wav16");
    const auto src = writeSineWav(dir, "src.wav", 1.0, 44100.0, 440.0, 0.5F);
    const auto out1 = dir.getChildFile("out1.wav");
    const auto out2 = dir.getChildFile("out2.wav");

    const auto a = renderOnce(src, out1, MixdownOptions::Format::Wav, 16,
                              MixdownOptions::LoudnessMode::Off);
    const auto b = renderOnce(src, out2, MixdownOptions::Format::Wav, 16,
                              MixdownOptions::LoudnessMode::Off);

    // Structural + golden expectations: 1000 ms (+ short fixed FX-tail) of a
    // 0.5-peak sine @ 44.1 kHz stereo. The exact fingerprint is captured so the
    // render-path refactors (writer-factory dedup, pass-2 extraction) are proven
    // behaviour-neutral after the canonical default clip-edge de-click fade.
    require(a.channels == 2, "output is stereo");
    requireNear(a.sampleRate, 44100.0, 1.0, "output sample rate is 44.1 kHz");
    require(a.frames == 45056, "output frame count matches the captured golden length");
    requireNear(a.peak, 0.5, 1.0e-4, "output peak matches the 0.5 input sine");
    requireNear(a.sumAbs, 28055.8, 2.0, "output sumAbs matches the captured golden fingerprint");

    // Dither off => two independent renders must be bit-identical.
    require(a.frames == b.frames, "deterministic: frame count stable across renders");
    requireNear(a.peak, b.peak, 1.0e-9, "deterministic: peak stable across renders");
    requireNear(a.sumAbs, b.sumAbs, 1.0e-6, "deterministic: sumAbs stable across renders");

    dir.deleteRecursively();
}

void testFlac16RenderRoundTrips()
{
    auto dir = makeTempDir("mixdown-flac16");
    const auto src = writeSineWav(dir, "src.wav", 1.0, 44100.0, 220.0, 0.5F);
    const auto out = dir.getChildFile("out.flac");

    const auto fp = renderOnce(src, out, MixdownOptions::Format::Flac, 16,
                               MixdownOptions::LoudnessMode::Off);

    require(fp.channels == 2, "FLAC output is stereo");
    require(fp.frames >= 44000, "FLAC output length ~= 1000 ms");
    require(fp.peak > 0.45 && fp.peak < 0.55, "FLAC output peak tracks the input sine");

    dir.deleteRecursively();
}

void testNormalizePass2ProducesLouderOutput()
{
    auto dir = makeTempDir("mixdown-normalize");
    silverdaw::log::initialise(dir.getFullPathName());
    // Quiet source so Normalize must apply substantial positive gain in pass 2.
    const auto src = writeSineWav(dir, "src.wav", 1.0, 44100.0, 330.0, 0.05F);
    const auto outOff = dir.getChildFile("off.wav");
    const auto outNorm = dir.getChildFile("norm.wav");

    const auto off = renderOnce(src, outOff, MixdownOptions::Format::Wav, 16,
                                MixdownOptions::LoudnessMode::Off);
    RenderFingerprint norm{};
    try
    {
        norm = renderOnce(src, outNorm, MixdownOptions::Format::Wav, 16,
                          MixdownOptions::LoudnessMode::Normalize);
    }
    catch (const std::exception& ex)
    {
        juce::String logTail;
        const auto logFile = dir.getChildFile("backend.log");
        if (logFile.existsAsFile())
            for (const auto& line : juce::StringArray::fromLines(logFile.loadFileAsString()))
                if (line.contains("mixdown")) logTail << line << "\n";
        silverdaw::log::shutdown();
        throw std::runtime_error(std::string(ex.what()) + " | mixdown log:\n" + logTail.toStdString());
    }
    silverdaw::log::shutdown();

    require(norm.frames >= 44000, "normalized output length ~= 1000 ms");
    // Pass 2 applied make-up gain, so the normalized peak must exceed the raw
    // 0.05 source peak (and the Off render's peak).
    require(norm.peak > off.peak + 0.05, "normalize pass-2 raises level vs Off render");
    require(norm.peak <= 1.0, "normalized peak stays within full scale");

    dir.deleteRecursively();
}

void testIndividualTrackExport()
{
    const auto dir = makeTempDir("track-export");
    juce::ScopeGuard cleanup{[&] { dir.deleteRecursively(); }};
    const auto src = writeSineWav(dir, "source.wav", 1.0, 44100, 440.0, 0.5F);
    ProjectState state;
    for (const auto* id : {"late", "warped", "empty"})
        require(state.addTrack(id), "add fixture track");
    state.setTrackName("late", "Lead");
    state.setTrackName("warped", "lead");
    state.setTrackName("empty", "CON.txt");
    state.setTrackMuted("late", true);
    state.setTrackSoloed("warped", true);
    state.setTrackGain("late", 0.5F);
    state.setMasterVolume(0.0F);
    require(state.addLibraryItem("lib", src.getFullPathName(), "source", 1000, 44100, 2), "add source");
    require(state.addClip("late", "a", "lib", 250, 125, 100), "add delayed slice");
    require(state.addClip("warped", "b", "lib", 0, 500), "add final clip");
    state.setClipWarp("b", true, juce::String("tonal"), 0.5, false, 2, {}, {});
    state.setProjectDelay("1/8", 0.3F, 0.5F, 1.0F);
    auto snapshot = snapshotProjectForMixdown(state, 0, 1, 0, 1, 1, SnapshotScope::IndividualTracks);
    require(snapshot.tracks.size() == 3, "include muted and empty tracks");
    snapshot.tracks.front().automation = {
        {"delaySend", {{0, 1.0F}, {1000, 1.0F}}}, {"pan", {{0, -1.0F}, {1000, -1.0F}}}};
    MixdownOptions options;
    options.bitDepth = 24;
    options.outputSampleRate = 48000;
    options.tailSeconds = 0.25;
    options.lengthMs = computeLastClipEndMs(snapshot);
    std::atomic<bool> cancel{false};
    const auto exportDir = dir.getChildFile("export");
    const TrackExportProgress tick = [](double, const char*, int, int, const juce::String&) {};
    const auto dry = renderTrackBatch(snapshot, exportDir, options, false, tick, cancel);
    const auto wet = renderTrackBatch(snapshot, exportDir, options, true, tick, cancel);
    require(!dry.failure && !wet.failure, "wet and dry exports should succeed");
    require(dry.folder != wet.folder && dry.folder.getFileName().matchesWildcard("????-??-??_??-??-??*", false),
            "successive batches never replace one another");
    for (const auto& batch : {dry.folder, wet.folder})
    {
        for (const auto* name : {"Lead.wav", "lead (2).wav", "_CON.txt.wav"})
        {
            const auto fp = fingerprint(batch.getChildFile(name));
            require(fp.frames == 60000 && fp.channels == 2 && fp.sampleRate == 48000,
                    "every WAV spans the stretched final clip and shared tail at the chosen rate");
            if (juce::String(name).startsWith("_")) require(fp.peak == 0, "empty track is silence");
            else require(fp.peak > 0.1, "mute, solo and master volume do not silence track renders");
        }
    }

    juce::AudioFormatManager fm;
    fm.registerBasicFormats();
    const auto readLead = [&](const juce::File& folder) {
        std::unique_ptr<juce::AudioFormatReader> reader(fm.createReaderFor(folder.getChildFile("Lead.wav")));
        juce::AudioBuffer<float> audio(2, 60000);
        require(reader && reader->bitsPerSample == 24 && reader->read(&audio, 0, 60000, 0, true, true),
                "read exported 24-bit track");
        return audio;
    };
    const auto dryAudio = readLead(dry.folder);
    require(dryAudio.getMagnitude(0, 0, 11950) < 1.0e-5F &&
            dryAudio.getMagnitude(0, 12000, 1000) > 0.15F, "late slice keeps its initial silence");
    require(dryAudio.getMagnitude(1, 12000, 5000) < 1.0e-4F, "pan automation survives dry export");
    require(dryAudio.getMagnitude(0, 20000, 30000) < 1.0e-5F &&
            readLead(wet.folder).getMagnitude(0, 20000, 30000) > 0.01F,
            "automated delay return is printed only when track effects are included");
    require(state.getTrackMuted("late") && state.getTrackSoloed("warped"), "export leaves audition state alone");

    auto solo = snapshot;
    solo.tracks.resize(1);
    solo.masterGain = 1.0F;
    solo.mixGlueAmount = 0.0F;
    solo.safetyLimiterEnabled = false;
    options.outputFile = dir.getChildFile("Lead.wav");
    options.lengthMs = 1000;
    const auto reference = renderOfflineFile(solo, options, [](double, const char*) {}, cancel);
    require(!reference.failure, "render the isolated pre-master reference");
    const auto referenceAudio = readLead(dir);
    auto difference = readLead(wet.folder);
    for (int ch = 0; ch < 2; ++ch)
    {
        difference.addFrom(ch, 0, referenceAudio, ch, 0, 40000, -1.0F);
        require(difference.getMagnitude(ch, 0, 40000) < 1.0e-5F,
                "isolated track and solo reference match including the automated return");
    }

    const auto cancelled = renderTrackBatch(snapshot, exportDir, options, true,
        [&](double, const char*, int index, int, const juce::String&) { if (index == 2) cancel.store(true); },
        cancel);
    require(cancelled.failure == MixdownFailureCode::Cancelled, "can cancel after writing the first track");
    cancel.store(false);
    snapshot.tracks[1].clips.front().filePath = dir.getChildFile("missing.wav").getFullPathName();
    const auto failed = renderTrackBatch(std::move(snapshot), exportDir, options, true, tick, cancel);
    require(failed.failure == MixdownFailureCode::Decode, "broken source fails the batch");
    require(exportDir.getNumberOfChildFiles(juce::File::findFilesAndDirectories) == 2,
            "no partial folders or WAVs survive failure or cancellation");
}

} // namespace

void addMixdownRenderTests(std::vector<TestCase>& tests)
{
    tests.push_back({"Individual track export renders aligned wet and dry WAV batches", testIndividualTrackExport});
    tests.push_back({"MP3 export round-trips through the bundled decoder at each bitrate",
                     testMp3ExportRoundTripsThroughBundledDecoder});
    tests.push_back({"MP3 decoder replaces a superseded cache entry", testMp3DecoderReplacesSupersededCache});
    tests.push_back({"Mixdown WAV-16 render is deterministic and matches the input sine",
                     testWav16RenderIsDeterministicAndCorrect});
    tests.push_back({"Mixdown FLAC-16 render decodes back to the expected program",
                     testFlac16RenderRoundTrips});
    tests.push_back({"Mixdown Normalize pass-2 raises output level over Off",
                     testNormalizePass2ProducesLouderOutput});
}

} // namespace silverdaw::tests
