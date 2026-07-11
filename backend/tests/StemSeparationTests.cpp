// Stem-separation wiring tests: failure-code mapping, the background job's
// busy-flag / cancel lifecycle against an injected fake separator, and the
// default separator's fail-fast contract. The real ONNX inference is exercised
// elsewhere (it needs the model + audio); here we prove the plumbing.

#include "TestRegistry.h"

#include <atomic>
#include <cmath>
#include <vector>

#include "BridgeServer.h"
#include "ChannelSplitDsp.h"
#include "ProjectSession.h"
#include "StemSeparationCommands.h"
#include "StemSeparationEngine.h"
#include "StemSeparator.h"
#include "StemShifts.h"
#include "StemMetrics.h"
#include "StemAudioPreparation.h"
#include "StemGpuFallback.h"
#include "StemProgressCoalescer.h"
#include "StemVocalCleanup.h"
#if defined(SILVERDAW_STEM_SEPARATION)
#include "StemRhythmOverlap.h"
#endif

namespace silverdaw::tests
{
namespace
{

silverdaw::BridgeServer makeSilentBridge()
{
    return silverdaw::BridgeServer(
        "test-token", [](silverdaw::BridgeServer&, const juce::String&, const juce::var&) {});
}

// Records how it was driven and writes a placeholder stem so the result paths
// are real files, mirroring what the ONNX separator produces.
class FakeSeparator : public silverdaw::StemSeparator
{
  public:
    int calls = 0;
    bool sawProgress = false;
    bool sawStemReady = false;
    bool cancelObserved = false;

