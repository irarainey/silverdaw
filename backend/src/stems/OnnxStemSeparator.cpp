#include "OnnxStemSeparator.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>

#include <onnxruntime_cxx_api.h>

#if defined(SILVERDAW_ONNXRUNTIME_DIRECTML)
// The DirectML execution provider factory ships only with a DirectML-enabled
// ONNX Runtime build. It is compiled in solely when the backend is built
// against such a runtime; the CPU runtime lacks this header.
#include <dml_provider_factory.h>
#endif

#include "Log.h"
#include "InferenceThreads.h"
#include "OnnxLogging.h"
#include "StemRunCancellation.h"
#include "StemShifts.h"
#include "BsRoformerRhythm.h"
#include "MelRoformerVocals.h"
#include "VocalDebleeder.h"
#include "Dereverberator.h"
#include "VocalRestorer.h"

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

// Progress-cost of a post-separation cleanup pass (denoise/enhance), relative to
// one specialist model run (= 1.0). Cleanup is far cheaper than inference, but
// NOT free — and crucially its cost is independent of whether the stem's
// separation was a full model run or cache-served. Weighting it separately gives
// a cache-served bass or residual `other` a visible progress band while ITS
// cleanup runs, instead of sharing the stem's near-zero separation band.
constexpr double kCleanupWeight = 0.15;

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
// fixed 44.1 kHz. An optional source-time window ([startMs, startMs+lengthMs) in
// the source file's own milliseconds; lengthMs <= 0 means "to the end") decodes
// only that portion, so clip-scoped separation produces clip-length stems.
// Throws StemSeparationError{Decode} on any read failure.
juce::AudioBuffer<float> decodeStereo44k(const juce::File& sourceFile, double startMs = 0.0,
                                         double lengthMs = 0.0)
{
    juce::AudioFormatManager formatManager;
    formatManager.registerBasicFormats();

    std::unique_ptr<juce::AudioFormatReader> reader(formatManager.createReaderFor(sourceFile));
    if (reader == nullptr)
        throw StemSeparationError(StemFailureCode::Decode,
                                  "Could not read source audio: " + sourceFile.getFullPathName());

    const auto totalLength = static_cast<juce::int64>(reader->lengthInSamples);
    if (totalLength <= 0)
        throw StemSeparationError(StemFailureCode::Decode, "Source audio is empty.");

    // Resolve the requested window into [startSample, startSample+numSamples) in the
    // reader's native sample rate, clamped to the file. A non-positive length spans
    // to the end (full-track separation).
    const double readerRate = reader->sampleRate > 0.0 ? reader->sampleRate : kModelSampleRate;
    juce::int64 startSample = startMs > 0.0
                                  ? static_cast<juce::int64>(startMs * readerRate / 1000.0)
                                  : 0;
    startSample = juce::jlimit<juce::int64>(0, totalLength, startSample);
    juce::int64 windowSamples = lengthMs > 0.0
                                    ? static_cast<juce::int64>(lengthMs * readerRate / 1000.0)
                                    : (totalLength - startSample);
    windowSamples = juce::jlimit<juce::int64>(0, totalLength - startSample, windowSamples);
    const auto sourceLength = static_cast<int>(windowSamples);
    if (sourceLength <= 0)
        throw StemSeparationError(StemFailureCode::Decode, "Selected source window is empty.");

    juce::AudioBuffer<float> decoded(kModelChannels, sourceLength);
    decoded.clear();
    reader->read(&decoded, 0, sourceLength, startSample, true, reader->numChannels > 1);
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
    std::unique_ptr<juce::OutputStream> stream(outputFile.createOutputStream());
    if (stream == nullptr)
        throw StemSeparationError(StemFailureCode::Io,
                                  "Could not open stem output: " + outputFile.getFullPathName());

    const auto writerOptions = juce::AudioFormatWriterOptions{}
                                   .withSampleRate(kModelSampleRate)
                                   .withNumChannels(kModelChannels)
                                   .withBitsPerSample(24);

    std::unique_ptr<juce::AudioFormatWriter> writer(wavFormat.createWriterFor(stream, writerOptions));
    if (writer == nullptr)
        throw StemSeparationError(StemFailureCode::Io,
                                  "Could not create WAV writer: " + outputFile.getFullPathName());

    // The writer took ownership of the stream on success.
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

#if defined(SILVERDAW_ONNXRUNTIME_DIRECTML)
// A DirectML GPU reset (Windows TDR) or driver fault mid-inference surfaces as an
// Ort::Exception whose message carries a DXGI device-removed/hung/reset HRESULT.
// Detect those so a job can transparently fall back to the CPU provider rather
// than failing outright.
bool isGpuDeviceLost(const Ort::Exception& e)
{
    const juce::String msg = juce::String(e.what()).toLowerCase();
    return msg.contains("device removed") || msg.contains("device hung") ||
           msg.contains("device reset") || msg.contains("device lost") ||
           msg.contains("dxgi_error_device") || msg.contains("887a00");
}

// Out of GPU memory (E_OUTOFMEMORY 0x8007000E / "not enough memory resources").
// Common on integrated GPUs, which share a limited slice of system memory: a
// large transformer MatMul can exceed the DirectML allocation budget. Treated as
// recoverable so the job retries on the CPU (ample system RAM) instead of failing.
bool isGpuOutOfMemory(const Ort::Exception& e)
{
    const juce::String msg = juce::String(e.what()).toLowerCase();
    return msg.contains("8007000e") || msg.contains("e_outofmemory") ||
           msg.contains("not enough memory") || msg.contains("out of memory");
}

// Any DirectML fault we can recover from by re-running the job on the CPU.
bool isRecoverableGpuFault(const Ort::Exception& e)
{
    return isGpuDeviceLost(e) || isGpuOutOfMemory(e);
}
#endif

class OnnxStemSeparator : public StemSeparator
{
  public:
    OnnxStemSeparator() : env(makeOrtEnv("silverdaw-stems"))
    {
        applyExecutionProvider(false);
    }

    StemSeparationResult separate(const StemSeparationRequest& request,
                                  const StemProgressFn& onProgress,
                                  const StemReadyFn& onStemReady,
                                  const StemCancelFn& shouldCancel) override
    {
        applyExecutionProvider(request.useGpu);

#if defined(SILVERDAW_ONNXRUNTIME_DIRECTML)
        // On a recoverable DirectML fault mid-inference — a GPU reset (Windows TDR)
        // or running out of (often shared, integrated-GPU) memory — transparently
        // retry the whole job on the CPU provider so the user still gets their stems
        // instead of a hard failure. The CPU provider never triggers TDR and draws
        // on ample system RAM, so a single fallback cannot loop. Already-written
        // stems are re-emitted; the renderer dedupes them per job, so the retry is
        // idempotent.
        if (epUsesGpu)
        {
            try
            {
                return runSeparation(request, onProgress, onStemReady, shouldCancel);
            }
            catch (const Ort::Exception& e)
            {
                if (! isRecoverableGpuFault(e)) throw;
                silverdaw::log::warn("stems",
                                     juce::String("GPU separation failed (") + e.what() +
                                         "); falling back to CPU and retrying.");
                applyExecutionProvider(false);
                // Force the whole retry — including the RoFormer packs, which
                // configure their own sessions from the request — onto the CPU,
                // otherwise they would reconfigure to the GPU and fault again.
                StemSeparationRequest cpuRequest = request;
                cpuRequest.useGpu = false;
                return runSeparation(cpuRequest, onProgress, onStemReady, shouldCancel);
            }
        }
#endif
        return runSeparation(request, onProgress, onStemReady, shouldCancel);
    }

  private:
    StemSeparationResult runSeparation(const StemSeparationRequest& request,
                                       const StemProgressFn& onProgress,
                                       const StemReadyFn& onStemReady,
                                       const StemCancelFn& shouldCancel)
    {
        onProgress("prepare", 0.0, "");

        // Which engine produces each stem. The optional RoFormer quality packs are
        // the primary engine when installed: vocals come from the vocal pack and
        // drums/bass from the 4-stem rhythm pack. htdemucs is the BACKUP — used per
        // stem only when that stem's pack is absent (or the renderer withheld it
        // because the user forced the backup model). `other` is the residual
        // mixture - (vocals + drums + bass) whenever all four stems are produced.
        const bool haveVocalPack = request.roformerModelFile != juce::File() &&
                                   request.roformerModelFile.existsAsFile();
        const bool haveRhythmPack = request.rhythmModelFile != juce::File() &&
                                    request.rhythmModelFile.existsAsFile();
        const auto isSelected = [&request](const char* stem)
        {
            if (request.stems.empty()) return true;
            return std::find(request.stems.begin(), request.stems.end(), juce::String(stem)) !=
                   request.stems.end();
        };
        const bool allFourSelected = isSelected("vocals") && isSelected("drums") &&
                                     isSelected("bass") && isSelected("other");

        // True when this stem will be produced by the htdemucs backup (so its
        // weight file must be present). `other` is covered by the residual when
        // all four stems are produced, so it only needs htdemucs on a partial
        // selection that still includes `other`.
        const auto stemUsesBackup = [&](const juce::String& s)
        {
            if (s == "vocals") return ! haveVocalPack;
            if (s == "drums" || s == "bass") return ! haveRhythmPack;
            if (s == "other") return ! allFourSelected;
            return true;
        };

        // Validate only the htdemucs weights actually needed: a fully pack-covered
        // run requires no htdemucs model on disk at all.
        for (const auto* stem : kStemNames)
        {
            if (! isSelected(stem) || ! stemUsesBackup(juce::String(stem))) continue;
            if (! modelFileFor(request.modelDir, stem).existsAsFile())
                throw StemSeparationError(StemFailureCode::Model,
                                          juce::String("Missing model weight: ") +
                                              modelFileFor(request.modelDir, stem).getFullPathName());
        }

        if (shouldCancel()) throw StemSeparationError(StemFailureCode::Cancelled, "Cancelled");

        auto mixture = decodeStereo44k(request.sourceFile, request.startMs, request.lengthMs);
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

        onProgress("prepare", kPreparePercent, "");

        StemSeparationResult result;
        const auto memInfo = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);

        // Only run the stems the user selected; an empty selection means all four.
        // Skipping a stem skips its specialist model entirely, so a partial
        // selection is proportionally faster. The progress band each stem occupies
        // is computed further down (stemBandBase / stemBandSpan), weighted by real
        // compute cost rather than split evenly — a naive even split makes the heavy
        // rhythm run (which yields drums AND bass in one pass) look stuck on drums
        // while bass then snaps instantly from its cache.

        // Residual-into-other mixture consistency: htdemucs-ft is a bag of four
        // INDEPENDENT specialists, so the stems don't reconstruct the mixture and
        // leave a residual of unclaimed signal. When the user is extracting all
        // four sources, synthesise `other` as the exact residual
        // mixture - (vocals + drums + bass) instead of running the other
        // specialist: this folds every unclaimed component back into the catch-all
        // stem (the full residual) and skips one model run. kStemNames lists
        // `other` last, so the three extracted sources are always summed first.
        // This is also what lets a fully pack-covered run need no htdemucs at all.
        const bool mixtureConsistency = allFourSelected;
        juce::AudioBuffer<float> extractedSum;
        if (mixtureConsistency)
        {
            extractedSum.setSize(kModelChannels, numSamples);
            extractedSum.clear();
        }

        // Rhythm pack (4-stem BS-RoFormer) produces drums AND bass from a single
        // model run, so run it lazily on the first of the two and cache both; the
        // second stem is then served from the cache without a second inference.
        const bool useRhythmPack = haveRhythmPack && (isSelected("drums") || isSelected("bass"));
        BsRoformerRhythmStems rhythmStems;
        bool rhythmDone = false;

        // Cascaded separation: when both quality packs are in play, subtract the
        // dedicated vocal pack's (high-SDR) vocal estimate from the mixture BEFORE
        // the rhythm pack runs, so residual vocal energy can't bleed into drums /
        // bass. The vocal is captured (unprocessed, at mixture level) the instant
        // it is produced for output; if the user did not request vocals we run one
        // internal vocal pass solely for this cancellation. Only meaningful when
        // both RoFormer packs are active — the htdemucs backup path is unchanged.
        const bool removeVocalsBeforeRhythm = haveVocalPack && useRhythmPack;
        juce::AudioBuffer<float> vocalForRemoval;
        bool vocalForRemovalReady = false;

        // Whether a given stem has its optional post-separation cleanup enabled.
        const auto cleanupEnabledFor = [&request](const juce::String& st) -> bool
        {
            // Vocals also reserve a cleanup band for the per-run dereverb pass, so the
            // progress bar advances even when only dereverb (not enhance) is enabled.
            if (st == "vocals") return request.vocalEnhance.enabled || request.dereverb.enabled;
            if (st == "drums") return request.drumEnhance.enabled;
            if (st == "bass") return request.bassEnhance.enabled;
            if (st == "other") return request.otherEnhance.enabled;
            return false;
        };

        // Progress bands weighted by each stem's real compute cost, so the bar
        // advances in proportion to the work actually happening. A specialist model
        // run costs ~1 unit; the rhythm pack yields drums AND bass from a SINGLE run
        // (billed to whichever is processed first) so the second is cache-served for
        // ~nothing, and the residual `other` is a cheap subtraction. Each enabled
        // cleanup adds its own fixed cost, INDEPENDENT of the separation cost — so a
        // cache-served bass or a residual `other` still gets a visible band while
        // ITS cleanup runs (they previously shared a near-zero band and the bar
        // looked stuck while cleanup churned).
        std::array<double, kStemNames.size()> sepWeight{};
        std::array<double, kStemNames.size()> cleanupWeight{};
        for (size_t s = 0; s < kStemNames.size(); ++s)
        {
            if (! isSelected(kStemNames[s])) continue;
            const juce::String st(kStemNames[s]);
            double sep = 1.0; // a specialist model run
            if (st == "vocals")
                sep = haveVocalPack ? 1.0 : static_cast<double>(std::max(1, request.shifts));
            else if ((st == "drums" || st == "bass") && useRhythmPack)
            {
                const bool carriesRhythmRun = (st == "drums") || ! isSelected("drums");
                if (carriesRhythmRun)
                {
                    sep = 1.0; // the single drums+bass rhythm run
                    if (removeVocalsBeforeRhythm && ! isSelected("vocals"))
                        sep += 1.0; // plus an internal vocal pass purely for de-bleeding
                }
                else
                    sep = 0.02; // served from the rhythm cache — effectively instant
            }
            else if (st == "other" && mixtureConsistency)
                sep = 0.05; // residual synthesis — a quick subtraction, no model run
            sepWeight[s] = sep;
            cleanupWeight[s] = cleanupEnabledFor(st) ? kCleanupWeight : 0.0;
        }
        double totalWeight = 0.0;
        for (size_t s = 0; s < kStemNames.size(); ++s) totalWeight += sepWeight[s] + cleanupWeight[s];
        if (totalWeight <= 0.0) totalWeight = 1.0;

        const double separateSpan = kSeparatePercent - kPreparePercent;
        std::array<double, kStemNames.size()> stemBandBase{};
        std::array<double, kStemNames.size()> stemBandSpan{};
        std::array<double, kStemNames.size()> stemCleanupSpan{};
        {
            double acc = 0.0;
            for (size_t s = 0; s < kStemNames.size(); ++s)
            {
                const double w = sepWeight[s] + cleanupWeight[s];
                stemBandBase[s] = kPreparePercent + separateSpan * (acc / totalWeight);
                stemBandSpan[s] = separateSpan * (w / totalWeight);
                // The cleanup pass owns its cost-proportional tail of the band.
                stemCleanupSpan[s] = w > 0.0 ? stemBandSpan[s] * (cleanupWeight[s] / w) : 0.0;
                acc += w;
            }
        }

        // Build the raw (denormalised) stereo mixture the RoFormer packs consume.
        const auto buildRawMix = [&]() {
            juce::AudioBuffer<float> raw(kModelChannels, numSamples);
            for (int ch = 0; ch < kModelChannels; ++ch)
            {
                const float* mix = mixture.getReadPointer(ch);
                float* d = raw.getWritePointer(ch);
                for (int i = 0; i < numSamples; ++i)
                    d[i] = mix[i] * norm.std + norm.mean;
            }
            return raw;
        };

        for (size_t s = 0; s < kStemNames.size(); ++s)
        {
            const auto* stem = kStemNames[s];
            if (! isSelected(stem)) continue;
            if (shouldCancel()) throw StemSeparationError(StemFailureCode::Cancelled, "Cancelled");
            const double stemBase = stemBandBase[s];
            const double stemSpan = stemBandSpan[s];
            onProgress("separate", stemBase, stem);

            // The cleanup pass (if any) owns the cost-proportional tail of this
            // stem's band, so the bar keeps advancing while the enhancer/denoiser
            // runs — even for a cache-served stem whose separation was instant.
            const double cleanupSpan = stemCleanupSpan[s];
            const double sepSpan = stemSpan - cleanupSpan;
            const double cleanupBase = stemBase + sepSpan;

            const bool synthesiseResidual = mixtureConsistency && juce::String(stem) == "other";

            juce::AudioBuffer<float> stemBuffer;
            if (synthesiseResidual)
            {
                // other = mixture - Σ(extracted stems). The accumulated sum is in
                // the time (denormalised) domain, so undo the mixture's
                // normalisation on the fly to subtract in the same domain.
                stemBuffer.setSize(kModelChannels, numSamples);
                for (int ch = 0; ch < kModelChannels; ++ch)
                {
                    const float* mix = mixture.getReadPointer(ch);
                    const float* sum = extractedSum.getReadPointer(ch);
                    float* d = stemBuffer.getWritePointer(ch);
                    for (int i = 0; i < numSamples; ++i)
                        d[i] = (mix[i] * norm.std + norm.mean) - sum[i];
                }
                // The residual is synthesised in one quick pass (no per-window
                // ticks), so close out its separation band explicitly.
                onProgress("separate", cleanupBase, stem);
            }
            else
            {
                const bool useRoformerVocals = juce::String(stem) == "vocals" && haveVocalPack;
                if (useRoformerVocals)
                {
                    // Mel-Band RoFormer vocal pack: separate from the RAW (denormalised)
                    // mixture in its own peak-normalised domain; it returns the vocal at
                    // the mixture's level, so no further denormalisation is needed.
                    auto rawMix = buildRawMix();
                    silverdaw::log::info("stems", "vocals via Mel-Band RoFormer pack");
                    stemBuffer = roformerVocals.separate(
                        request.roformerModelFile, rawMix, request.useGpu, overlap,
                        [&](double f) { onProgress("separate", stemBase + sepSpan * f, stem); },
                        shouldCancel);

                    // Capture this (unprocessed) vocal so the rhythm pack can be fed
                    // a vocal-removed mixture — cleanup runs later and must not alter
                    // the estimate used for cancellation.
                    if (removeVocalsBeforeRhythm)
                    {
                        vocalForRemoval.makeCopyOf(stemBuffer);
                        vocalForRemovalReady = true;
                    }
                }
                else if (useRhythmPack && (juce::String(stem) == "drums" ||
                                           juce::String(stem) == "bass"))
                {
                    // 4-stem BS-RoFormer rhythm pack: one model run yields drums +
                    // bass at the mixture's level (no further denormalisation needed);
                    // both stems are cached. When the vocal pack is also active the
                    // pack is fed `mixture - vocal` so vocal energy can't bleed into
                    // drums / bass (cascaded separation).
                    if (! rhythmDone)
                    {
                        auto rawMix = buildRawMix();
                        double rhythmBase = stemBase;
                        double rhythmSpan = sepSpan;
                        juce::AudioBuffer<float> rhythmInput;

                        if (removeVocalsBeforeRhythm)
                        {
                            // Need a vocal estimate to subtract. Normally captured
                            // from the vocals output above; if vocals wasn't selected,
                            // run one internal vocal pass (front 40% of the band).
                            if (! vocalForRemovalReady)
                            {
                                const double vocalSpan = sepSpan * 0.4;
                                silverdaw::log::info("stems",
                                    "pre-removing vocals for rhythm (internal vocal pass)");
                                vocalForRemoval = roformerVocals.separate(
                                    request.roformerModelFile, rawMix, request.useGpu, overlap,
                                    [&](double f) { onProgress("separate", stemBase + vocalSpan * f, stem); },
                                    shouldCancel);
                                vocalForRemovalReady = true;
                                rhythmBase = stemBase + vocalSpan;
                                rhythmSpan = sepSpan - vocalSpan;
                            }
                            rhythmInput.setSize(kModelChannels, numSamples);
                            for (int ch = 0; ch < kModelChannels; ++ch)
                            {
                                const float* raw = rawMix.getReadPointer(ch);
                                const float* voc = vocalForRemoval.getReadPointer(ch);
                                float* d = rhythmInput.getWritePointer(ch);
                                for (int i = 0; i < numSamples; ++i)
                                    d[i] = raw[i] - voc[i];
                            }
                            silverdaw::log::info("stems",
                                "drums/bass via BS-RoFormer rhythm pack (vocal-removed input)");
                        }
                        else
                        {
                            rhythmInput = std::move(rawMix);
                            silverdaw::log::info("stems", "drums/bass via BS-RoFormer rhythm pack");
                        }

                        // The rhythm run produces drums AND bass in one pass; label
                        // its progress for both so the long phase reads as drums+bass
                        // work rather than appearing to skip bass (bass separation is
                        // then cache-served instantly on its own iteration).
                        const char* rhythmDetail =
                            (isSelected("drums") && isSelected("bass")) ? "drums+bass" : stem;
                        rhythmStems = roformerRhythm.separate(
                            request.rhythmModelFile, rhythmInput, request.useGpu, overlap,
                            [&](double f) { onProgress("separate", rhythmBase + rhythmSpan * f, rhythmDetail); },
                            shouldCancel);
                        rhythmDone = true;
                    }
                    stemBuffer = juce::String(stem) == "drums" ? rhythmStems.drums
                                                               : rhythmStems.bass;
                }
                else
                {
                    // Vocals get test-time augmentation (shifts) in "best" quality;
                    // every other specialist runs single-pass (shifts=1).
                    const int stemShifts = juce::String(stem) == "vocals" ? std::max(1, request.shifts) : 1;
                    stemBuffer = separateOneStem(request.modelDir, stem, mixture, numSamples, window,
                                                 stride, stemShifts, memInfo, onProgress, shouldCancel,
                                                 stemBase, sepSpan);

                    // Undo the per-track normalisation applied before inference.
                    for (int ch = 0; ch < kModelChannels; ++ch)
                    {
                        float* d = stemBuffer.getWritePointer(ch);
                        for (int i = 0; i < numSamples; ++i)
                            d[i] = d[i] * norm.std + norm.mean;
                    }
                }

                // Accumulate the extracted (denormalised) sources so `other` can be
                // built as the residual once the three specialists have run.
                if (mixtureConsistency)
                {
                    for (int ch = 0; ch < kModelChannels; ++ch)
                    {
                        const float* src = stemBuffer.getReadPointer(ch);
                        float* acc = extractedSum.getWritePointer(ch);
                        for (int i = 0; i < numSamples; ++i)
                            acc[i] += src[i];
                    }
                }
            }

            const auto stemBaseName = request.fileNameToken.isNotEmpty()
                ? request.sourceName + " - " + stem + " - " + request.fileNameToken
                : request.sourceName + " - " + stem;
            const auto outFile = request.outputDir.getChildFile(
                juce::File::createLegalFileName(stemBaseName + ".wav"));
            // Optional vocal cleanup. Applied only to the vocals stem and only
            // after the (unprocessed) vocal has been folded into `extractedSum`,
            // so the `other` residual stays mixture-consistent. RNNoise removes
            // broadband noise/separation artefacts; the high-pass + expander
            // stage then pushes down residual sub-bass and inter-phrase bleed.
            if (juce::String(stem) == "vocals"
                && (request.vocalEnhance.enabled || request.dereverb.enabled))
            {
                // The RoFormer vocal pack produces a high-SDR stem; the enhance cleanup
                // (tuned for the dirtier htdemucs vocal) is gentled for it — the cross-stem
                // de-bleed is skipped entirely (it would gut a clean vocal on dense mixes)
                // and the denoise / expander run softened. Dereverb is a per-run choice,
                // independent of the enhance toggle, so the two are gated separately here.
                const bool vocalFromRoformer = haveVocalPack;
                onProgress("cleanup", cleanupBase, stem);

                // Progress split: dereverb and the RNNoise denoise are the two heavy passes;
                // each owns a share of the first 90% of the reserved band, the expander the tail.
                const double dereverbBand =
                    request.dereverb.enabled ? (request.vocalEnhance.enabled ? 0.45 : 0.90) : 0.0;
                const double denoiseStart = cleanupBase + cleanupSpan * dereverbBand;
                const double denoiseBand =
                    request.vocalEnhance.enabled ? (0.90 - dereverbBand) : 0.0;

                // Cross-stem de-bleed (htdemucs enhance path only): push down pitched
                // instrument bleed using instrumental = mixture - vocal. Runs BEFORE dereverb
                // so the reverb estimate isn't contaminated by other instruments' tails, and
                // because de-bleed is frame-independent (it needs no envelope of its own).
                if (request.vocalEnhance.enabled && ! vocalFromRoformer)
                {
                    juce::AudioBuffer<float> instrumental(kModelChannels, numSamples);
                    for (int ch = 0; ch < kModelChannels; ++ch)
                    {
                        const float* mix = mixture.getReadPointer(ch);
                        const float* voc = stemBuffer.getReadPointer(ch);
                        float* ins = instrumental.getWritePointer(ch);
                        for (int i = 0; i < numSamples; ++i)
                            ins[i] = (mix[i] * norm.std + norm.mean) - voc[i];
                    }
                    VocalDebleeder::process(stemBuffer, instrumental, kModelSampleRate,
                                            request.vocalEnhance.strength);
                }

                // Reverb/echo reduction (per-run). Before the denoise: RNNoise is trained on
                // dry speech, so tightening the reverberant envelope first helps it.
                //
                // Capture the vocal's active loudness BEFORE de-reverb so the final
                // VocalRestorer stage can match it back — spectral subtraction removes
                // energy and leaves the stem noticeably quieter, and matching the
                // loud-frame loudness (not the reverb-filled gaps) restores the level
                // without re-inflating the tail we just removed.
                float vocalRefLevel = 0.0f;
                if (request.dereverb.enabled)
                {
                    vocalRefLevel = VocalRestorer::activeLoudness(stemBuffer, kModelSampleRate);
                    silverdaw::log::info("stems",
                                         juce::String("applied vocal dereverb strength=")
                                             + dereverbStrengthToString(request.dereverb.strength));
                    Dereverberator::process(
                        stemBuffer, kModelSampleRate, request.dereverb.strength,
                        [&](double f) {
                            onProgress("cleanup", cleanupBase + cleanupSpan * dereverbBand * f, stem);
                        });
                }

                // RNNoise denoise + sub-bass high-pass / expander (enhance path only).
                if (request.vocalEnhance.enabled)
                {
                    auto vocalOpts = request.vocalEnhance;
                    vocalOpts.cleanModel = vocalFromRoformer;
                    const float wet = vocalDenoiseWetFor(request.vocalEnhance.strength, vocalFromRoformer);
                    silverdaw::log::info("stems",
                                         juce::String("applied vocal cleanup strength=")
                                             + vocalEnhanceStrengthToString(request.vocalEnhance.strength)
                                             + (vocalFromRoformer ? " (clean-model: de-bleed skipped)" : "")
                                             + " denoiseWet=" + juce::String(wet, 2));
                    VocalDenoiser::process(
                        stemBuffer, kModelSampleRate, wet,
                        [&](double f) {
                            onProgress("cleanup", denoiseStart + cleanupSpan * denoiseBand * f, stem);
                        });
                    VocalEnhancer::process(stemBuffer, kModelSampleRate, vocalOpts);
                }

                // Final polish (per-run de-reverb only): restore the presence and
                // level that spectral subtraction strips out, so the de-reverbed
                // vocal isn't dull/flat OR quieter. Runs LAST — after the denoise +
                // expander have cleaned the vocal — so the shelves brighten the clean
                // signal rather than musical noise, and the level match sits after the
                // expander so it can't lift the floor back over the expander threshold.
                if (request.dereverb.enabled)
                {
                    const auto restore = VocalRestorer::process(
                        stemBuffer, kModelSampleRate, request.dereverb.strength, vocalRefLevel);
                    silverdaw::log::info(
                        "stems",
                        juce::String("applied vocal restore ref=") + juce::String(restore.referenceLevel, 4)
                            + " proc=" + juce::String(restore.processedLevel, 4)
                            + " makeup=" + juce::String(restore.makeupDb, 2) + "dB"
                            + (restore.clamped ? " (clamped)" : ""));
                }
                onProgress("cleanup", stemBase + stemSpan, stem);
            }
            // Optional drum cleanup. Same contract: drums only, applied after the
            // raw drum buffer has been folded into the residual sum.
            if (request.drumEnhance.enabled && juce::String(stem) == "drums")
            {
                // Gentled when the drums came from the RoFormer rhythm pack.
                auto drumOpts = request.drumEnhance;
                drumOpts.cleanModel = useRhythmPack;
                silverdaw::log::info("stems",
                                     juce::String("applied drum cleanup strength=")
                                         + drumEnhanceStrengthToString(request.drumEnhance.strength)
                                         + (drumOpts.cleanModel ? " (clean-model)" : ""));
                onProgress("cleanup", cleanupBase, stem);
                DrumEnhancer::process(stemBuffer, kModelSampleRate, drumOpts);
                onProgress("cleanup", stemBase + stemSpan, stem);
            }
            // Optional bass cleanup. Same contract: bass only, applied after the
            // raw bass buffer has been folded into the residual sum.
            if (request.bassEnhance.enabled && juce::String(stem) == "bass")
            {
                // Gentled when the bass came from the RoFormer rhythm pack.
                auto bassOpts = request.bassEnhance;
                bassOpts.cleanModel = useRhythmPack;
                silverdaw::log::info("stems",
                                     juce::String("applied bass cleanup strength=")
                                         + bassEnhanceStrengthToString(request.bassEnhance.strength)
                                         + (bassOpts.cleanModel ? " (clean-model)" : ""));
                onProgress("cleanup", cleanupBase, stem);
                BassEnhancer::process(stemBuffer, kModelSampleRate, bassOpts);
                onProgress("cleanup", stemBase + stemSpan, stem);
            }
            // Optional residual cleanup. Applied to the synthesised `other` stem
            // only, just before it is written (nothing downstream depends on it).
            if (request.otherEnhance.enabled && juce::String(stem) == "other")
            {
                // The residual is clean when built from a full RoFormer hybrid
                // (clean vocals + rhythm), so gentle the widener / spectral pass.
                auto otherOpts = request.otherEnhance;
                otherOpts.cleanModel = mixtureConsistency && haveVocalPack && haveRhythmPack;
                silverdaw::log::info("stems",
                                     juce::String("applied other cleanup strength=")
                                         + otherEnhanceStrengthToString(request.otherEnhance.strength)
                                         + (otherOpts.cleanModel ? " (clean-model)" : ""));
                onProgress("cleanup", cleanupBase, stem);
                OtherEnhancer::process(stemBuffer, kModelSampleRate, otherOpts);
                onProgress("cleanup", stemBase + stemSpan, stem);
            }
            writeStemWav(outFile, stemBuffer);
            result.stems.push_back({juce::String(stem), outFile});
            // Let the UI import this stem now, before later stems finish.
            onStemReady(stem, outFile);
        }

        onProgress("write", 100.0, "");
        return result;
    }

  private:
    // Run one specialist model over a track and reconstruct its source via
    // weighted overlap-add. When `shifts > 1` (vocals, "best" quality) the model
    // is also run on a few small leading-zero time-shifts of the input and the
    // realigned outputs are averaged — the demucs `shifts` trick, which cancels
    // the translation-variance phase/edge artefacts on the stem. `shifts = 1` is
    // the plain single pass. Input mixture is already normalised.
    juce::AudioBuffer<float> separateOneStem(const juce::File& modelDir, const char* stem,
                                             const juce::AudioBuffer<float>& mixture, int numSamples,
                                             const std::vector<float>& window, int stride, int shifts,
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

        // Deterministic shift offsets (always includes 0). Up to 0.5 s, matching
        // demucs' max_shift; for shifts=1 this is just {0} (single pass).
        const auto shiftOffsets = shiftOffsetsFor(shifts, kModelSampleRate / 2);

        // Final per-shift-averaged accumulators for the un-shifted output.
        std::vector<float> finalLeft(static_cast<size_t>(numSamples), 0.0f);
        std::vector<float> finalRight(static_cast<size_t>(numSamples), 0.0f);

        // Total model runs across all shifts, for a smooth progress bar.
        long long totalWindows = 0;
        for (int sh : shiftOffsets)
            totalWindows += (static_cast<long long>(numSamples + sh) + stride - 1) / stride;
        long long windowsDone = 0;

        for (int sh : shiftOffsets)
        {
            // The shifted signal has `sh` leading zeros, so content[idx] =
            // mixture[idx - sh] for idx >= sh, and the timeline is `sh` longer.
            const int effLen = numSamples + sh;
            std::vector<float> accLeft(static_cast<size_t>(effLen), 0.0f);
            std::vector<float> accRight(static_cast<size_t>(effLen), 0.0f);
            std::vector<float> weightSum(static_cast<size_t>(effLen), 0.0f);

            for (int start = 0; start < effLen; start += stride)
            {
                if (shouldCancel()) throw StemSeparationError(StemFailureCode::Cancelled, "Cancelled");
                const int valid = std::min(kSegmentSamples, effLen - start);

                // Real (non-zero) content within this window is [contentBegin,
                // contentEnd) in shifted-timeline coords. Anything outside (the
                // leading zero-pad or the final partial tail) stays silent.
                const int contentBegin = std::max(start, sh);
                const int contentEnd = start + valid;
                const int contentLen = std::max(0, contentEnd - contentBegin);
                if (contentLen < kSegmentSamples) std::fill(inputData.begin(), inputData.end(), 0.0f);
                for (int ch = 0; ch < kModelChannels; ++ch)
                {
                    if (contentLen <= 0) continue;
                    const float* src = mixture.getReadPointer(ch) + (contentBegin - sh);
                    std::copy_n(src, contentLen,
                                inputData.begin() + static_cast<size_t>(ch) * kSegmentSamples +
                                    static_cast<size_t>(contentBegin - start));
                }

                stems::runCancellable(shouldCancel, [&](Ort::RunOptions& runOptions) {
                    session.Run(runOptions, binding);
                });

                for (int i = 0; i < valid; ++i)
                {
                    const float wgt = window[static_cast<size_t>(i)];
                    const size_t pos = static_cast<size_t>(start + i);
                    accLeft[pos] += wgt * outLeft[i];
                    accRight[pos] += wgt * outRight[i];
                    weightSum[pos] += wgt;
                }

                ++windowsDone;
                onProgress("separate",
                           stemBase + stemSpan * static_cast<double>(windowsDone) /
                                          static_cast<double>(std::max<long long>(1, totalWindows)),
                           stem);
            }

            // Normalise this shift's overlap-add and fold it into the average,
            // dropping the `sh` leading-zero samples to realign with the output.
            for (int i = 0; i < numSamples; ++i)
            {
                const size_t pos = static_cast<size_t>(i + sh);
                const float denom = weightSum[pos];
                const float inv = denom > 0.0f ? 1.0f / denom : 0.0f;
                finalLeft[static_cast<size_t>(i)] += accLeft[pos] * inv;
                finalRight[static_cast<size_t>(i)] += accRight[pos] * inv;
            }
        }

        const float shiftNorm = 1.0f / static_cast<float>(std::max<size_t>(1, shiftOffsets.size()));
        juce::AudioBuffer<float> stemBuffer(kModelChannels, numSamples);
        float* left = stemBuffer.getWritePointer(0);
        float* right = stemBuffer.getWritePointer(1);
        for (int i = 0; i < numSamples; ++i)
        {
            left[i] = finalLeft[static_cast<size_t>(i)] * shiftNorm;
            right[i] = finalRight[static_cast<size_t>(i)] * shiftNorm;
        }
        return stemBuffer;
    }

    // Configure the session options' execution provider for the requested mode,
    // rebuilding only when it changes. Switching providers invalidates any cached
    // sessions (they were optimised for the previous provider), so the cache is
    // cleared. Separations are single-slot (busyFlag), so this runs serially with
    // no concurrent session use.
    void applyExecutionProvider(bool useGpu)
    {
        if (epConfigured && epUsesGpu == useGpu) return;

        sessionCache.clear();
        sessionOptions = Ort::SessionOptions{};
        // Inference runs on a small pool of physical performance cores (see
        // InferenceThreads.h), which by design leaves the E-cores / hyperthread
        // siblings free for this backend's websocket-send and message threads —
        // so progress keeps flowing and cancellation stays responsive WITHOUT
        // hobbling throughput. Spinning is therefore left at its default (enabled):
        // the many-op transformer graph pays per-op thread wake latency with
        // spinning off, and the reserved-core starvation that once justified
        // disabling it no longer exists. Cancellation now also terminates the
        // in-flight run directly (StemRunCancellation.h) rather than relying on a
        // spare polling core.
        const int intraOpThreads = stems::inferenceIntraOpThreads();
        sessionOptions.SetIntraOpNumThreads(intraOpThreads);
        sessionOptions.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);

        if (useGpu)
        {
#if defined(SILVERDAW_ONNXRUNTIME_DIRECTML)
            // DirectML requires sequential execution and disabled memory pattern
            // optimisation; the EP itself is vendor-generic (any DirectX 12 GPU).
            sessionOptions.DisableMemPattern();
            sessionOptions.SetExecutionMode(ORT_SEQUENTIAL);
            // htdemucs uses dynamic tensor shapes, which DirectML's whole-graph
            // fusion cannot compile (it throws E_INVALIDARG / "parameter is
            // incorrect" in DmlGraphFusionHelper at session init). Disabling
            // graph fusion makes the DML EP execute node-by-node instead — still
            // GPU-accelerated, just without the fused-graph optimisation.
            sessionOptions.AddConfigEntry("ep.dml.disable_graph_fusion", "1");
            Ort::ThrowOnError(OrtSessionOptionsAppendExecutionProvider_DML(sessionOptions, 0));
            silverdaw::log::info("stems", "ONNX execution provider: DirectML (GPU)");
#else
            // The bundled runtime is CPU-only: honour the request as best we can
            // (run on the CPU) and say so once rather than failing the job.
            silverdaw::log::info(
                "stems",
                "GPU separation requested but this build ships the CPU ONNX Runtime; running on CPU.");
#endif
        }
        else
        {
            silverdaw::log::info(
                "stems",
                "ONNX execution provider: CPU (" + juce::String(intraOpThreads) + " intra-op threads)");
        }

        epUsesGpu = useGpu;
        epConfigured = true;
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
    bool epConfigured = false;
    bool epUsesGpu = false;
    // Declared last so cached sessions are destroyed before `env`.
    std::map<std::string, std::unique_ptr<Ort::Session>> sessionCache;

    // Optional Mel-Band RoFormer vocal pack (owns its own ONNX session); used
    // only when a request supplies a RoFormer model file.
    MelRoformerVocals roformerVocals;

    // Optional 4-stem BS-RoFormer rhythm pack (owns its own ONNX session); used
    // only when a request supplies a rhythm model file. Produces drums + bass.
    BsRoformerRhythm roformerRhythm;
};

} // namespace

std::unique_ptr<StemSeparator> makeOnnxStemSeparator()
{
    return std::make_unique<OnnxStemSeparator>();
}

} // namespace silverdaw
