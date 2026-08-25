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

// The renderer clears its scan indicator from a plugin-list broadcast sent by the finished
// callback, so `isScanning()` has to already read false by the time that callback runs. It
// used to be derived from the scan thread's liveness, which is still true at that point.
void testScanIsReportedFinishedInsideTheCallback()
{
    const auto pluginDir = makeTempDir("plugin-scan-state");
    const auto dataDir = makeTempDir("plugin-data-state");
    writeBogusPlugin(pluginDir);

    plugins::PluginCatalogue catalogue{dataDir};

    std::atomic<bool> finished{false};
    std::atomic<bool> scanningWhenFinished{true};
    std::atomic<bool> scanningWhileRunning{false};

    const auto started = catalogue.startScan(
        juce::FileSearchPath{pluginDir.getFullPathName()},
        [&catalogue, &scanningWhileRunning](plugins::ScanProgress)
        { scanningWhileRunning.store(catalogue.isScanning()); },
        [&catalogue, &finished, &scanningWhenFinished](bool)
        {
            scanningWhenFinished.store(catalogue.isScanning());
            finished.store(true);
        });
    require(started, "startScan must accept the scan");

    const auto deadline = juce::Time::getMillisecondCounter() + 60000;
    while (!finished.load() && juce::Time::getMillisecondCounter() < deadline)
        juce::Thread::sleep(25);

    require(finished.load(), "the scan must finish");
    require(scanningWhileRunning.load(), "a scan in flight must report itself as scanning");
    require(!scanningWhenFinished.load(),
            "the scan must report itself finished before the finished callback runs");
    require(!catalogue.isScanning(), "the catalogue must be idle once the scan has finished");

    pluginDir.deleteRecursively();
    dataDir.deleteRecursively();
}

// The scan searches the two locations the VST3 spec defines on Windows and nothing else,
// which is documented as the reason there is no "plugin folders" preference. If the search
// ever silently narrowed to one of them, plugins would go missing for a whole class of user
// with no error to explain it.
void testSearchPathsAreTheStandardVst3Locations()
{
    const auto dataDir = makeTempDir("plugin-data-paths");
    plugins::PluginCatalogue catalogue{dataDir};
    const auto paths = catalogue.getSearchPaths();

    const auto expectedUser = juce::File::getSpecialLocation(juce::File::windowsLocalAppData)
                                  .getChildFile("Programs")
                                  .getChildFile("Common")
                                  .getChildFile("VST3");
    const auto expectedMachine = juce::File::getSpecialLocation(juce::File::globalApplicationsDirectory)
                                     .getChildFile("Common Files")
                                     .getChildFile("VST3");

    const auto searches = [&paths](const juce::File& wanted)
    {
        for (int i = 0; i < paths.getNumPaths(); ++i)
            if (paths[i] == wanted) return true;

        return false;
    };

    require(paths.getNumPaths() == 2, "exactly the two standard VST3 locations must be searched");
    require(searches(expectedUser), "the per-user VST3 folder must be searched");
    require(searches(expectedMachine), "the machine-wide VST3 folder must be searched");

    dataDir.deleteRecursively();
}

// Seeds a cached catalogue through JUCE's own serialisation, so the tests cannot drift from
// the XML schema the catalogue actually reads.
void seedCachedCatalogue(const juce::File& dataDir, const juce::Array<juce::File>& pluginFiles)
{
    juce::KnownPluginList seed;
    int uniqueId = 1;
    for (const auto& file : pluginFiles)
    {
        juce::PluginDescription description;
        description.name = file.getFileNameWithoutExtension();
        description.pluginFormatName = "VST3";
        description.fileOrIdentifier = file.getFullPathName();
        description.uniqueId = uniqueId++;
        seed.addType(description);
    }

    const auto xml = seed.createXml();
    require(xml != nullptr, "the seed catalogue must serialise");
    require(xml->writeTo(dataDir.getChildFile("known-plugins.xml")), "the seed must be written");
}