    silverdaw::StemSeparationResult separate(const silverdaw::StemSeparationRequest& request,
                                             const silverdaw::StemProgressFn& onProgress,
                                             const silverdaw::StemReadyFn& onStemReady,
                                             const silverdaw::StemCancelFn& shouldCancel) override
    {
        ++calls;
        onProgress("prepare", 0.0, "");
        sawProgress = true;
        if (shouldCancel())
        {
            cancelObserved = true;
            throw silverdaw::StemSeparationError(silverdaw::StemFailureCode::Cancelled, "Cancelled");
        }

        silverdaw::StemSeparationResult result;
        const auto file = request.outputDir.getChildFile("vocals.wav");
        file.create();
        const silverdaw::StemResultFile stem{juce::String("vocals"), file, 44100.0, 1000.0, 2};
        onStemReady(stem);
        sawStemReady = true;
        result.stems.push_back(stem);
        return result;
    }
};

silverdaw::StemSeparationRequest makeRequest(const juce::File& outputDir)
{
    silverdaw::StemSeparationRequest request;
    request.jobId = "job-1";
    request.clipId = "clip-1";
    request.sourceName = "Loop";
    request.outputDir = outputDir;
    return request;
}

void testFailureCodeStrings()
{
    requireEqual(silverdaw::stemFailureCodeToString(silverdaw::StemFailureCode::Cancelled),
                 "cancelled", "cancelled string");
    requireEqual(silverdaw::stemFailureCodeToString(silverdaw::StemFailureCode::Model), "model",
                 "model string");
    requireEqual(silverdaw::stemFailureCodeToString(silverdaw::StemFailureCode::Decode), "decode",
                 "decode string");
    requireEqual(silverdaw::stemFailureCodeToString(silverdaw::StemFailureCode::Inference),
                 "inference", "inference string");
    requireEqual(silverdaw::stemFailureCodeToString(silverdaw::StemFailureCode::Io), "io",
                 "io string");
    requireEqual(silverdaw::stemFailureCodeToString(silverdaw::StemFailureCode::Invalid), "invalid",
                 "invalid string");
}

void testJobRunsSeparatorAndClearsBusy()
{
    const auto dir = makeTempDir("stem-success");
    auto bridge = makeSilentBridge();
    FakeSeparator separator;
    std::atomic<bool> busy{true};
    std::atomic<bool> cancel{false};

    silverdaw::runStemSeparationJob(makeRequest(dir), separator, bridge, cancel, busy);

    require(separator.calls == 1, "separator invoked exactly once");
    require(separator.sawProgress, "progress callback fired");
    require(separator.sawStemReady, "per-stem ready callback fired");
    require(! busy.load(), "busy flag cleared after success");
    require(dir.getChildFile("vocals.wav").existsAsFile(), "stem file written");
}

void testJobPropagatesCancel()
{
    const auto dir = makeTempDir("stem-cancel");
    auto bridge = makeSilentBridge();
    FakeSeparator separator;
    std::atomic<bool> busy{true};
    std::atomic<bool> cancel{true};

    silverdaw::runStemSeparationJob(makeRequest(dir), separator, bridge, cancel, busy);

    require(separator.cancelObserved, "separator observed the cancel flag");
    require(! busy.load(), "busy flag cleared after cancel");
}

void testProgressCoalescing()
{
    silverdaw::StemProgressCoalescer coalescer;
    const auto start = silverdaw::StemProgressCoalescer::Clock::time_point{};

    require(coalescer.shouldEmitAt("separate", 10.0, "vocals", start),
            "first progress update is emitted");
    require(! coalescer.shouldEmitAt("separate", 11.0, "vocals",
                                     start + std::chrono::milliseconds(50)),
            "same-context progress is suppressed inside 100 ms");
    require(coalescer.shouldEmitAt("separate", 12.0, "vocals",
                                   start + std::chrono::milliseconds(100)),
            "latest progress is emitted after 100 ms");
    require(coalescer.shouldEmitAt("cleanup", 12.1, "vocals",
                                   start + std::chrono::milliseconds(101)),
            "stage changes are emitted immediately");
    require(coalescer.shouldEmitAt("cleanup", 12.2, "drums",
                                   start + std::chrono::milliseconds(102)),
            "detail changes are emitted immediately");
    require(coalescer.shouldEmitAt("cleanup", 100.0, "drums",
                                   start + std::chrono::milliseconds(103)),
            "terminal progress is emitted immediately");
}

void testGpuFallbackQuarantine()
{
    silverdaw::StemGpuFallbackState fallback;
    require(fallback.shouldUseGpu(true), "initial GPU request is honoured");
    require(! fallback.shouldUseGpu(false), "CPU request remains on CPU");

    fallback.quarantine();
    require(fallback.isQuarantined(), "recoverable failure quarantines the GPU");
    require(! fallback.shouldUseGpu(true), "later GPU requests route to CPU");
}

void testGpuFallbackRetryProgress()
{
    requireNear(silverdaw::mapStemRetryPercent(40.0, 0.0), 40.0, 1e-9,
                "CPU retry begins at the completed GPU percentage");
    requireNear(silverdaw::mapStemRetryPercent(40.0, 50.0), 70.0, 1e-9,
                "CPU retry maps into the remaining progress range");
    requireNear(silverdaw::mapStemRetryPercent(40.0, 100.0), 100.0, 1e-9,
                "CPU retry still ends at 100 percent");
}

void testGpuAttemptPublishesTransactionally()
{
    int published = 0;
    const silverdaw::StemResultFile stem{
        "vocals", juce::File("vocals.wav"), 44100.0, 1000.0, 2};

    {
        silverdaw::StemReadyTransaction failedAttempt(
            [&](const silverdaw::StemResultFile&) { ++published; });
        failedAttempt.stage(stem);
    }
    require(published == 0, "failed GPU attempt does not publish staged stems");

    silverdaw::StemReadyTransaction successfulAttempt(
        [&](const silverdaw::StemResultFile&) { ++published; });
    successfulAttempt.stage(stem);
    successfulAttempt.commit();
    require(published == 1, "successful GPU attempt publishes each staged stem");
}

void testRecoverableGpuFaultMessages()
{
    require(silverdaw::isRecoverableGpuFaultMessage("DXGI_ERROR_DEVICE_HUNG 0x887A0006"),
            "device loss is recoverable");
    require(silverdaw::isRecoverableGpuFaultMessage("E_OUTOFMEMORY 0x8007000E"),
            "GPU out of memory is recoverable");
    require(! silverdaw::isRecoverableGpuFaultMessage("Invalid model input dimensions"),
            "unrelated ONNX failures are not recoverable GPU faults");
    require(! silverdaw::isRecoverableGpuFaultMessage("Cancelled"),
            "cancellation does not quarantine the GPU");
}

void testStemMixtureDenormalisation()
{
    juce::AudioBuffer<float> normalised(2, 3);
    normalised.setSample(0, 0, -1.0f);
    normalised.setSample(0, 1, 0.0f);
    normalised.setSample(0, 2, 1.0f);
    normalised.setSample(1, 0, 0.25f);
    normalised.setSample(1, 1, -0.5f);
    normalised.setSample(1, 2, 0.75f);

    const auto raw = silverdaw::denormaliseStemMixture(normalised, 2, 0.1f, 2.0f);
    requireNear(raw.getSample(0, 0), -1.9, 1e-6, "left negative sample is preserved");
    requireNear(raw.getSample(0, 1), 0.1, 1e-6, "mean is restored");
    requireNear(raw.getSample(0, 2), 2.1, 1e-6, "left positive sample is preserved");
    requireNear(raw.getSample(1, 0), 0.6, 1e-6, "right sample is preserved");
    requireNear(raw.getSample(1, 1), -0.9, 1e-6, "right negative sample is preserved");
    requireNear(raw.getSample(1, 2), 1.6, 1e-6, "right positive sample is preserved");
}

void testVocalCleanupHonoursCancellation()
{
    juce::AudioBuffer<float> vocal(2, 64);
    juce::AudioBuffer<float> mixture(2, 64);
    silverdaw::StemSeparationRequest request;
    request.vocalEnhance.enabled = true;

    bool cancelled = false;
    try
    {
        silverdaw::processStemVocalCleanup(
            vocal, mixture, 0.0f, 1.0f, request, true, {}, [] { return true; });
    }
    catch (const silverdaw::StemSeparationError& error)
    {
        cancelled = error.code == silverdaw::StemFailureCode::Cancelled;
    }
    require(cancelled, "vocal cleanup stops before work when the job is cancelled");
}

#if defined(SILVERDAW_STEM_SEPARATION)
void testPendingVocalCleanupPublishesOnCaller()
{
    int published = 0;
    silverdaw::PendingStemVocalCleanup cleanup(
        [] { return false; },
        [&](const silverdaw::StemResultFile& stem)
        {
            requireEqual(stem.stem, "vocals", "pending cleanup publishes the vocal result");
            ++published;
        });
    cleanup.start(
        [](const silverdaw::StemCancelFn&)
        {
            return silverdaw::StemResultFile{
                "vocals", juce::File("vocals.wav"), 44100.0, 1000.0, 2};
        });

    require(published == 0, "worker completion does not publish from the worker thread");
    cleanup.publishIfReady(true);
    require(published == 1, "caller explicitly publishes the completed vocal");
    require(! cleanup.hasPending(), "published cleanup no longer remains pending");
}

void testPendingVocalCleanupAbortCancelsWorker()
{
    silverdaw::PendingStemVocalCleanup cleanup(
        [] { return false; }, [](const silverdaw::StemResultFile&) {});
    const auto cancellation = cleanup.cancellation();
    require(! cancellation(), "overlap cancellation starts clear");
    cleanup.abort();
    require(cancellation(), "aborting overlap is visible to worker cancellation");
}
#endif

void testRawStemMixturePlanning()
{
    require(! silverdaw::shouldBuildRawStemMixture(false, false, false),
            "backup-only separation skips the raw mixture");
    require(! silverdaw::shouldBuildRawStemMixture(true, false, false),
            "an installed but unused vocal pack skips the raw mixture");
    require(silverdaw::shouldBuildRawStemMixture(true, true, false),
            "selected RoFormer vocals require the raw mixture");
    require(silverdaw::shouldBuildRawStemMixture(false, false, true),
            "selected RoFormer rhythm requires the raw mixture");
}

void testDefaultSeparatorFailsFastWithoutModel()
{
    auto separator = silverdaw::createDefaultStemSeparator();
    require(separator != nullptr, "factory returns a separator");

    bool threw = false;
    try
    {
        silverdaw::StemSeparationRequest request; // empty modelDir -> no weights
        separator->separate(request, [](const char*, double, const char*) {},
                            [](const silverdaw::StemResultFile&) {}, [] { return false; });
    }
    catch (const silverdaw::StemSeparationError& e)
    {
        threw = true;
        require(e.code == silverdaw::StemFailureCode::Model,
                "missing/unavailable model surfaces StemFailureCode::Model");
    }
    require(threw, "default separator throws without a usable model");
}

void testStemsOutputBaseDir()
{
    // Unsaved project -> the disposable temp workspace (…/Temp/Silverdaw/stems).
    const auto temp = silverdaw::stemsOutputBaseDir(juce::String{});
    require(temp.getFileName() == "stems", "unsaved project writes stems to the temp workspace");
    requireEqual(temp.getFullPathName(),
                 silverdaw::tempArtifactsRoot().getChildFile("stems").getFullPathName(),
                 "unsaved stems live under the temp artifacts root");

    // Saved project -> a portable "stems" subfolder beside the project file.
    const auto projectDir = makeTempDir("stem-base");
    const auto projectFile = projectDir.getChildFile("My Mix.silverdaw");
    const auto base = silverdaw::stemsOutputBaseDir(projectFile.getFullPathName());
    requireEqual(base.getFullPathName(), projectDir.getChildFile("stems").getFullPathName(),
                 "saved project keeps stems beside the project file");
    projectDir.deleteRecursively();
}

void testOverlapForStemQuality()
{
    // fast trades seam smoothness for fewer model runs; balanced and best share
    // the long-standing 0.25 overlap. "best" was dropped from 0.50 to 0.25 after
    // benchmarks showed the extra runs dominated wall-clock with no audible gain
    // (the overlap-add is counter-normalised, so overlap only affects seams).
    require(silverdaw::overlapForStemQuality("fast") < silverdaw::overlapForStemQuality("balanced"),
            "fast overlaps less than balanced");
    requireNear(silverdaw::overlapForStemQuality("best"),
                silverdaw::overlapForStemQuality("balanced"), 1e-9,
                "best and balanced share the same overlap");
    requireNear(silverdaw::overlapForStemQuality("best"), 0.25, 1e-9,
                "best uses the 0.25 overlap (no longer 0.50)");
    requireNear(silverdaw::overlapForStemQuality("balanced"), 0.25, 1e-9,
                "balanced preserves the long-standing default overlap");
    // Absent / unknown values fall back to the balanced default so a malformed
    // envelope is safe.
    requireNear(silverdaw::overlapForStemQuality(""), 0.25, 1e-9,
                "empty quality falls back to balanced");
    requireNear(silverdaw::overlapForStemQuality("bogus"), 0.25, 1e-9,
                "unknown quality falls back to balanced");
}

void testShiftsForStemQuality()
{
    // Only "best" pays for vocal test-time augmentation; fast/balanced/unknown
    // stay single-pass so the default separation time is unchanged.
    require(silverdaw::shiftsForStemQuality("best") > 1, "best uses multiple vocal shifts");
    require(silverdaw::shiftsForStemQuality("fast") == 1, "fast is single-pass");
    require(silverdaw::shiftsForStemQuality("balanced") == 1, "balanced is single-pass");
    require(silverdaw::shiftsForStemQuality("") == 1, "absent quality is single-pass");
    require(silverdaw::shiftsForStemQuality("bogus") == 1, "unknown quality is single-pass");
}

void testShiftOffsets()
{
    // Single pass always yields just {0} — the unshifted run, no behaviour change.
    require(silverdaw::shiftOffsetsFor(1, 22050) == std::vector<int>{0}, "shifts<=1 is {0}");
    require(silverdaw::shiftOffsetsFor(0, 22050) == std::vector<int>{0}, "shifts=0 clamps to {0}");

    // Deterministic, ascending, starts at 0, stays within [0, maxShift).
    const auto four = silverdaw::shiftOffsetsFor(4, 22050);
    require(four.size() == 4, "four distinct shift offsets");
    require(four.front() == 0, "first offset is the unshifted run");
    for (size_t i = 1; i < four.size(); ++i)
        require(four[i] > four[i - 1], "offsets strictly ascending");
    require(four.back() < 22050, "offsets stay below max shift (demucs spreads up to max)");

    // Degenerate max shift collapses to a single unique run (no wasted passes).
    require(silverdaw::shiftOffsetsFor(4, 0) == std::vector<int>{0}, "zero max shift dedupes to {0}");
}

void testStemMetrics()
{
    juce::AudioBuffer<float> ref(2, 1000);
    for (int ch = 0; ch < 2; ++ch)
        for (int i = 0; i < 1000; ++i)
            ref.setSample(ch, i, std::sin(0.05f * static_cast<float>(i)) * (ch == 0 ? 1.0f : 0.8f));

    // Identical estimate: both metrics hit the ceiling (perfect separation).
    require(silverdaw::siSdrDb(ref, ref) >= silverdaw::kStemMetricCeilingDb - 1e-6,
            "identical buffers give ceiling SI-SDR");
    require(silverdaw::sdrDb(ref, ref) >= silverdaw::kStemMetricCeilingDb - 1e-6,
            "identical buffers give ceiling SDR");

    // Scale invariance: a half-gain copy is still perfect SI-SDR (gain is not a
    // separation error) but plain SDR penalises the level mismatch.
    juce::AudioBuffer<float> half(2, 1000);
    for (int ch = 0; ch < 2; ++ch)
        for (int i = 0; i < 1000; ++i)
            half.setSample(ch, i, ref.getSample(ch, i) * 0.5f);
    require(silverdaw::siSdrDb(ref, half) >= silverdaw::kStemMetricCeilingDb - 1e-6,
            "scaled copy is perfect SI-SDR");
    require(silverdaw::sdrDb(ref, half) < 40.0, "plain SDR penalises the level mismatch");

    // Uncorrelated estimate scores far worse than a correlated one.
    juce::AudioBuffer<float> noise(2, 1000);
    juce::Random rng(1234);
    for (int ch = 0; ch < 2; ++ch)
        for (int i = 0; i < 1000; ++i)
            noise.setSample(ch, i, rng.nextFloat() * 2.0f - 1.0f);
    require(silverdaw::siSdrDb(ref, noise) < silverdaw::siSdrDb(ref, half),
            "noise scores worse than a correct (scaled) stem");

    // Silent reference is a no-op (nothing to separate) -> 0 dB, never NaN/inf.
    juce::AudioBuffer<float> silent(2, 1000);
    silent.clear();
    requireNear(silverdaw::siSdrDb(silent, noise), 0.0, 1e-9, "silent reference yields 0 dB");
}

// Split-stereo-channels DSP: the chosen channel is copied across both outputs so the
// exported clip is a stereo file carrying only that channel; out-of-range/mono is a no-op.
void testDuplicateChannelAcross()
{
    juce::AudioBuffer<float> buffer(2, 4);
    for (int i = 0; i < 4; ++i)
    {
        buffer.setSample(0, i, 0.1f * static_cast<float>(i + 1)); // left ramp
        buffer.setSample(1, i, -0.5f);                            // right constant
    }

    // Duplicate the left channel: both channels become the left ramp.
    silverdaw::duplicateChannelAcross(buffer, 4, 0);
    for (int i = 0; i < 4; ++i)
    {
        requireNear(buffer.getSample(0, i), 0.1f * static_cast<float>(i + 1), 1e-6, "left preserved");
        requireNear(buffer.getSample(1, i), 0.1f * static_cast<float>(i + 1), 1e-6, "right becomes left");
    }

    // Duplicate the right channel of a fresh buffer: both become the right constant.
    juce::AudioBuffer<float> other(2, 4);
    for (int i = 0; i < 4; ++i)
    {
        other.setSample(0, i, 0.9f);
        other.setSample(1, i, -0.25f);
    }
    silverdaw::duplicateChannelAcross(other, 4, 1);
    for (int i = 0; i < 4; ++i)
    {
        requireNear(other.getSample(0, i), -0.25f, 1e-6, "left becomes right");
        requireNear(other.getSample(1, i), -0.25f, 1e-6, "right preserved");
    }

    // A mono buffer and an out-of-range channel are both no-ops (leave audio untouched).
    juce::AudioBuffer<float> mono(1, 4);
    for (int i = 0; i < 4; ++i) mono.setSample(0, i, 0.3f);
    silverdaw::duplicateChannelAcross(mono, 4, 0);
    for (int i = 0; i < 4; ++i) requireNear(mono.getSample(0, i), 0.3f, 1e-6, "mono untouched");
    silverdaw::duplicateChannelAcross(buffer, 4, 5); // out of range: no change
    requireNear(buffer.getSample(1, 0), 0.1f, 1e-6, "out-of-range channel is a no-op");
}

} // namespace

void addStemSeparationTests(std::vector<TestCase>& tests)
{
    tests.push_back({"stem failure code strings", testFailureCodeStrings});
    tests.push_back({"stem job runs separator and clears busy", testJobRunsSeparatorAndClearsBusy});
    tests.push_back({"stem job propagates cancel", testJobPropagatesCancel});
    tests.push_back({"stem progress coalesces without hiding transitions", testProgressCoalescing});
    tests.push_back({"stem GPU fallback quarantine persists", testGpuFallbackQuarantine});
    tests.push_back({"stem GPU fallback retry progress is monotonic", testGpuFallbackRetryProgress});
    tests.push_back({"stem GPU attempt publishes transactionally", testGpuAttemptPublishesTransactionally});
    tests.push_back({"stem GPU fallback classifies recoverable faults", testRecoverableGpuFaultMessages});
    tests.push_back({"stem raw mixture denormalisation preserves samples", testStemMixtureDenormalisation});
    tests.push_back({"stem raw mixture follows the selected execution plan", testRawStemMixturePlanning});
    tests.push_back({"stem vocal cleanup honours cancellation", testVocalCleanupHonoursCancellation});
#if defined(SILVERDAW_STEM_SEPARATION)
    tests.push_back({"stem pending vocal cleanup publishes on caller", testPendingVocalCleanupPublishesOnCaller});
    tests.push_back({"stem pending vocal cleanup aborts worker", testPendingVocalCleanupAbortCancelsWorker});
#endif
    tests.push_back({"default separator fails fast without model", testDefaultSeparatorFailsFastWithoutModel});
    tests.push_back({"stem quality maps to overlap", testOverlapForStemQuality});
    tests.push_back({"stem quality maps to vocal shifts", testShiftsForStemQuality});
    tests.push_back({"shift offsets are deterministic and deduped", testShiftOffsets});
    tests.push_back({"stem metrics: SI-SDR scale-invariance and SDR", testStemMetrics});
    tests.push_back({"stems output base dir follows the project", testStemsOutputBaseDir});
    tests.push_back({"split-channels duplicates the chosen channel", testDuplicateChannelAcross});
}

} // namespace silverdaw::tests
