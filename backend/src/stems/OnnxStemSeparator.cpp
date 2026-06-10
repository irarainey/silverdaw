#include "OnnxStemSeparator.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>

#include <onnxruntime_cxx_api.h>

#include "Log.h"

namespace silverdaw
{
namespace
{

constexpr int kModelSampleRate = 44100;
constexpr int kModelChannels = 2;

// htdemucs-ft is a "bag" of four specialist models — one .onnx per source. Every
// specialist still emits all four demucs sources in the fixed order
// [drums, bass, other, vocals]; we keep only the source the specialist is
// fine-tuned for. The model's input is a fixed-length 7.8 s segment, so a full
// track is processed as overlapping windows that are weighted and summed back
// together (demucs `apply_model` overlap-add).
constexpr int kSegmentSamples = 343980; // 7.8 s @ 44.1 kHz — the model's fixed input length.
// Overlap is resolved per-request from the quality preset; clamp to a safe
// range so a malformed value can never produce a zero/negative stride.
constexpr double kMaxOverlap = 0.95;

// Overall-job progress is a single monotonic 0..100 (the bridge contract). The
// quick decode/normalise prepare phase and the file-write phase take a thin
// slice at each end; the dominant per-segment inference fills the middle band.
constexpr double kPreparePercent = 2.0;
constexpr double kSeparatePercent = 98.0;

// Output filenames + STEM_READY stem vocabulary. Order here is independent of the
// model's internal source order (handled by sourceIndexForStem below).
const std::array<const char*, 4> kStemNames{"vocals", "drums", "bass", "other"};

// Index of a specialist's own source within the model's [drums, bass, other,
// vocals] output. Used to pick the trusted source out of the four it emits.
int sourceIndexForStem(const char* stem)
{
    const juce::String s(stem);
    if (s == "drums") return 0;
    if (s == "bass") return 1;
    if (s == "other") return 2;
    return 3; // vocals
}

juce::File modelFileFor(const juce::File& modelDir, const char* stem)
{
    return modelDir.getChildFile(juce::String("htdemucs_ft_") + stem + ".onnx");
}

// Decode the source file into a 2-channel float buffer resampled to the model's
// fixed 44.1 kHz. Throws StemSeparationError{Decode} on any read failure.
juce::AudioBuffer<float> decodeStereo44k(const juce::File& sourceFile)
{
    juce::AudioFormatManager formatManager;
    formatManager.registerBasicFormats();

    std::unique_ptr<juce::AudioFormatReader> reader(formatManager.createReaderFor(sourceFile));
    if (reader == nullptr)
        throw StemSeparationError(StemFailureCode::Decode,
                                  "Could not read source audio: " + sourceFile.getFullPathName());

    const auto sourceLength = static_cast<int>(reader->lengthInSamples);
    if (sourceLength <= 0)
        throw StemSeparationError(StemFailureCode::Decode, "Source audio is empty.");

    juce::AudioBuffer<float> decoded(kModelChannels, sourceLength);
    decoded.clear();
    reader->read(&decoded, 0, sourceLength, 0, true, reader->numChannels > 1);
    // Mono sources fill only channel 0; mirror it so the model sees stereo.
    if (reader->numChannels == 1)
        decoded.copyFrom(1, 0, decoded, 0, 0, sourceLength);

    if (static_cast<int>(reader->sampleRate) == kModelSampleRate)
        return decoded;

    const double ratio = static_cast<double>(reader->sampleRate) / kModelSampleRate;
    const auto resampledLength = static_cast<int>(std::ceil(sourceLength / ratio));
    juce::AudioBuffer<float> resampled(kModelChannels, resampledLength);
    resampled.clear();
    for (int ch = 0; ch < kModelChannels; ++ch)
    {
        juce::LagrangeInterpolator interpolator;
        interpolator.process(ratio, decoded.getReadPointer(ch),
                             resampled.getWritePointer(ch), resampledLength);
    }
    return resampled;
}

void writeStemWav(const juce::File& outputFile, const juce::AudioBuffer<float>& buffer)
{
    if (outputFile.existsAsFile()) outputFile.deleteFile();

    juce::WavAudioFormat wavFormat;
    std::unique_ptr<juce::FileOutputStream> stream(outputFile.createOutputStream());
    if (stream == nullptr)
        throw StemSeparationError(StemFailureCode::Io,
                                  "Could not open stem output: " + outputFile.getFullPathName());

    std::unique_ptr<juce::AudioFormatWriter> writer(
        wavFormat.createWriterFor(stream.get(), kModelSampleRate, (unsigned int) kModelChannels, 24,
                                  {}, 0));
    if (writer == nullptr)
        throw StemSeparationError(StemFailureCode::Io,
                                  "Could not create WAV writer: " + outputFile.getFullPathName());

    stream.release(); // writer owns the stream now
    if (! writer->writeFromAudioSampleBuffer(buffer, 0, buffer.getNumSamples()))
        throw StemSeparationError(StemFailureCode::Io,
                                  "Failed writing stem: " + outputFile.getFullPathName());
}

// Triangular overlap-add window (demucs `apply_model`): rises 1..L/2 then falls
// L/2..1 so neighbouring windows cross-fade. Never zero, so the accumulated
// weight is always positive wherever a window covers a sample.
std::vector<float> makeTransitionWindow(int length)
{
    std::vector<float> w(static_cast<size_t>(length));
    const int half = length / 2;
    const auto peak = static_cast<float>(half);
    for (int n = 0; n < length; ++n)
    {
        const float rising = static_cast<float>(n + 1);
        const float falling = static_cast<float>(length - n);
        w[static_cast<size_t>(n)] = std::min(rising, falling) / peak;
    }
    return w;
}

// Per-track normalisation demucs applies before inference: centre and scale by
// the mono mixture's mean / standard deviation, undone on the separated output.
struct Normalisation
{
    float mean = 0.0f;
    float std = 1.0f;
};

Normalisation computeNormalisation(const juce::AudioBuffer<float>& mixture)
{
    const int n = mixture.getNumSamples();
    const float* left = mixture.getReadPointer(0);
    const float* right = mixture.getReadPointer(1);

    double sum = 0.0;
    for (int i = 0; i < n; ++i)
        sum += 0.5 * (static_cast<double>(left[i]) + static_cast<double>(right[i]));
    const double mean = n > 0 ? sum / n : 0.0;

    double sq = 0.0;
    for (int i = 0; i < n; ++i)
    {
        const double mono = 0.5 * (static_cast<double>(left[i]) + static_cast<double>(right[i]));
        const double d = mono - mean;
        sq += d * d;
    }
    // torch.std default is unbiased (N-1); guard a silent track against /0.
    const double variance = n > 1 ? sq / (n - 1) : 0.0;
    double stddev = std::sqrt(variance);
    if (stddev < 1.0e-8) stddev = 1.0;

    return {static_cast<float>(mean), static_cast<float>(stddev)};
}

class OnnxStemSeparator : public StemSeparator
{
  public:
    OnnxStemSeparator() : env(ORT_LOGGING_LEVEL_WARNING, "silverdaw-stems")
    {
        // No realtime audio plays during an offline separation, so dedicate every
        // logical core to inference (never fewer than one).
        const unsigned int cores = std::thread::hardware_concurrency();
        sessionOptions.SetIntraOpNumThreads(static_cast<int>(std::max(1u, cores)));
        sessionOptions.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
    }

