#include "BsRoformerRhythm.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <vector>

#include <onnxruntime_cxx_api.h>

#if defined(SILVERDAW_ONNXRUNTIME_DIRECTML)
#include <dml_provider_factory.h>
#endif

#include "BsRoformerSpectral.h"
#include "InferenceThreads.h"
#include "Log.h"
#include "StemSeparator.h"

namespace silverdaw
{
namespace
{
using Spec = BsRoformerSpectral;
constexpr int kModelSampleRate = 44100;
// The 4-stem model emits [drums, bass, other, vocals]; we keep drums + bass.
constexpr int kDrumsIndex = 0;
constexpr int kBassIndex = 1;
} // namespace

struct BsRoformerRhythm::Impl
{
    Ort::Env env{ORT_LOGGING_LEVEL_ERROR, "silverdaw-bsroformer"};
    Ort::SessionOptions sessionOptions;
    std::unique_ptr<Ort::Session> session;
    juce::String sessionPath;
    bool epConfigured = false;
    bool epUsesGpu = false;
    BsRoformerSpectral spectral;

    void configureProvider(bool useGpu)
    {
        if (epConfigured && epUsesGpu == useGpu && session != nullptr) return;
        session.reset();
        sessionPath = {};
        sessionOptions = Ort::SessionOptions{};
        sessionOptions.SetIntraOpNumThreads(stems::inferenceIntraOpThreads());
        sessionOptions.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
        if (useGpu)
        {
#if defined(SILVERDAW_ONNXRUNTIME_DIRECTML)
            sessionOptions.DisableMemPattern();
            sessionOptions.SetExecutionMode(ORT_SEQUENTIAL);
            sessionOptions.AddConfigEntry("ep.dml.disable_graph_fusion", "1");
            Ort::ThrowOnError(OrtSessionOptionsAppendExecutionProvider_DML(sessionOptions, 0));
            silverdaw::log::info("stems", "Rhythm RoFormer execution provider: DirectML (GPU)");
#else
            silverdaw::log::info(
                "stems", "Rhythm RoFormer GPU requested but this build ships the CPU ONNX Runtime; CPU.");
#endif
        }
        else
        {
            silverdaw::log::info("stems", "Rhythm RoFormer execution provider: CPU");
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

    // One full separation pass on the configured provider. May throw
    // Ort::Exception (e.g. DirectML out-of-memory); the caller retries on CPU.
    BsRoformerRhythmStems run(const juce::File& modelFile, const juce::AudioBuffer<float>& mixture,
                              bool useGpu, double overlap,
                              const std::function<void(double)>& onProgress,
                              const std::function<bool()>& shouldCancel)
    {
        configureProvider(useGpu);
        Ort::Session& sess = sessionFor(modelFile);

        Ort::AllocatorWithDefaultOptions allocator;
        const auto inRealName = sess.GetInputNameAllocated(0, allocator);
        const auto inImagName = sess.GetInputNameAllocated(1, allocator);
        const auto outRealName = sess.GetOutputNameAllocated(0, allocator);
        const auto outImagName = sess.GetOutputNameAllocated(1, allocator);
        const auto memInfo = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);

        const int numSamples = mixture.getNumSamples();
        BsRoformerRhythmStems out;
        out.drums.setSize(Spec::kChannels, numSamples);
        out.bass.setSize(Spec::kChannels, numSamples);
        out.drums.clear();
        out.bass.clear();

        // Planar, RAW (mixture-level) input; mono mirrored to stereo if needed.
        // The mask is scale-linear, so feeding the mixture directly yields stems
        // at the mixture's level — keeping the residual `other` consistent.
        std::vector<float> mixPlanar(static_cast<size_t>(Spec::kChannels) * numSamples, 0.0f);
        for (int ch = 0; ch < Spec::kChannels; ++ch)
        {
            const int srcCh = std::min(ch, mixture.getNumChannels() - 1);
            const float* src = mixture.getReadPointer(srcCh);
            std::copy_n(src, numSamples, mixPlanar.data() + static_cast<size_t>(ch) * numSamples);
        }

        std::vector<float> specReal(static_cast<size_t>(Spec::kSpecFloats));
        std::vector<float> specImag(static_cast<size_t>(Spec::kSpecFloats));
        std::vector<float> outReal(static_cast<size_t>(Spec::kOutFloats));
        std::vector<float> outImag(static_cast<size_t>(Spec::kOutFloats));
        std::vector<float> chunk(static_cast<size_t>(Spec::kChunkFloats));
        std::vector<float> sep(static_cast<size_t>(Spec::kChunkFloats));
        std::vector<double> drumsAcc(static_cast<size_t>(Spec::kChannels) * numSamples, 0.0);
        std::vector<double> bassAcc(static_cast<size_t>(Spec::kChannels) * numSamples, 0.0);
        std::vector<double> counter(static_cast<size_t>(numSamples), 0.0);

        std::vector<float> hwin(static_cast<size_t>(Spec::kChunkSamples));
        for (int i = 0; i < Spec::kChunkSamples; ++i)
            hwin[static_cast<size_t>(i)] =
                0.5f - 0.5f * std::cos(2.0f * juce::MathConstants<float>::pi * static_cast<float>(i) /
                                       static_cast<float>(Spec::kChunkSamples));

        const std::array<int64_t, 4> inShape{1, Spec::kChannels, Spec::kBins, Spec::kFrames};
        const std::array<int64_t, 5> outShape{1, Spec::kNumStems, Spec::kChannels, Spec::kBins,
                                              Spec::kFrames};
        // Chunk stride from the quality preset's overlap (higher overlap = more
        // model runs, smoother seams). The recombination is normalised by an
        // accumulated counter, so any overlap reconstructs at unity gain.
        const double ov = juce::jlimit(0.0, 0.9, overlap);
        const int step = std::max(
            1, std::min(Spec::kChunkSamples,
                        static_cast<int>(Spec::kChunkSamples * (1.0 - ov))));
        const int totalSteps = std::max(1, (numSamples + step - 1) / step);
        int stepIndex = 0;

        // OLA one stem's reconstruction (already in `sep`) into its accumulator.
        const auto overlapAdd = [&](std::vector<double>& acc, int cstart, int clen)
        {
            for (int ch = 0; ch < Spec::kChannels; ++ch)
            {
                const float* s = sep.data() + static_cast<size_t>(ch) * Spec::kChunkSamples;
                double* a = acc.data() + static_cast<size_t>(ch) * numSamples + cstart;
                for (int i = 0; i < clen; ++i)
                    a[i] += static_cast<double>(s[i]) * hwin[static_cast<size_t>(i)];
            }
        };

        for (int offset = 0; offset < numSamples; offset += step)
        {
            if (shouldCancel && shouldCancel())
                throw StemSeparationError(StemFailureCode::Cancelled, "Cancelled");

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
                const float* src = mixPlanar.data() + static_cast<size_t>(ch) * numSamples + cstart;
                std::copy_n(src, clen, chunk.begin() + static_cast<size_t>(ch) * Spec::kChunkSamples);
            }

            impl_analyze(specReal, specImag, chunk);

            std::array<Ort::Value, 2> inputs{
                Ort::Value::CreateTensor<float>(memInfo, specReal.data(), specReal.size(),
                                                inShape.data(), inShape.size()),
                Ort::Value::CreateTensor<float>(memInfo, specImag.data(), specImag.size(),
                                                inShape.data(), inShape.size())};
            std::array<Ort::Value, 2> outputs{
                Ort::Value::CreateTensor<float>(memInfo, outReal.data(), outReal.size(),
                                                outShape.data(), outShape.size()),
                Ort::Value::CreateTensor<float>(memInfo, outImag.data(), outImag.size(),
                                                outShape.data(), outShape.size())};
            const char* inNames[] = {inRealName.get(), inImagName.get()};
            const char* outNames[] = {outRealName.get(), outImagName.get()};
            sess.Run(Ort::RunOptions{nullptr}, inNames, inputs.data(), inputs.size(), outNames,
                     outputs.data(), outputs.size());

            // Reconstruct drums + bass from their output-tensor slices.
            spectral.synthesizeStem(outReal.data() + static_cast<size_t>(kDrumsIndex) * Spec::kSpecFloats,
                                    outImag.data() + static_cast<size_t>(kDrumsIndex) * Spec::kSpecFloats,
                                    sep.data());
            overlapAdd(drumsAcc, cstart, clen);
            spectral.synthesizeStem(outReal.data() + static_cast<size_t>(kBassIndex) * Spec::kSpecFloats,
                                    outImag.data() + static_cast<size_t>(kBassIndex) * Spec::kSpecFloats,
                                    sep.data());
            overlapAdd(bassAcc, cstart, clen);

            for (int i = 0; i < clen; ++i)
                counter[static_cast<size_t>(cstart + i)] += hwin[static_cast<size_t>(i)];

            ++stepIndex;
            if (onProgress) onProgress(static_cast<double>(stepIndex) / totalSteps);
        }

        const auto finalise = [&](std::vector<double>& acc, juce::AudioBuffer<float>& dst)
        {
            for (int ch = 0; ch < Spec::kChannels; ++ch)
            {
                float* o = dst.getWritePointer(ch);
                const double* a = acc.data() + static_cast<size_t>(ch) * numSamples;
                for (int i = 0; i < numSamples; ++i)
                    o[i] = static_cast<float>(a[i] / std::max(counter[static_cast<size_t>(i)], 1.0e-10));
            }
        };
        finalise(drumsAcc, out.drums);
        finalise(bassAcc, out.bass);
        if (onProgress) onProgress(1.0);
        return out;
    }

    void impl_analyze(std::vector<float>& specReal, std::vector<float>& specImag,
                      const std::vector<float>& chunk)
    {
        spectral.analyze(chunk.data(), specReal.data(), specImag.data());
    }
};

BsRoformerRhythm::BsRoformerRhythm() : impl(std::make_unique<Impl>()) {}
BsRoformerRhythm::~BsRoformerRhythm() = default;

BsRoformerRhythmStems BsRoformerRhythm::separate(
    const juce::File& modelFile, const juce::AudioBuffer<float>& mixture, bool useGpu,
    double overlap, const std::function<void(double)>& onProgress,
    const std::function<bool()>& shouldCancel)
{
    if (mixture.getNumSamples() <= 0) return {};
    try
    {
        return impl->run(modelFile, mixture, useGpu, overlap, onProgress, shouldCancel);
    }
    catch (const Ort::Exception& e)
    {
        if (useGpu)
        {
            silverdaw::log::info("stems", juce::String("Rhythm RoFormer GPU run failed (")
                                              + e.what() + "); retrying on CPU.");
            return impl->run(modelFile, mixture, false, overlap, onProgress, shouldCancel);
        }
        throw;
    }
}

} // namespace silverdaw
