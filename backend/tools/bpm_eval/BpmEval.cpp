// Offline BPM/beat evaluation harness (dev tool, not shipped).
//
// Runs BpmDetector::analyse over a manifest of audio files with known reference
// tempos and prints an octave-aware accuracy report. This is the objective
// yardstick for tuning beat detection — the project had been relying on
// subjective "looks out" feedback, which cannot prove a change helps or
// regresses. Keep this decoupled from the unit-test suite so it can grow with
// the drum-stem / downbeat work without bloating CI.
//
// Usage:
//   SilverdawBpmEval <manifest> [--drums]
// Manifest lines: `<path>|<referenceBpm>[|<refFirstBeatSec>]`; '#'/blank ignored.
// `path` may be any format JUCE can read (wav always; mp3/flac if supported).
//
// --drums: also separate a drums-only stem (htdemucs, fast overlap, first 2 min)
//   and analyse THAT, printing a `drm` row beside the full-mix `mix` row. Requires
//   env SILVERDAW_STEM_MODEL_DIR (the htdemucs-ft dir) and onnxruntime.dll beside
//   the exe. Optional env SILVERDAW_STEM_USE_GPU=1.

#include "../../src/dsp/BpmDetector.h"
#include "../../src/stems/StemSeparator.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <memory>
#include <vector>

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

