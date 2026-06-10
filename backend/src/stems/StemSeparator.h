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
    // Directory holding the four htdemucs-ft .onnx files.
    juce::File modelDir;
    // Directory the stems are written to (created by the command).
    juce::File outputDir;
    // Canonical names of the stems the user chose to extract. Empty means all
    // four; implementations skip inference for any stem not listed.
    std::vector<juce::String> stems;
    // Overlap-add window overlap fraction in [0, 1). Higher overlaps the
    // inference windows more, smoothing segment seams at the cost of more
    // model runs (slower). Resolved from the requested quality preset by the
    // command layer; the default mirrors the "balanced" preset.
    double overlap = 0.25;
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
