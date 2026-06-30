// Dev probe for the Mel-Band RoFormer vocal pack (not shipped, not a CTest test).
// Runs MelRoformerVocals against Silverdaw's actual linked ONNX Runtime so we can
// confirm the model loads + separates on the real runtime (matching the Python
// reference), independent of the full separation pipeline.
//
// Usage: SilverdawRoformerProbe <core.onnx> <inputWav> <outputVocalWav>
//   The .onnx.data must sit beside <core.onnx>; onnxruntime.dll beside the exe.

#include "../../src/stems/MelRoformerVocals.h"

#include <cmath>
#include <cstdio>
#include <iostream>
#include <memory>

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

int main(int argc, char** argv)
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    if (argc < 4)
    {
        std::cerr << "usage: SilverdawRoformerProbe <core.onnx> <inputWav> <outputVocalWav>\n";
        return 1;
    }
    const juce::File modelFile{juce::String(argv[1])};
    const juce::File inFile{juce::String(argv[2])};
    const juce::File outFile{juce::String(argv[3])};

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

    silverdaw::MelRoformerVocals roformer;
    const bool useGpu =
        juce::SystemStats::getEnvironmentVariable("SILVERDAW_STEM_USE_GPU", "0") == "1";
    juce::AudioBuffer<float> vocals;
    try
    {
        vocals = roformer.separate(
            modelFile, mix, useGpu, 0.25,
            [](double f) { std::printf("\r  progress %.0f%%", f * 100.0); std::fflush(stdout); },
            [] { return false; });
    }
    catch (const std::exception& e)
    {
        std::printf("\nseparation failed: %s\n", e.what());
        return 3;
    }
    std::printf("\n");

    double mixRms = 0.0, vocRms = 0.0;
    for (int ch = 0; ch < 2; ++ch)
        for (int i = 0; i < frames; ++i)
        {
            mixRms += static_cast<double>(mix.getSample(ch, i)) * mix.getSample(ch, i);
            vocRms += static_cast<double>(vocals.getSample(ch, i)) * vocals.getSample(ch, i);
        }
    std::printf("mix RMS=%.4f  vocals RMS=%.4f\n", std::sqrt(mixRms / (2.0 * frames)),
                std::sqrt(vocRms / (2.0 * frames)));

    juce::WavAudioFormat wav;
    outFile.deleteFile();
    std::unique_ptr<juce::FileOutputStream> os(outFile.createOutputStream());
    std::unique_ptr<juce::AudioFormatWriter> writer(
        wav.createWriterFor(os.get(), reader->sampleRate, 2, 24, {}, 0));
    if (writer != nullptr)
    {
        os.release();
        writer->writeFromAudioSampleBuffer(vocals, 0, frames);
        writer.reset();
        std::printf("wrote %s\n", outFile.getFullPathName().toRawUTF8());
    }
    return 0;
}
