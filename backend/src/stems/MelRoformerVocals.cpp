#include "MelRoformerVocals.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <vector>

#include <onnxruntime_cxx_api.h>

#if defined(SILVERDAW_ONNXRUNTIME_DIRECTML)
#include <dml_provider_factory.h>
#endif

#include "InferenceThreads.h"
#include "Log.h"
#include "MelRoformerSpectral.h"
#include "OnnxLogging.h"
#include "StemRunCancellation.h"
#include "StemSeparator.h"

namespace silverdaw
{
namespace
{
constexpr int kModelSampleRate = 44100;
} // namespace

struct MelRoformerVocals::Impl
{
    Ort::Env env{makeOrtEnv("silverdaw-roformer")};
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
        const int intraOpThreads = stems::inferenceIntraOpThreads();
        sessionOptions.SetIntraOpNumThreads(intraOpThreads);
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
            silverdaw::log::info("stems", "RoFormer ONNX execution provider: CPU ("
                                              + juce::String(intraOpThreads) + " intra-op threads)");
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
    double overlap, const std::function<void(double)>& onProgress,
    const std::function<bool()>& shouldCancel)
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
    // Overlap-add accumulators. `float` is ample here: each output sample is a weighted
    // sum of only a handful of overlapping chunks (not a long cumulative sum), so float's
    // precision is far below the audible/output resolution — and it halves the largest
    // per-run allocation on long songs. `counter` is channel-independent (the recombination
    // window is the same for every channel), so a single mono weight track suffices.
    std::vector<float> target(static_cast<size_t>(Spec::kChannels) * numSamples, 0.0f);
    std::vector<float> counter(static_cast<size_t>(numSamples), 0.0f);

    // Hamming chunk-recombination window (reference host uses Hamming here, Hann
    // for the inner STFT overlap-add — both reproduced exactly).
    std::vector<float> hwin(static_cast<size_t>(Spec::kChunkSamples));
    for (int i = 0; i < Spec::kChunkSamples; ++i)
        hwin[static_cast<size_t>(i)] =
            0.54f - 0.46f * std::cos(2.0f * juce::MathConstants<float>::pi * static_cast<float>(i) /
                                     static_cast<float>(Spec::kChunkSamples));

    const std::array<int64_t, 4> shape{1, Spec::kPackedBins, Spec::kFrames, 2};
    // Chunk stride from the quality preset's overlap: higher overlap blends more
    // neighbouring windows (smoother seams) at the cost of more model runs. The
    // chunk recombination is normalised by an accumulated window counter, so any
    // overlap reconstructs at unity gain.
    const double ov = juce::jlimit(0.0, 0.9, overlap);
    const int step = std::max(
        1, std::min(Spec::kChunkSamples,
                    static_cast<int>(Spec::kChunkSamples * (1.0 - ov))));
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
        stems::runCancellable(shouldCancel, [&](Ort::RunOptions& runOptions) {
            session.Run(runOptions, inNames, &inputTensor, 1, outNames, &outputTensor, 1);
        });

        impl->spectral.synthesize(stft.data(), masks.data(), sep.data());

        for (int ch = 0; ch < Spec::kChannels; ++ch)
        {
            const float* s = sep.data() + static_cast<size_t>(ch) * Spec::kChunkSamples;
            float* t = target.data() + static_cast<size_t>(ch) * numSamples + cstart;
            for (int i = 0; i < clen; ++i)
                t[i] += s[i] * hwin[static_cast<size_t>(i)];
        }
        // Channel-independent recombination weight — accumulate once (mono).
        {
            float* c = counter.data() + cstart;
            for (int i = 0; i < clen; ++i) c[i] += hwin[static_cast<size_t>(i)];
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
        const float* t = target.data() + static_cast<size_t>(ch) * numSamples;
        for (int i = 0; i < numSamples; ++i)
            out[i] = (t[i] / std::max(counter[static_cast<size_t>(i)], 1.0e-10f)) * inv;
    }
    if (onProgress) onProgress(1.0);
    return vocals;
}

} // namespace silverdaw