// A plugin uninstalled between runs must be gone from the picker as soon as the app starts,
// without waiting for the user to think to rescan. This is only an existence check, never a
// scan, which is what makes it affordable at load.
void testCatalogueForgetsUninstalledPluginsAtLoad()
{
    const auto dataDir = makeTempDir("plugin-data-load-prune");
    const auto pluginDir = makeTempDir("plugin-load-prune-src");
    const auto survivor = writeBogusPlugin(pluginDir);
    const auto uninstalled = pluginDir.getChildFile("Gone.vst3");

    seedCachedCatalogue(dataDir, {survivor, uninstalled});

    plugins::PluginCatalogue catalogue{dataDir};
    require(!catalogue.hasPlugin(uninstalled.getFullPathName()),
            "a plugin whose binary has gone must be dropped at load");
    require(catalogue.hasPlugin(survivor.getFullPathName()),
            "a plugin whose binary is still installed must survive load");
    require(catalogue.getKnownPlugins().size() == 1, "only the installed plugin must remain");

    // The removal has to reach disk, or every launch pays to rediscover the same absence.
    plugins::PluginCatalogue reloaded{dataDir};
    require(reloaded.getKnownPlugins().size() == 1, "the removal must be persisted, not redone each load");

    pluginDir.deleteRecursively();
    dataDir.deleteRecursively();
}

// The same reconciliation runs after a scan, which covers a plugin uninstalled while the app
// is open — the load-time pass has already happened by then.
void testScanForgetsUninstalledPlugins()
{
    const auto dataDir = makeTempDir("plugin-data-prune");
    const auto pluginDir = makeTempDir("plugin-prune-src");
    const auto survivor = writeBogusPlugin(pluginDir);
    const auto removedLater = pluginDir.getChildFile("RemovedLater.vst3");
    removedLater.replaceWithText("this is not a plugin binary either");

    seedCachedCatalogue(dataDir, {survivor, removedLater});

    plugins::PluginCatalogue catalogue{dataDir};
    require(catalogue.getKnownPlugins().size() == 2, "both seeded plugins exist, so both must load");

    // Uninstalled after the catalogue was loaded, so only the scan can notice.
    require(removedLater.deleteFile(), "the test must be able to remove the plugin file");

    runScanToCompletion(catalogue, juce::FileSearchPath{pluginDir.getFullPathName()});

    require(!catalogue.hasPlugin(removedLater.getFullPathName()),
            "a plugin uninstalled while running must be dropped by a rescan");
    require(catalogue.hasPlugin(survivor.getFullPathName()),
            "a plugin whose binary is still installed must be kept");

    plugins::PluginCatalogue reloaded{dataDir};
    require(!reloaded.hasPlugin(removedLater.getFullPathName()),
            "the removal must survive a catalogue reload");

    pluginDir.deleteRecursively();
    dataDir.deleteRecursively();
}

} // namespace

void addPluginCatalogueTests(std::vector<TestCase>& tests)
{
    tests.push_back({"PluginCatalogue blacklists a binary that fails to scan", testScanBlacklistsUnloadableBinary});
    tests.push_back({"PluginCatalogue restores its blacklist from the cache", testBlacklistSurvivesReload});
    tests.push_back({"PluginCatalogue clearBlacklist forgets the crash record", testClearBlacklistForgetsCrashRecord});
    tests.push_back({"PluginCatalogue reports the scan finished before the finished callback",
                     testScanIsReportedFinishedInsideTheCallback});
    tests.push_back({"Plugin scan worker command line is distinguished from the engine's",
                     testScanWorkerCommandLineRecognition});
    tests.push_back({"PluginCatalogue searches the standard VST3 locations",
                     testSearchPathsAreTheStandardVst3Locations});
    tests.push_back({"PluginCatalogue forgets plugins uninstalled since the last scan",
                     testScanForgetsUninstalledPlugins});
    tests.push_back({"PluginCatalogue forgets uninstalled plugins at load",
                     testCatalogueForgetsUninstalledPluginsAtLoad});
}

} // namespace silverdaw::tests
