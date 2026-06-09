// Stem-separation wiring tests: failure-code mapping, the background job's
// busy-flag / cancel lifecycle against an injected fake separator, and the
// default separator's fail-fast contract. The real ONNX inference is exercised
// elsewhere (it needs the model + audio); here we prove the plumbing.

#include "TestRegistry.h"

#include <atomic>

#include "BridgeServer.h"
#include "StemSeparationEngine.h"
#include "StemSeparator.h"

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
        onStemReady("vocals", file);
        sawStemReady = true;
        result.stems.push_back({juce::String("vocals"), file});
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

void testDefaultSeparatorFailsFastWithoutModel()
{
    auto separator = silverdaw::createDefaultStemSeparator();
    require(separator != nullptr, "factory returns a separator");

    bool threw = false;
    try
    {
        silverdaw::StemSeparationRequest request; // empty modelDir -> no weights
        separator->separate(request, [](const char*, double, const char*) {},
                            [](const char*, const juce::File&) {}, [] { return false; });
    }
    catch (const silverdaw::StemSeparationError& e)
    {
        threw = true;
        require(e.code == silverdaw::StemFailureCode::Model,
                "missing/unavailable model surfaces StemFailureCode::Model");
    }
    require(threw, "default separator throws without a usable model");
}

} // namespace

void addStemSeparationTests(std::vector<TestCase>& tests)
{
    tests.push_back({"stem failure code strings", testFailureCodeStrings});
    tests.push_back({"stem job runs separator and clears busy", testJobRunsSeparatorAndClearsBusy});
    tests.push_back({"stem job propagates cancel", testJobPropagatesCancel});
    tests.push_back({"default separator fails fast without model", testDefaultSeparatorFailsFastWithoutModel});
}

} // namespace silverdaw::tests
