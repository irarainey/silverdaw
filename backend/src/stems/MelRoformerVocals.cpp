#include "MelRoformerVocals.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <thread>
#include <vector>

#include <onnxruntime_cxx_api.h>

#if defined(SILVERDAW_ONNXRUNTIME_DIRECTML)
#include <dml_provider_factory.h>
#endif

#include "Log.h"
#include "MelRoformerSpectral.h"
#include "StemSeparator.h"

namespace silverdaw
{
namespace
{
constexpr int kModelSampleRate = 44100;
// Track-level chunk stride: 8 s, matching the reference host. With the ~11 s
// model window this overlaps neighbouring chunks, cross-faded by a Hamming
// window so chunk seams are inaudible.
constexpr int kStepSamples = 8 * kModelSampleRate;
} // namespace

struct MelRoformerVocals::Impl
{
    Ort::Env env{ORT_LOGGING_LEVEL_WARNING, "silverdaw-roformer"};
    Ort::SessionOptions sessionOptions;
    std::unique_ptr<Ort::Session> session;
    juce::String sessionPath;
    bool epConfigured = false;
    bool epUsesGpu = false;
    MelRoformerSpectral spectral;

    void configureProvider(bool useGpu)
    {
        if (epConfigured && epUsesGpu == useGpu) return;
        session.reset();
        sessionPath = {};
        sessionOptions = Ort::SessionOptions{};
        const unsigned int cores = std::thread::hardware_concurrency();
        sessionOptions.SetIntraOpNumThreads(static_cast<int>(std::max(1u, cores)));
        sessionOptions.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
        if (useGpu)
        {
#if defined(SILVERDAW_ONNXRUNTIME_DIRECTML)
            sessionOptions.DisableMemPattern();
            sessionOptions.SetExecutionMode(ORT_SEQUENTIAL);
            sessionOptions.AddConfigEntry("ep.dml.disable_graph_fusion", "1");
            Ort::ThrowOnError(OrtSessionOptionsAppendExecutionProvider_DML(sessionOptions, 0));
            silverdaw::log::info("stems", "RoFormer ONNX execution provider: DirectML (GPU)");
#else
            silverdaw::log::info(
                "stems", "RoFormer GPU requested but this build ships the CPU ONNX Runtime; CPU.");
#endif
        }
        else
        {
            silverdaw::log::info("stems", "RoFormer ONNX execution provider: CPU");
        }
        epUsesGpu = useGpu;
        epConfigured = true;
    }

    Ort::Session& sessionFor(const juce::File& modelFile)
    {
        const auto path = modelFile.getFullPathName();
        if (session == nullptr || sessionPath != path)
        {
            session = std::make_unique<Ort::Session>(env, path.toWideCharPointer(), sessionOptions);
            sessionPath = path;
        }
        return *session;
    }
};

MelRoformerVocals::MelRoformerVocals() : impl(std::make_unique<Impl>()) {}
MelRoformerVocals::~MelRoformerVocals() = default;

juce::AudioBuffer<float> MelRoformerVocals::separate(
    const juce::File& modelFile, const juce::AudioBuffer<float>& mixture, bool useGpu,
    const std::function<void(double)>& onProgress, const std::function<bool()>& shouldCancel)
{
    using Spec = MelRoformerSpectral;
    const int numSamples = mixture.getNumSamples();
    juce::AudioBuffer<float> vocals(Spec::kChannels, numSamples);
    vocals.clear();
    if (numSamples <= 0) return vocals;

    impl->configureProvider(useGpu);
    Ort::Session& session = impl->sessionFor(modelFile);

    Ort::AllocatorWithDefaultOptions allocator;
    const auto inputName = session.GetInputNameAllocated(0, allocator);
    const auto outputName = session.GetOutputNameAllocated(0, allocator);
    const auto memInfo = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);

    // Peak-normalise the whole mixture to 0.9 (the model's expected input scale);
    // the vocal is rescaled back at the end so it sits at the mixture's level.
    float peak = 0.0f;
    for (int ch = 0; ch < Spec::kChannels && ch < mixture.getNumChannels(); ++ch)
        peak = std::max(peak, mixture.getMagnitude(ch, 0, numSamples));
    const float scale = peak > 1.0e-9f ? 0.9f / peak : 1.0f;

    // Planar, normalised mixture (mono mirrored to stereo if needed).
    std::vector<float> mixN(static_cast<size_t>(Spec::kChannels) * numSamples, 0.0f);
    for (int ch = 0; ch < Spec::kChannels; ++ch)
    {
        const int srcCh = std::min(ch, mixture.getNumChannels() - 1);
        const float* src = mixture.getReadPointer(srcCh);
        float* dst = mixN.data() + static_cast<size_t>(ch) * numSamples;
        for (int i = 0; i < numSamples; ++i) dst[i] = src[i] * scale;
    }