    StemSeparationResult separate(const StemSeparationRequest& request,
                                  const StemProgressFn& onProgress,
                                  const StemReadyFn& onStemReady,
                                  const StemCancelFn& shouldCancel) override
    {
        onProgress("prepare", 0.0, "");

        for (const auto* stem : kStemNames)
        {
            if (! modelFileFor(request.modelDir, stem).existsAsFile())
                throw StemSeparationError(StemFailureCode::Model,
                                          juce::String("Missing model weight: ") +
                                              modelFileFor(request.modelDir, stem).getFullPathName());
        }

        if (shouldCancel()) throw StemSeparationError(StemFailureCode::Cancelled, "Cancelled");

        auto mixture = decodeStereo44k(request.sourceFile);
        const int numSamples = mixture.getNumSamples();

        // Centre + scale by the mono mixture statistics before inference.
        const auto norm = computeNormalisation(mixture);
        for (int ch = 0; ch < kModelChannels; ++ch)
        {
            float* d = mixture.getWritePointer(ch);
            for (int i = 0; i < numSamples; ++i)
                d[i] = (d[i] - norm.mean) / norm.std;
        }

        const auto window = makeTransitionWindow(kSegmentSamples);
        const double overlap = std::clamp(request.overlap, 0.0, kMaxOverlap);
        const int stride = std::max(1, static_cast<int>(kSegmentSamples * (1.0 - overlap)));
        std::vector<int> offsets;
        for (int start = 0; start < numSamples; start += stride)
            offsets.push_back(start);
        if (offsets.empty()) offsets.push_back(0);

        onProgress("prepare", kPreparePercent, "");

        StemSeparationResult result;
        const auto memInfo = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);

