#include "PluginScanJob.h"

#include <utility>

namespace silverdaw::plugins
{

PluginScanJob::PluginScanJob(juce::KnownPluginList& listToAddTo, juce::AudioPluginFormat& formatToScan,
                             const juce::FileSearchPath& pathsToSearch, juce::File deadMansPedal,
                             ProgressCallback onProgress, FinishedCallback onFinished)
    : juce::Thread("silverdaw-plugin-scan"), knownPlugins(listToAddTo), format(formatToScan),
      searchPaths(pathsToSearch), deadMansPedalFile(std::move(deadMansPedal)),
      progressCallback(std::move(onProgress)), finishedCallback(std::move(onFinished))
{
}

PluginScanJob::~PluginScanJob()
{
    stopThread(5000);
}

void PluginScanJob::start()
{
    startThread();
}

void PluginScanJob::cancel()
{
    signalThreadShouldExit();
}

bool PluginScanJob::isRunning() const
{
    return isThreadRunning();
}

void PluginScanJob::run()
{
    juce::PluginDirectoryScanner scanner{knownPlugins, format, searchPaths, /*searchRecursively*/ true,
                                         deadMansPedalFile,
                                         /*allowPluginsWhichRequireAsynchronousInstantiation*/ false};

    // Walking the paths here gives the same file list the scanner builds for itself, plus a
    // total to report progress against.
    const auto files = format.searchPathsForPlugins(searchPaths, /*recursive*/ true, false);
    scanner.setFilesOrIdentifiersToScan(files);

    const int total = files.size();
    int scanned = 0;

    for (bool more = total > 0; more;)
    {
        if (threadShouldExit())
        {
            if (finishedCallback) finishedCallback(false);
            return;
        }

        juce::String pluginName;
        more = scanner.scanNextFile(/*dontRescanIfAlreadyInList*/ true, pluginName);
        ++scanned;

        if (progressCallback) progressCallback({scanned, total, pluginName});
    }

    // A file that yielded no types either crashed its scan child or is not a usable plugin.
    // Blacklisting it keeps later scans fast and stops it being retried on every launch.
    for (const auto& failed : scanner.getFailedFiles())
        knownPlugins.addToBlacklist(failed);

    if (finishedCallback) finishedCallback(true);
}

} // namespace silverdaw::plugins
