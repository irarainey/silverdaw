// Offline stem-separation quality harness (dev tool, not shipped).
//
// Computes objective separation metrics (SI-SDR and plain SDR, in dB) between a
// REFERENCE stem (ground truth) and an ESTIMATE stem (what the separator
// produced). This is the numeric yardstick the separation work needs: it turns
// "does shifts / overlap / a new model actually help vocals?" from a subjective
// A/B into a measured median dB delta. Decoupled from the unit-test suite so it
// can grow without bloating CI.
//
// Usage:
//   SilverdawStemEval <manifest>
// Manifest lines: `<referenceWav>|<estimateWav>[|<label>]`; '#'/blank ignored.
// Both files must share a sample rate and channel count (compare like for like);
// the shorter length is used. SI-SDR is scale-invariant (a correct stem at a
// different gain still scores high); plain SDR penalises level mismatch.

#include "../../src/stems/StemMetrics.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <iostream>
#include <memory>
#include <vector>

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

namespace
{

struct Pair
{
    juce::String referencePath;
    juce::String estimatePath;
    juce::String label;
};

std::vector<Pair> parseManifest(const juce::File& file)
{
    std::vector<Pair> pairs;
    juce::StringArray lines;
    file.readLines(lines);
    for (const auto& raw : lines)
    {
        const auto line = raw.trim();
        if (line.isEmpty() || line.startsWith("#")) continue;
        juce::StringArray cols;
        cols.addTokens(line, "|", "");
        if (cols.size() < 2) continue;
        Pair p;
        p.referencePath = cols[0].trim();
        p.estimatePath = cols[1].trim();
        p.label = cols.size() >= 3 ? cols[2].trim() : p.referencePath;
        pairs.push_back(p);
    }
    return pairs;
}

// Decode a file into a stereo float buffer at its native rate (mono is mirrored
// to both channels so two files of differing channel counts still compare).
bool loadStereo(const juce::File& f, juce::AudioBuffer<float>& out, double& sampleRate)
{
    juce::AudioFormatManager fm;
    fm.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(fm.createReaderFor(f));
    if (reader == nullptr || reader->sampleRate <= 0.0) return false;
    sampleRate = reader->sampleRate;
    const int frames = static_cast<int>(reader->lengthInSamples);
    out.setSize(2, frames);
    out.clear();
    reader->read(&out, 0, frames, 0, true, reader->numChannels > 1);
    if (reader->numChannels == 1) out.copyFrom(1, 0, out, 0, 0, frames);
    return true;
}

} // namespace

int main(int argc, char** argv)
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    if (argc < 2)
    {
        std::cerr << "usage: SilverdawStemEval <manifest>\n"
                     "  manifest lines: <referenceWav>|<estimateWav>[|label]\n";
        return 1;
    }

    const juce::File manifest{ juce::String(argv[1]) };
    if (!manifest.existsAsFile())
    {
        std::cerr << "cannot read manifest: " << manifest.getFullPathName().toStdString() << '\n';
        return 1;
    }

    const auto pairs = parseManifest(manifest);
    if (pairs.empty())
    {
        std::cerr << "manifest has no usable rows\n";
        return 1;
    }

    std::cout << "  SI-SDR    SDR   label\n";
    std::cout << "  (dB)     (dB)\n";

    std::vector<double> siSdrs;
    siSdrs.reserve(pairs.size());
    for (const auto& p : pairs)
    {
        juce::AudioBuffer<float> ref, est;
        double srRef = 0.0, srEst = 0.0;
        if (!loadStereo(juce::File(p.referencePath), ref, srRef))
        {
            std::cerr << "  skip (cannot read reference): " << p.referencePath.toStdString() << '\n';
            continue;
        }
        if (!loadStereo(juce::File(p.estimatePath), est, srEst))
        {
            std::cerr << "  skip (cannot read estimate): " << p.estimatePath.toStdString() << '\n';
            continue;
        }
        if (std::abs(srRef - srEst) > 1.0)
            std::cerr << "  warn: sample-rate mismatch (" << srRef << " vs " << srEst
                      << ") for " << p.label.toStdString() << " — metric may be invalid\n";

        const double siSdr = silverdaw::siSdrDb(ref, est);
        const double sdr = silverdaw::sdrDb(ref, est);
        siSdrs.push_back(siSdr);
        char buf[512];
        std::snprintf(buf, sizeof(buf), "  %6.2f  %6.2f  %s", siSdr, sdr, p.label.toRawUTF8());
        std::cout << buf << '\n';
    }

    if (!siSdrs.empty())
    {
        std::sort(siSdrs.begin(), siSdrs.end());
        const double median = siSdrs[siSdrs.size() / 2];
        double sum = 0.0;
        for (double v : siSdrs) sum += v;
        std::cout << "  ---\n"
                  << "  n=" << siSdrs.size() << "  mean SI-SDR=" << (sum / siSdrs.size())
                  << " dB  median SI-SDR=" << median << " dB\n";
    }
    return 0;
}
