#pragma once

// Backend stem-separation contract. `StemSeparator` is the seam between the
// bridge/job plumbing (engine + command, always built) and the heavy ONNX
// inference implementation (built only when SILVERDAW_ENABLE_STEM_SEPARATION is
// on). Keeping the interface free of any ONNX include lets the engine and its
// tests build and run with an injected fake separator on every platform.

#include <functional>
#include <memory>
#include <stdexcept>
#include <vector>

#include <juce_core/juce_core.h>

#include "VocalEnhancer.h"

#include "VocalDenoiser.h"

#include "DrumEnhancer.h"

#include "BassEnhancer.h"

#include "OtherEnhancer.h"

namespace silverdaw
{

enum class StemFailureCode
{
    Cancelled,
    Model,
    Decode,
    Inference,
    Io,
    Invalid
};

const char* stemFailureCodeToString(StemFailureCode code) noexcept;

// One separated source written to disk. `stem` is the canonical name
// (vocals/drums/bass/other) shared with the bridge schema.
struct StemResultFile
{
    juce::String stem;
    juce::File file;
};

struct StemSeparationResult
{
    std::vector<StemResultFile> stems;
};

// Immutable request handed to a worker. The command thread resolves every path
// before dispatch so the worker never touches the live ProjectState.
struct StemSeparationRequest
{
    juce::String jobId;
    juce::String clipId;
    // Human label surfaced in STEM_READY and used to name the output files.
    juce::String sourceName;
    // Resolved, decoded source audio to separate (never the user's original).
    juce::File sourceFile;
    // Optional source window (in source-file milliseconds) to separate. Used for
    // clip-scoped separation: only the timeline clip's portion of the source is
    // extracted, so the stem file is clip-length and drops in aligned to the clip.
    // `startMs` is the clip's in-point within the source; a `lengthMs` of 0 means
    // "to the end of the file" — i.e. separate the whole track (full-source stems).
    double startMs = 0.0;
    double lengthMs = 0.0;
    // Directory holding the four htdemucs-ft .onnx files.
    juce::File modelDir;
    // Optional Mel-Band RoFormer ("Vocal Quality Pack") .onnx core. When set and
    // its file exists, the VOCALS stem is produced by this higher-quality model
    // instead of the htdemucs vocal specialist; drums/bass still come from
    // htdemucs and `other` stays the residual. Empty = htdemucs vocals (default).
    juce::File roformerModelFile;
    // Optional 4-stem BS-RoFormer ("Rhythm Quality Pack") .onnx core. When set
    // and its file exists, the DRUMS and BASS stems are produced by this
    // higher-quality model (run once, both extracted) instead of the htdemucs
    // drums/bass specialists; vocals still come from htdemucs or the vocal pack,
    // and `other` stays the residual. Empty = htdemucs drums/bass (default).
    juce::File rhythmModelFile;
    // Directory the stems are written to (created by the command).
    juce::File outputDir;
    // Short unique token appended to each stem file's basename (a GUID) so
    // regenerating stems from the same source never overwrites earlier files,
    // and so each stem stays individually identifiable even if the temp workspace
    // is later merged into a saved project's Stems folder. Empty keeps the legacy
    // "<sourceName> - <stem>.wav" name.
    juce::String fileNameToken;
    // Canonical names of the stems the user chose to extract. Empty means all
    // four; implementations skip inference for any stem not listed.
    std::vector<juce::String> stems;
    // Overlap-add window overlap fraction in [0, 1). Higher overlaps the
    // inference windows more, smoothing segment seams at the cost of more
    // model runs (slower). Resolved from the requested quality preset by the
    // command layer; the default mirrors the "balanced" preset.
    double overlap = 0.25;
    // Test-time augmentation passes (the demucs `shifts` trick) applied to the
    // VOCALS stem only — vocals are the artefact-sensitive stem and shifting the
    // other specialists would multiply cost for little gain. Each extra shift is
    // one more full pass over the vocal model, so `shifts=4` is ~2x the whole job
    // (vocals is one of three model runs). 1 = single pass (no augmentation).
    // Resolved from the quality preset by the command layer.
    int shifts = 1;
    // Request GPU-accelerated inference. Honoured only when the backend was
    // built with a hardware-accelerated ONNX Runtime (SILVERDAW_ONNXRUNTIME_
    // DIRECTML); otherwise the separator logs once and runs on the CPU. The
    // command layer resolves this from the renderer's gated `stems.useGpu`
    // preference, so a machine without a GPU never sets it.
    bool useGpu = false;
    // Optional post-separation cleanup applied to the VOCALS stem only (other
    // stems are written untouched). Off by default; resolved by the command
    // layer from the `stems.enhanceVocals`/`stems.vocalEnhanceStrength`
    // preferences. Applied in OnnxStemSeparator after the vocal buffer is
    // denormalised and after it is accumulated for the `other` residual, so the
    // residual stays mixture-consistent against the unprocessed vocal.
    VocalEnhanceOptions vocalEnhance{};
    // Optional post-separation cleanup applied to the DRUMS stem only. Off by
    // default; resolved by the command layer from the `stems.enhanceDrums`/
    // `stems.drumEnhanceStrength` preferences. Applied in OnnxStemSeparator after
    // the drum buffer is denormalised and after it is accumulated for the `other`
    // residual, so the residual stays mixture-consistent against the unprocessed
    // drums.
    DrumEnhanceOptions drumEnhance{};
    // Optional post-separation cleanup applied to the BASS stem only. Off by
    // default; resolved by the command layer from the `stems.enhanceBass`/
    // `stems.bassEnhanceStrength` preferences. Applied in OnnxStemSeparator after
    // the bass buffer is denormalised and after it is accumulated for the `other`
    // residual, so the residual stays mixture-consistent against the unprocessed
    // bass.
    BassEnhanceOptions bassEnhance{};
    // Optional post-separation cleanup applied to the OTHER (residual) stem only.
    // Off by default; resolved by the command layer from the `stems.enhanceOther`/
    // `stems.otherEnhanceStrength` preferences. `other` is the last stem produced
    // and nothing downstream depends on it, so this is applied to the residual
    // buffer just before it is written.
    OtherEnhanceOptions otherEnhance{};
};

// Progress sink: stage is one of "prepare" / "separate" / "write"; percent 0..100.
// `detail` carries optional context for the current step (e.g. the stem name
// being separated) so the UI can show real per-stem progress; "" when n/a.
using StemProgressFn = std::function<void(const char* stage, double percent, const char* detail)>;
// Per-stem completion sink: invoked on the worker thread the instant a stem's
// WAV is written, so the UI can place its track while later stems still run.
// `stem` is the canonical name; `file` is the written WAV.
using StemReadyFn = std::function<void(const char* stem, const juce::File& file)>;
// Polled at safe points so a long separation can bail promptly on cancel.
using StemCancelFn = std::function<bool()>;

// Thrown by `separate` on any failure; the engine maps it to STEM_FAILED.
struct StemSeparationError : std::runtime_error
{
    StemSeparationError(StemFailureCode failureCode, const juce::String& message)
        : std::runtime_error(message.toStdString()), code(failureCode)
    {
    }

    StemFailureCode code;
};

class StemSeparator
{
  public:
    virtual ~StemSeparator() = default;

    // Runs synchronously on the caller's worker thread. Returns the written
    // stems on success or throws StemSeparationError. Implementations must poll
    // `shouldCancel` and throw StemSeparationError{Cancelled, ...} when set, and
    // call `onStemReady` immediately after each stem's file is written.
    virtual StemSeparationResult separate(const StemSeparationRequest& request,
                                          const StemProgressFn& onProgress,
                                          const StemReadyFn& onStemReady,
                                          const StemCancelFn& shouldCancel) = 0;
};

// Returns the ONNX-backed separator when built with stem separation enabled,
// otherwise a stub that fails fast with StemFailureCode::Model. Defined in
// StemSeparatorFactory.cpp so the selection lives in one guarded place.
std::unique_ptr<StemSeparator> createDefaultStemSeparator();

} // namespace silverdaw
