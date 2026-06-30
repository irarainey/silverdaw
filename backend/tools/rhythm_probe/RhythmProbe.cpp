// Dev probe for the 4-stem BS-RoFormer rhythm pack (not shipped, not a CTest
// test). Runs BsRoformerRhythm against Silverdaw's actual linked ONNX Runtime so
// we can confirm the full C++ runner (chunk driver, stem indexing, overlap-add)
// separates drums + bass on the real runtime, matching the Python reference.
//
// Usage: SilverdawRhythmProbe <core.onnx> <inputWav> <outDrumsWav> <outBassWav>
//   SILVERDAW_STEM_USE_GPU=1 selects the DirectML provider.

#include "../../src/stems/BsRoformerRhythm.h"

#include <cstdio>
#include <iostream>
#include <memory>

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

namespace
{
void writeWav(const juce::File& outFile, const juce::AudioBuffer<float>& buf, double sampleRate)
{
    juce::WavAudioFormat wav;
    outFile.deleteFile();
    std::unique_ptr<juce::FileOutputStream> os(outFile.createOutputStream());
    std::unique_ptr<juce::AudioFormatWriter> writer(
        wav.createWriterFor(os.get(), sampleRate, 2, 24, {}, 0));
    if (writer != nullptr)
    {
        os.release();
        writer->writeFromAudioSampleBuffer(buf, 0, buf.getNumSamples());
        writer.reset();
        std::printf("wrote %s\n", outFile.getFullPathName().toRawUTF8());
    }
}
} // namespace

int main(int argc, char** argv)
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    if (argc < 5)
    {
        std::cerr << "usage: SilverdawRhythmProbe <core.onnx> <inputWav> <outDrumsWav> "
                     "<outBassWav>\n";
        return 1;
    }
    const juce::File modelFile{juce::String(argv[1])};
    const juce::File inFile{juce::String(argv[2])};
    const juce::File drumsFile{juce::String(argv[3])};
    const juce::File bassFile{juce::String(argv[4])};

    juce::AudioFormatManager fm;
    fm.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(fm.createReaderFor(inFile));
    if (reader == nullptr || reader->sampleRate <= 0.0)
    {
        std::cerr << "cannot read input wav\n";
        return 2;
    }
    const int frames = static_cast<int>(reader->lengthInSamples);
    juce::AudioBuffer<float> mix(2, frames);
    mix.clear();
    reader->read(&mix, 0, frames, 0, true, reader->numChannels > 1);
    if (reader->numChannels == 1) mix.copyFrom(1, 0, mix, 0, 0, frames);
    std::printf("input: %.1f s, %.0f Hz\n", frames / reader->sampleRate, reader->sampleRate);

    silverdaw::BsRoformerRhythm rhythm;
    const bool useGpu =
        juce::SystemStats::getEnvironmentVariable("SILVERDAW_STEM_USE_GPU", "0") == "1";
    silverdaw::BsRoformerRhythmStems stems;
    try
    {
        stems = rhythm.separate(
            modelFile, mix, useGpu, 0.5,
            [](double f) { std::printf("\r  progress %.0f%%", f * 100.0); std::fflush(stdout); },
            [] { return false; });
    }
    catch (const std::exception& e)
    {
        std::printf("\nseparation failed: %s\n", e.what());
        return 3;
    }
    std::printf("\n");

    auto rms = [frames](const juce::AudioBuffer<float>& b)
    {
        double s = 0.0;
        for (int ch = 0; ch < 2; ++ch)
            for (int i = 0; i < frames; ++i)
                s += static_cast<double>(b.getSample(ch, i)) * b.getSample(ch, i);
        return std::sqrt(s / (2.0 * frames));
    };
    std::printf("drums RMS=%.4f  bass RMS=%.4f\n", rms(stems.drums), rms(stems.bass));

    writeWav(drumsFile, stems.drums, reader->sampleRate);
    writeWav(bassFile, stems.bass, reader->sampleRate);
    return 0;
}