namespace
{

struct Entry
{
    juce::String path;
    double referenceBpm = 0.0;
    double referenceFirstBeatSec = std::numeric_limits<double>::quiet_NaN(); // optional phase ground truth
};

// Smallest tempo error after allowing common metrical ratios, so a clean
// half/double/triple-time detection reads as an "octave" miss rather than a
// catastrophic one. Returns the signed error at the best ratio and that ratio.
double octaveAwareError(double detected, double reference, double& outRatio)
{
    const double ratios[] = {1.0, 2.0, 0.5, 3.0, 1.0 / 3.0, 1.5, 2.0 / 3.0, 4.0 / 3.0, 3.0 / 4.0};
    double bestAbs = std::numeric_limits<double>::infinity();
    double bestSigned = detected - reference;
    double bestRatio = 1.0;
    for (double r : ratios)
    {
        const double err = detected * r - reference;
        if (std::abs(err) < bestAbs)
        {
            bestAbs = std::abs(err);
            bestSigned = err;
            bestRatio = r;
        }
    }
    outRatio = bestRatio;
    return bestSigned;
}

// Snap a tempo to the metrical octave (x0.25..x4) nearest a reference tempo in
// log space. Used so the clean drum-stem PERIOD adopts the right metrical LEVEL
// from the full mix (which gets the octave right even when its precise period is
// wrong), instead of locking to half/double time. Safe by construction: a track
// the mix already reads correctly is unchanged.
double snapOctaveToReference(double bpm, double referenceBpm)
{
    if (bpm <= 0.0 || referenceBpm <= 0.0) return bpm;
    const double mults[] = {0.25, 0.5, 1.0, 2.0, 4.0};
    double best = bpm;
    double bestDist = std::numeric_limits<double>::infinity();
    for (double m : mults)
    {
        const double cand = bpm * m;
        const double dist = std::abs(std::log(cand / referenceBpm));
        if (dist < bestDist)
        {
            bestDist = dist;
            best = cand;
        }
    }
    return best;
}

// Signed distance (seconds) from a reference downbeat to the nearest grid line of
// a rigid grid (anchorSec + n*periodSec). Magnitude near periodSec/2 means the
// grid is on the off-beat. Returns NaN if inputs are unusable.
double phaseErrorSec(double anchorSec, double periodSec, double refFirstBeatSec)
{
    if (periodSec <= 0.0 || std::isnan(refFirstBeatSec)) return std::numeric_limits<double>::quiet_NaN();
    const double n = std::round((refFirstBeatSec - anchorSec) / periodSec);
    return (anchorSec + n * periodSec) - refFirstBeatSec;
}

std::vector<Entry> parseManifest(const juce::File& file)
{
    std::vector<Entry> entries;
    juce::StringArray lines;
    file.readLines(lines);
    for (auto raw : lines)
    {
        const auto line = raw.trim();
        if (line.isEmpty() || line.startsWith("#")) continue;
        // `<path>|<referenceBpm>[|<refFirstBeatSec>]` — paths never contain '|'.
        juce::StringArray fields;
        fields.addTokens(line, "|", "");
        if (fields.size() < 2)
        {
            std::cerr << "[eval] skipping malformed line: " << line.toStdString() << '\n';
            continue;
        }
        Entry e;
        e.path = fields[0].trim();
        e.referenceBpm = fields[1].trim().getDoubleValue();
        if (fields.size() >= 3 && fields[2].trim().isNotEmpty())
            e.referenceFirstBeatSec = fields[2].trim().getDoubleValue();
        if (e.path.isEmpty() || e.referenceBpm <= 0.0)
        {
            std::cerr << "[eval] skipping malformed line: " << line.toStdString() << '\n';
            continue;
        }
        entries.push_back(e);
    }
    return entries;
}

struct Accum
{
    int analysed = 0;
    int withinHalf = 0;
    int octaveShifted = 0;
    double sumAbsErr = 0.0;
    int phaseScored = 0;
    int phaseGood = 0;
    double sumAbsPhaseBeat = 0.0;
};

void scoreRow(const char* label, const silverdaw::BpmAnalysis& a, const Entry& e, const juce::String& name,
              Accum& acc)
{
    ++acc.analysed;
    double ratio = 1.0;
    const double signedErr = octaveAwareError(a.bpm, e.referenceBpm, ratio);
    const double absErr = std::abs(signedErr);
    acc.sumAbsErr += absErr;
    if (absErr <= 0.5) ++acc.withinHalf;
    if (absErr <= 0.5 && std::abs(ratio - 1.0) > 1e-6) ++acc.octaveShifted;

    const double periodSec = a.bpm > 0.0 ? 60.0 / a.bpm : 0.0;
    const double phErr = phaseErrorSec(a.beatAnchorSec, periodSec, e.referenceFirstBeatSec);
    juce::String phaseCol = "    -      - ";
    if (!std::isnan(phErr))
    {
        const double phBeat = periodSec > 0.0 ? phErr / periodSec : 0.0;
        ++acc.phaseScored;
        acc.sumAbsPhaseBeat += std::abs(phBeat);
        if (std::abs(phBeat) <= 0.10) ++acc.phaseGood;
        char pb[64];
        std::snprintf(pb, sizeof(pb), "%+8.1f  %+.2f", phErr * 1000.0, phBeat);
        phaseCol = pb;
    }

    juce::String flags;
    if (a.variableTempo) flags += "V";
    if (a.lowConfidence) flags += "L";
    if (flags.isEmpty()) flags = "-";

    char buf[512];
    std::snprintf(buf, sizeof(buf), "  %-3s  %7.2f  %8.3f  %5.2fx  %+7.2f  %5.2f  %s  %-4s   %s", label,
                  e.referenceBpm, a.bpm, ratio, signedErr, absErr, phaseCol.toRawUTF8(), flags.toRawUTF8(),
                  name.toStdString().c_str());
    std::cout << buf << '\n';
}

void printSummary(const char* label, const Accum& acc)
{
    std::cout << "  [" << label << "] " << acc.analysed << " analysed | mean octave-aware |err| = "
              << (acc.analysed > 0 ? acc.sumAbsErr / acc.analysed : 0.0) << " BPM | within 0.5 = "
              << acc.withinHalf << "/" << acc.analysed << " (octave-shifted: " << acc.octaveShifted << ")";
    if (acc.phaseScored > 0)
        std::cout << " | phase mean|offset|=" << (acc.sumAbsPhaseBeat / acc.phaseScored) << " beat, within 0.10="
                  << acc.phaseGood << "/" << acc.phaseScored;
    std::cout << '\n';
}

// Separate a drums-only stem (fast overlap, first windowMs) to a temp WAV and
// return it. Reuses one separator instance so the ~300 MB model loads once.
juce::File separateDrums(silverdaw::StemSeparator& sep, const juce::File& src, const juce::File& modelDir,
                         const juce::File& outDir, double windowMs, bool gpu, juce::String& err)
{
    silverdaw::StemSeparationRequest req;
    req.jobId = "eval";
    req.sourceName = src.getFileNameWithoutExtension();
    req.sourceFile = src;
    req.startMs = 0.0;
    req.lengthMs = windowMs;
    req.modelDir = modelDir;
    req.outputDir = outDir;
    req.fileNameToken = juce::Uuid().toString().substring(0, 8);
    req.stems = {"drums"};
    req.overlap = 0.10; // fast preset
    req.useGpu = gpu;

    juce::File drums;
    try
    {
        const auto result = sep.separate(
            req, [](const char*, double, const char*) {},
            [&](const char* stem, const juce::File& f) {
                if (juce::String(stem) == "drums") drums = f;
            },
            [] { return false; });
        if (drums == juce::File())
            for (const auto& s : result.stems)
                if (s.stem == "drums") drums = s.file;
    }
    catch (const std::exception& ex)
    {
        err = ex.what();
        return {};
    }
    return drums;
}

} // namespace

