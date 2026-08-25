// VST3 plugin catalogue: out-of-process scanning, blacklisting of binaries that fail to
// load, and persistence of that verdict across catalogue reloads (ADR 0025).

#include "TestRegistry.h"

#include "PluginCatalogue.h"
#include "PluginScanWorker.h"

#include <atomic>
#include <vector>

#include <juce_events/juce_events.h>

namespace silverdaw::tests
{
namespace
{

// Runs a scan to completion. The job reports on its own thread, so the test just waits on
// the flag it sets rather than pumping a message loop.
bool runScanToCompletion(plugins::PluginCatalogue& catalogue, const juce::FileSearchPath& paths)
{
    std::atomic<bool> finished{false};
    std::atomic<bool> completed{false};

    const auto started = catalogue.startScan(
        paths, [](plugins::ScanProgress) {},
        [&finished, &completed](bool didComplete)
        {
            completed.store(didComplete);
            finished.store(true);
        });

    require(started, "startScan must accept the first scan");

    const auto deadline = juce::Time::getMillisecondCounter() + 60000;
    while (!finished.load() && juce::Time::getMillisecondCounter() < deadline)
        juce::Thread::sleep(25);

    return finished.load() && completed.load();
}

juce::File writeBogusPlugin(const juce::File& dir)
{
    const auto file = dir.getChildFile("NotAPlugin.vst3");
    file.replaceWithText("this is not a plugin binary");
    return file;
}

// A file that only looks like a plugin must fail in the scan child and be remembered as
// unusable, rather than being retried on every launch or taking the engine down with it.
void testScanBlacklistsUnloadableBinary()
{
    const auto pluginDir = makeTempDir("plugin-scan");
    const auto dataDir = makeTempDir("plugin-data");
    const auto bogus = writeBogusPlugin(pluginDir);

    plugins::PluginCatalogue catalogue{dataDir};
    require(runScanToCompletion(catalogue, juce::FileSearchPath{pluginDir.getFullPathName()}),
            "scan of a bogus plugin must run to completion");

    require(catalogue.getKnownPlugins().isEmpty(), "a bogus binary must not register as a plugin");
    require(catalogue.getBlacklistedFiles().contains(bogus.getFullPathName()),
            "a binary that failed to scan must be blacklisted");

    pluginDir.deleteRecursively();
    dataDir.deleteRecursively();
}

// The verdict is only useful if it survives a restart: a second catalogue over the same data
// directory must come back already knowing the file is unusable.
void testBlacklistSurvivesReload()
{
    const auto pluginDir = makeTempDir("plugin-scan-reload");
    const auto dataDir = makeTempDir("plugin-data-reload");
    const auto bogus = writeBogusPlugin(pluginDir);

    {
        plugins::PluginCatalogue catalogue{dataDir};
        require(runScanToCompletion(catalogue, juce::FileSearchPath{pluginDir.getFullPathName()}),
                "scan must run to completion");
    }

    const plugins::PluginCatalogue reloaded{dataDir};
    require(reloaded.getBlacklistedFiles().contains(bogus.getFullPathName()),
            "the blacklist must be restored from the catalogue cache");

    pluginDir.deleteRecursively();
    dataDir.deleteRecursively();
}

// Clearing the blacklist has to clear the crash record too, or the next scan restores what
// the user just asked to forget.
void testClearBlacklistForgetsCrashRecord()
{
    const auto pluginDir = makeTempDir("plugin-scan-clear");
    const auto dataDir = makeTempDir("plugin-data-clear");
    writeBogusPlugin(pluginDir);

    plugins::PluginCatalogue catalogue{dataDir};
    require(runScanToCompletion(catalogue, juce::FileSearchPath{pluginDir.getFullPathName()}),
            "scan must run to completion");
    require(!catalogue.getBlacklistedFiles().isEmpty(), "scan must have blacklisted the bogus file");

    catalogue.clearBlacklist();
    require(catalogue.getBlacklistedFiles().isEmpty(), "clearBlacklist must empty the blacklist");
    require(!dataDir.getChildFile("scan-crashes.txt").existsAsFile(),
            "clearBlacklist must remove the crash record");

    const plugins::PluginCatalogue reloaded{dataDir};
    require(reloaded.getBlacklistedFiles().isEmpty(), "a cleared blacklist must stay cleared");

    pluginDir.deleteRecursively();
    dataDir.deleteRecursively();
}

// The engine and the scan child are the same executable, so misreading the command line
// would either start an engine with no bridge or scan plugins instead of playing audio.
void testScanWorkerCommandLineRecognition()
{
    const juce::String workerArg = juce::String("--") + plugins::kScanWorkerUid + ":p1a2b3c4";
    require(plugins::isScanWorkerCommandLine(workerArg), "the worker command line must be recognised");
    require(plugins::isScanWorkerCommandLine("  " + workerArg), "leading whitespace must be tolerated");
    require(!plugins::isScanWorkerCommandLine("--port 8765 --token abc"),
            "a normal engine command line must not be treated as a scan worker");
    require(!plugins::isScanWorkerCommandLine({}), "an empty command line must not be a scan worker");
}

} // namespace

void addPluginCatalogueTests(std::vector<TestCase>& tests)
{
    tests.push_back({"PluginCatalogue blacklists a binary that fails to scan", testScanBlacklistsUnloadableBinary});
    tests.push_back({"PluginCatalogue restores its blacklist from the cache", testBlacklistSurvivesReload});
    tests.push_back({"PluginCatalogue clearBlacklist forgets the crash record", testClearBlacklistForgetsCrashRecord});
    tests.push_back({"Plugin scan worker command line is distinguished from the engine's",
                     testScanWorkerCommandLineRecognition});
}

} // namespace silverdaw::tests
