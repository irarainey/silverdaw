#include "PluginScanWorker.h"

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_events/juce_events.h>

#include <memory>
#include <mutex>
#include <queue>

#if JUCE_WINDOWS
#include <windows.h>
#endif

#if JUCE_DEBUG && defined(_MSC_VER)
#include <crtdbg.h>
#endif

namespace silverdaw::plugins
{
namespace
{
// Loading an unvetted binary can make Windows or the debug CRT raise a modal dialog on this
// thread. Nothing here is attended, so a dialog would wedge the scan behind a prompt that only
// the child can see; route the same failures to return codes and the debugger instead.
void silenceFailureDialogs()
{
#if JUCE_WINDOWS
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX
                 | SEM_NOALIGNMENTFAULTEXCEPT);
#endif

#if JUCE_DEBUG && defined(_MSC_VER)
    for (const auto reportType : {_CRT_WARN, _CRT_ERROR, _CRT_ASSERT})
    {
        _CrtSetReportMode(reportType, _CRTDBG_MODE_DEBUG);
        _CrtSetReportFile(reportType, _CRTDBG_FILE_STDERR);
    }
#endif
}

juce::String scanWorkerPrefix()
{
    return juce::String("--") + kScanWorkerUid + ":";
}

// Loads one unvetted binary per request and answers with its plugin descriptions. A plugin
// that crashes can only take this process down, never the engine (ADR 0025).
class ScanWorker final : public juce::ChildProcessWorker, private juce::AsyncUpdater
{
  public:
    ScanWorker() { formatManager.addFormat(new juce::VST3PluginFormat()); }

    ~ScanWorker() override { cancelPendingUpdate(); }

    using juce::ChildProcessWorker::initialiseFromCommandLine;

  private:
    void handleMessageFromCoordinator(const juce::MemoryBlock& request) override
    {
        if (request.isEmpty()) return;

        const std::scoped_lock guard(mutex);

        if (auto found = scan(request); !found.isEmpty())
        {
            sendResults(found);
            return;
        }

        // Either the plugin has no types or its format declined to be scanned on this pipe
        // thread; retrying on the message thread distinguishes the two.
        pendingRequests.push(request);
        triggerAsyncUpdate();
    }

    void handleConnectionLost() override { juce::MessageManager::getInstance()->stopDispatchLoop(); }

    void handleAsyncUpdate() override
    {
        for (;;)
        {
            const std::scoped_lock guard(mutex);
            if (pendingRequests.empty()) return;

            sendResults(scan(pendingRequests.front()));
            pendingRequests.pop();
        }
    }

    juce::OwnedArray<juce::PluginDescription> scan(const juce::MemoryBlock& request)
    {
        juce::MemoryInputStream stream{request, false};
        const auto formatName = stream.readString();
        const auto identifier = stream.readString();

        juce::OwnedArray<juce::PluginDescription> found;

        auto* format = formatNamed(formatName);
        if (format == nullptr) return found;

        juce::PluginDescription probe;
        probe.fileOrIdentifier = identifier;
        probe.uniqueId = probe.deprecatedUid = 0;

        // A format that needs the message thread free while it instantiates must be scanned
        // from the pipe thread instead.
        if (juce::MessageManager::getInstance()->isThisTheMessageThread()
            || format->requiresUnblockedMessageThreadDuringCreation(probe))
        {
            format->findAllTypesForFile(found, identifier);
        }

        return found;
    }

    juce::AudioPluginFormat* formatNamed(const juce::String& name)
    {
        for (auto* format : formatManager.getFormats())
            if (format->getName() == name) return format;

        return nullptr;
    }

    void sendResults(const juce::OwnedArray<juce::PluginDescription>& found)
    {
        juce::XmlElement list("LIST");
        for (const auto* description : found)
            list.addChildElement(description->createXml().release());

        const auto xml = list.toString();
        sendMessageToCoordinator({xml.toRawUTF8(), xml.getNumBytesAsUTF8()});
    }

    std::mutex mutex;
    std::queue<juce::MemoryBlock> pendingRequests;
    juce::AudioPluginFormatManager formatManager;
};
} // namespace

bool isScanWorkerCommandLine(const juce::String& commandLine)
{
    return commandLine.trim().startsWith(scanWorkerPrefix());
}

int runScanWorker(const juce::String& commandLine)
{
    silenceFailureDialogs();

    const juce::ScopedJuceInitialiser_GUI juceInit;

    auto worker = std::make_unique<ScanWorker>();
    if (!worker->initialiseFromCommandLine(commandLine, kScanWorkerUid)) return 1;

    juce::MessageManager::getInstance()->runDispatchLoop();
    return 0;
}

} // namespace silverdaw::plugins