// Print the strongest low-band (kick) onsets in [startSec, endSec] of a file, so a
// rough user-supplied region can be turned into a precise downbeat reference.
namespace
{
int runOnsets(const juce::File& f, double startSec, double endSec)
{
    juce::AudioFormatManager fm;
    fm.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(fm.createReaderFor(f));
    if (reader == nullptr || reader->sampleRate <= 0.0)
    {
        std::cerr << "[onsets] cannot read " << f.getFullPathName().toStdString() << '\n';
        return 2;
    }
    const double sr = reader->sampleRate;
    const juce::int64 want = std::min<juce::int64>(reader->lengthInSamples, (juce::int64)((endSec + 1.0) * sr));
    std::vector<float> mono((size_t)want, 0.0F);
    const int numCh = (int)reader->numChannels;
    juce::AudioBuffer<float> buf(numCh, 8192);
    juce::int64 pos = 0;
    while (pos < want)
    {
        const int n = (int)std::min<juce::int64>(8192, want - pos);
        reader->read(&buf, 0, n, pos, true, true);
        const float inv = 1.0F / (float)numCh;
        for (int ch = 0; ch < numCh; ++ch)
        {
            const float* s = buf.getReadPointer(ch);
            for (int i = 0; i < n; ++i) mono[(size_t)pos + (size_t)i] += s[i] * inv;
        }
        pos += n;
    }

    // One-pole LP ~120 Hz, then half-wave-rectified energy flux at hop 256.
    const double cutoff = 120.0;
    const double rc = 1.0 / (2.0 * juce::MathConstants<double>::pi * cutoff);
    const double dt = 1.0 / sr;
    const double alpha = dt / (rc + dt);
    double lpf = 0.0;
    for (size_t i = 0; i < mono.size(); ++i) { lpf += alpha * ((double)mono[i] - lpf); mono[i] = (float)lpf; }

    const int hop = 256;
    const double envRate = sr / hop;
    const size_t nf = mono.size() / hop;
    std::vector<double> flux(nf, 0.0);
    double prevE = 0.0;
    for (size_t fI = 0; fI < nf; ++fI)
    {
        double e = 0.0;
        for (int k = 0; k < hop; ++k) { const double v = mono[fI * hop + (size_t)k]; e += v * v; }
        flux[fI] = std::max(0.0, e - prevE);
        prevE = e;
    }
    double maxFlux = 1e-12;
    for (double v : flux) maxFlux = std::max(maxFlux, v);

    const int lo = std::max(1, (int)std::floor(startSec * envRate));
    const int hi = std::min((int)nf - 2, (int)std::ceil(endSec * envRate));
    std::printf("[onsets] %s  window %.2f..%.2fs  (envRate=%.2f Hz)\n",
                f.getFileName().toStdString().c_str(), startSec, endSec, envRate);
    std::printf("  time(s)   strength(%% of max)\n");
    for (int i = lo; i <= hi; ++i)
    {
        if (flux[(size_t)i] > flux[(size_t)i - 1] && flux[(size_t)i] >= flux[(size_t)i + 1] &&
            flux[(size_t)i] > 0.08 * maxFlux)
            std::printf("  %7.3f   %5.1f\n", (double)i / envRate, 100.0 * flux[(size_t)i] / maxFlux);
    }
    return 0;
}
} // namespace