        // Only run the stems the user selected; an empty selection means all four.
        // Skipping a stem skips its specialist model entirely, so a partial
        // selection is proportionally faster.
        const auto isSelected = [&request](const char* stem)
        {
            if (request.stems.empty()) return true;
            return std::find(request.stems.begin(), request.stems.end(), juce::String(stem)) !=
                   request.stems.end();
        };
        const size_t selectedCount =
            request.stems.empty() ? kStemNames.size() : request.stems.size();

        // Split the separate band evenly across the selected specialist models.
        const double stemSpan = (kSeparatePercent - kPreparePercent) / static_cast<double>(selectedCount);

        size_t produced = 0;
        for (size_t s = 0; s < kStemNames.size(); ++s)
        {
            const auto* stem = kStemNames[s];
            if (! isSelected(stem)) continue;
            if (shouldCancel()) throw StemSeparationError(StemFailureCode::Cancelled, "Cancelled");
            const double stemBase = kPreparePercent + stemSpan * static_cast<double>(produced);
            ++produced;
            onProgress("separate", stemBase, stem);

            auto stemBuffer = separateOneStem(request.modelDir, stem, mixture, numSamples, window,
                                              offsets, memInfo, onProgress, shouldCancel, stemBase,
                                              stemSpan);

            // Undo the per-track normalisation applied before inference.
            for (int ch = 0; ch < kModelChannels; ++ch)
            {
                float* d = stemBuffer.getWritePointer(ch);
                for (int i = 0; i < numSamples; ++i)
                    d[i] = d[i] * norm.std + norm.mean;
            }

            const auto outFile = request.outputDir.getChildFile(
                juce::File::createLegalFileName(request.sourceName + " - " + stem + ".wav"));
            writeStemWav(outFile, stemBuffer);
            result.stems.push_back({juce::String(stem), outFile});
            // Let the UI import this stem now, before later stems finish.
            onStemReady(stem, outFile);
        }

        onProgress("write", 100.0, "");
        return result;
    }

