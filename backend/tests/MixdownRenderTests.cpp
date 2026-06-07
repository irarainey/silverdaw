// Characterization tests for the offline mixdown render worker
// (MixdownRender.cpp::runMixdownJob). These lock the rendered audio output for
// representative paths so the ongoing domain-split refactors (writer-factory
// dedup, normalize pass-2 extraction) can be proven behaviour-neutral. Dither
// is forced OFF so the 16-bit output is fully deterministic run-to-run.

#include "TestRegistry.h"

#include "BridgeServer.h"
#include "Log.h"
#include "MixdownEngine.h"
#include "MixdownRender.h"
#include "ProjectState.h"

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
    std::unique_ptr<juce::FileOutputStream> stream(file.createOutputStream());
    require(stream != nullptr, "sine wav output stream should open");
    std::unique_ptr<juce::AudioFormatWriter> writer(
        format.createWriterFor(stream.get(), sampleRate, 2, 16, juce::StringPairArray(), 0));
    require(writer != nullptr, "sine wav writer should create");
    stream.release(); // writer owns the stream now

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
RenderFingerprint renderOnce(const juce::File& sourceWav,
                             const juce::File& outFile,
                             MixdownOptions::Format format,
                             int bitDepth,
                             MixdownOptions::LoudnessMode loudness)
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
    auto fp = fingerprint(outFile);
    std::cout << "    [fingerprint] " << outFile.getFileName().toStdString()
              << " frames=" << fp.frames << " ch=" << fp.channels
              << " sr=" << fp.sampleRate << " peak=" << fp.peak
              << " sumAbs=" << fp.sumAbs << '\n';
    return fp;
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
    // behaviour-neutral — any change to summing / resample / quantisation moves
    // these numbers.
    require(a.channels == 2, "output is stereo");
    requireNear(a.sampleRate, 44100.0, 1.0, "output sample rate is 44.1 kHz");
    require(a.frames == 45056, "output frame count matches the captured golden length");
    requireNear(a.peak, 0.5, 1.0e-4, "output peak matches the 0.5 input sine");
    requireNear(a.sumAbs, 28074.9, 2.0, "output sumAbs matches the captured golden fingerprint");

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

} // namespace

void addMixdownRenderTests(std::vector<TestCase>& tests)
{
    tests.push_back({"Mixdown WAV-16 render is deterministic and matches the input sine",
                     testWav16RenderIsDeterministicAndCorrect});
    tests.push_back({"Mixdown FLAC-16 render decodes back to the expected program",
                     testFlac16RenderRoundTrips});
    tests.push_back({"Mixdown Normalize pass-2 raises output level over Off",
                     testNormalizePass2ProducesLouderOutput});
}

} // namespace silverdaw::tests