int main(int argc, char** argv)
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    // Subcommand: SilverdawBpmEval --onsets <path> <startSec> <endSec>
    if (argc >= 5 && juce::String(argv[1]) == "--onsets")
    {
        const juce::String onsetPath(argv[2]);
        const juce::File f(onsetPath);
        return runOnsets(f, juce::String(argv[3]).getDoubleValue(), juce::String(argv[4]).getDoubleValue());
    }

    if (argc < 2)
    {
        std::cerr << "usage: SilverdawBpmEval <manifest> [--drums]\n"
                  << "       SilverdawBpmEval --onsets <path> <startSec> <endSec>\n";
        return 2;
    }
    bool drumsMode = false;
    for (int i = 2; i < argc; ++i)
        if (juce::String(argv[i]) == "--drums") drumsMode = true;

    const juce::File manifestFile(juce::File::getCurrentWorkingDirectory().getChildFile(argv[1]));
    if (!manifestFile.existsAsFile())
    {
        std::cerr << "[eval] manifest not found: " << manifestFile.getFullPathName().toStdString() << '\n';
        return 2;
    }

    const auto entries = parseManifest(manifestFile);
    if (entries.empty())
    {
        std::cerr << "[eval] no usable manifest entries\n";
        return 2;
    }

    juce::File modelDir;
    juce::File tmpDir;
    std::unique_ptr<silverdaw::StemSeparator> separator;
    bool useGpu = false;
    if (drumsMode)
    {
        const char* md = std::getenv("SILVERDAW_STEM_MODEL_DIR");
        if (md == nullptr || juce::String(md).isEmpty())
        {
            std::cerr << "[eval] --drums needs env SILVERDAW_STEM_MODEL_DIR (the htdemucs-ft dir)\n";
            return 2;
        }
        modelDir = juce::File(juce::String(md));
        if (!modelDir.isDirectory())
        {
            std::cerr << "[eval] model dir not found: " << modelDir.getFullPathName().toStdString() << '\n';
            return 2;
        }
        const char* g = std::getenv("SILVERDAW_STEM_USE_GPU");
        useGpu = (g != nullptr && juce::String(g).trim() == "1");
        tmpDir = juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("silverdaw-bpm-eval");
        tmpDir.createDirectory();
        separator = silverdaw::createDefaultStemSeparator();
        std::cout << "[eval] --drums on | model=" << modelDir.getFullPathName().toStdString()
                  << " | gpu=" << (useGpu ? 1 : 0) << '\n';
    }

    juce::AudioFormatManager fm;
    fm.registerBasicFormats();
    silverdaw::BpmDetector detector;

    std::cout << "\n  src  ref      detected  ratio   signed   |err|  phase(ms) /beat  flags  name\n";
    std::cout << "  ---  -------  --------  ------  -------  -----  --------- -----  -----  ----\n";

    Accum mixAcc;
    Accum drumAcc;

    for (const auto& e : entries)
    {
        juce::File f = juce::File::isAbsolutePath(e.path)
                           ? juce::File(e.path)
                           : juce::File::getCurrentWorkingDirectory().getChildFile(e.path);
        if (!f.existsAsFile())
        {
            std::cout << "  MISSING FILE: " << e.path.toStdString() << '\n';
            continue;
        }

        const auto mix = detector.analyse(f, fm);
        scoreRow("mix", mix, e, f.getFileName(), mixAcc);

        if (drumsMode)
        {
            juce::String err;
            const auto drumsFile = separateDrums(*separator, f, modelDir, tmpDir, 120000.0, useGpu, err);
            if (drumsFile == juce::File() || !drumsFile.existsAsFile())
            {
                std::cout << "  drm  (separation failed: " << err.toStdString() << ")\n";
            }
            else
            {
                auto drm = detector.analyse(drumsFile, fm);
                // Adopt the metrical octave from the full mix (mix gets the level
                // right even when its precise period is off); drums supply the
                // clean period. Safe: unchanged when already on the mix octave.
                drm.bpm = snapOctaveToReference(drm.bpm, mix.bpm);
                scoreRow("drm", drm, e, f.getFileName(), drumAcc);
                drumsFile.deleteFile();
            }
        }
    }

    std::cout << '\n';
    printSummary("mix", mixAcc);
    if (drumsMode) printSummary("drm", drumAcc);
    std::cout << '\n';
    if (tmpDir != juce::File()) tmpDir.deleteRecursively();
    return 0;
}