    std::vector<float> stft(static_cast<size_t>(Spec::kTensorFloats));
    std::vector<float> masks(static_cast<size_t>(Spec::kTensorFloats));
    std::vector<float> chunk(static_cast<size_t>(Spec::kChunkFloats));
    std::vector<float> sep(static_cast<size_t>(Spec::kChunkFloats));
    std::vector<double> target(static_cast<size_t>(Spec::kChannels) * numSamples, 0.0);
    std::vector<double> counter(static_cast<size_t>(Spec::kChannels) * numSamples, 0.0);

    // Hamming chunk-recombination window (reference host uses Hamming here, Hann
    // for the inner STFT overlap-add — both reproduced exactly).
    std::vector<float> hwin(static_cast<size_t>(Spec::kChunkSamples));
    for (int i = 0; i < Spec::kChunkSamples; ++i)
        hwin[static_cast<size_t>(i)] =
            0.54f - 0.46f * std::cos(2.0f * juce::MathConstants<float>::pi * static_cast<float>(i) /
                                     static_cast<float>(Spec::kChunkSamples));

    const std::array<int64_t, 4> shape{1, Spec::kPackedBins, Spec::kFrames, 2};
    const int step = std::min(kStepSamples, Spec::kChunkSamples);
    const int totalSteps = std::max(1, (numSamples + step - 1) / step);
    int stepIndex = 0;

    for (int offset = 0; offset < numSamples; offset += step)
    {
        if (shouldCancel && shouldCancel())
            throw StemSeparationError(StemFailureCode::Cancelled, "Cancelled");

        // getChunkWindow: a full chunk anchored inside the track, or the final
        // chunk pinned to the end, or the whole (short) track.
        int cstart = offset;
        int clen = std::min(Spec::kChunkSamples, numSamples - offset);
        if (offset + Spec::kChunkSamples > numSamples && numSamples >= Spec::kChunkSamples)
        {
            cstart = numSamples - Spec::kChunkSamples;
            clen = Spec::kChunkSamples;
        }

        std::fill(chunk.begin(), chunk.end(), 0.0f);
        for (int ch = 0; ch < Spec::kChannels; ++ch)
        {
            const float* src = mixN.data() + static_cast<size_t>(ch) * numSamples + cstart;
            std::copy_n(src, clen, chunk.begin() + static_cast<size_t>(ch) * Spec::kChunkSamples);
        }

        impl->spectral.analyze(chunk.data(), stft.data());

        auto inputTensor = Ort::Value::CreateTensor<float>(memInfo, stft.data(), stft.size(),
                                                           shape.data(), shape.size());
        auto outputTensor = Ort::Value::CreateTensor<float>(memInfo, masks.data(), masks.size(),
                                                            shape.data(), shape.size());
        const char* inNames[] = {inputName.get()};
        const char* outNames[] = {outputName.get()};
        session.Run(Ort::RunOptions{nullptr}, inNames, &inputTensor, 1, outNames, &outputTensor, 1);

        impl->spectral.synthesize(stft.data(), masks.data(), sep.data());

        for (int ch = 0; ch < Spec::kChannels; ++ch)
        {
            const float* s = sep.data() + static_cast<size_t>(ch) * Spec::kChunkSamples;
            double* t = target.data() + static_cast<size_t>(ch) * numSamples + cstart;
            double* c = counter.data() + static_cast<size_t>(ch) * numSamples + cstart;
            for (int i = 0; i < clen; ++i)
            {
                const float w = hwin[static_cast<size_t>(i)];
                t[i] += static_cast<double>(s[i]) * w;
                c[i] += w;
            }
        }

        ++stepIndex;
        if (onProgress) onProgress(static_cast<double>(stepIndex) / totalSteps);
    }

    // Finalise the chunk overlap-add and restore the mixture level so the vocal
    // is residual-consistent with the (unnormalised) drums/bass/other.
    const float inv = scale > 0.0f ? 1.0f / scale : 1.0f;
    for (int ch = 0; ch < Spec::kChannels; ++ch)
    {
        float* out = vocals.getWritePointer(ch);
        const double* t = target.data() + static_cast<size_t>(ch) * numSamples;
        const double* c = counter.data() + static_cast<size_t>(ch) * numSamples;
        for (int i = 0; i < numSamples; ++i)
            out[i] = static_cast<float>(t[i] / std::max(c[i], 1.0e-10)) * inv;
    }
    if (onProgress) onProgress(1.0);
    return vocals;
}

} // namespace silverdaw