  private:
    // Run one specialist model over every overlapping window and reconstruct its
    // source via weighted overlap-add. Input mixture is already normalised.
    juce::AudioBuffer<float> separateOneStem(const juce::File& modelDir, const char* stem,
                                             const juce::AudioBuffer<float>& mixture, int numSamples,
                                             const std::vector<float>& window,
                                             const std::vector<int>& offsets,
                                             const Ort::MemoryInfo& memInfo,
                                             const StemProgressFn& onProgress,
                                             const StemCancelFn& shouldCancel, double stemBase,
                                             double stemSpan)
    {
        Ort::Session& session = getOrCreateSession(modelFileFor(modelDir, stem).getFullPathName());

        Ort::AllocatorWithDefaultOptions allocator;
        const auto inputName = session.GetInputNameAllocated(0, allocator);
        const auto outputName = session.GetOutputNameAllocated(0, allocator);

        const int sourceIndex = sourceIndexForStem(stem);

        // Overlap-add accumulators: weighted sum per channel + the weight total.
        // float is ample here — each output sample is the sum of at most two
        // overlapping windows — and halves the bandwidth of this hot loop.
        std::vector<float> accLeft(static_cast<size_t>(numSamples), 0.0f);
        std::vector<float> accRight(static_cast<size_t>(numSamples), 0.0f);
        std::vector<float> weightSum(static_cast<size_t>(numSamples), 0.0f);

        // Reusable input tensor over a fixed-length, zero-padded window in
        // [ch0 samples..., ch1 samples...] layout.
        std::vector<float> inputData(static_cast<size_t>(kModelChannels) * kSegmentSamples, 0.0f);
        const std::array<int64_t, 3> inputShape{1, kModelChannels, kSegmentSamples};
        auto inputTensor = Ort::Value::CreateTensor<float>(
            memInfo, inputData.data(), inputData.size(), inputShape.data(), inputShape.size());

        // Reusable output buffer for the model's [1, sources, channels, segment]
        // tensor, bound once so ORT writes in place instead of allocating a fresh
        // ~21 MB output on every window. A shape mismatch surfaces as an
        // Ort::Exception from Run() and is reported as an inference failure.
        constexpr int kModelSources = 4;
        std::vector<float> outputData(static_cast<size_t>(kModelSources) *
                                      static_cast<size_t>(kModelChannels) * kSegmentSamples);
        const std::array<int64_t, 4> outputShape{1, kModelSources, kModelChannels, kSegmentSamples};
        auto outputTensor = Ort::Value::CreateTensor<float>(
            memInfo, outputData.data(), outputData.size(), outputShape.data(), outputShape.size());

        Ort::IoBinding binding(session);
        binding.BindInput(inputName.get(), inputTensor);
        binding.BindOutput(outputName.get(), outputTensor);

        // Offsets of source `sourceIndex`, channels 0/1 in the contiguous
        // [1, sources, channels, segment] output tensor.
        const auto channelStride = static_cast<size_t>(kSegmentSamples);
        const auto sourceStride = static_cast<size_t>(kModelChannels) * channelStride;
        const float* outLeft = outputData.data() + static_cast<size_t>(sourceIndex) * sourceStride;
        const float* outRight = outLeft + channelStride;

        for (size_t w = 0; w < offsets.size(); ++w)
        {
            if (shouldCancel()) throw StemSeparationError(StemFailureCode::Cancelled, "Cancelled");
            const int start = offsets[w];
            const int valid = std::min(kSegmentSamples, numSamples - start);

            // Only the final, partial window needs re-zeroing for its pad tail;
            // full windows are completely overwritten by the copy below.
            if (valid < kSegmentSamples) std::fill(inputData.begin(), inputData.end(), 0.0f);
            for (int ch = 0; ch < kModelChannels; ++ch)
            {
                const float* src = mixture.getReadPointer(ch) + start;
                std::copy_n(src, valid,
                            inputData.begin() + static_cast<size_t>(ch) * kSegmentSamples);
            }

            session.Run(Ort::RunOptions{nullptr}, binding);

            for (int i = 0; i < valid; ++i)
            {
                const float wgt = window[static_cast<size_t>(i)];
                const size_t pos = static_cast<size_t>(start + i);
                accLeft[pos] += wgt * outLeft[i];
                accRight[pos] += wgt * outRight[i];
                weightSum[pos] += wgt;
            }

            onProgress("separate",
                       stemBase + stemSpan * static_cast<double>(w + 1) / offsets.size(), stem);
        }

        juce::AudioBuffer<float> stemBuffer(kModelChannels, numSamples);
        float* left = stemBuffer.getWritePointer(0);
        float* right = stemBuffer.getWritePointer(1);
        for (int i = 0; i < numSamples; ++i)
        {
            const float denom = weightSum[static_cast<size_t>(i)];
            const float inv = denom > 0.0f ? 1.0f / denom : 0.0f;
            left[i] = accLeft[static_cast<size_t>(i)] * inv;
            right[i] = accRight[static_cast<size_t>(i)] * inv;
        }
        return stemBuffer;
    }

    // Build a session the first time a model is needed and reuse it for every
    // later job. Loading + graph-optimising each ~80 MB specialist is several
    // seconds, so caching removes that cost from the 2nd job onward. Safe without
    // locking: separations are single-slot (busyFlag) so this runs serially.
    Ort::Session& getOrCreateSession(const juce::String& modelPath)
    {
        const auto key = modelPath.toStdString();
        auto it = sessionCache.find(key);
        if (it == sessionCache.end())
            it = sessionCache
                     .emplace(key, std::make_unique<Ort::Session>(
                                       env, modelPath.toWideCharPointer(), sessionOptions))
                     .first;
        return *it->second;
    }

    Ort::Env env;
    Ort::SessionOptions sessionOptions;
    // Declared last so cached sessions are destroyed before `env`.
    std::map<std::string, std::unique_ptr<Ort::Session>> sessionCache;
};

} // namespace

std::unique_ptr<StemSeparator> makeOnnxStemSeparator()
{
    return std::make_unique<OnnxStemSeparator>();
}

} // namespace silverdaw
