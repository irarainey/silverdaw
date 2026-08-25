#include "PluginCatalogue.h"

#include "Log.h"
#include "PluginScanCoordinator.h"

#include <utility>

namespace silverdaw::plugins
{
namespace
{
juce::File resolveDataDir(const juce::File& requested)
{
    if (requested != juce::File{}) return requested;

    const auto appData = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory);
    return appData.getChildFile("Silverdaw").getChildFile("plugins");
}
} // namespace

PluginCatalogue::PluginCatalogue(juce::File dataDirectory) : dataDir(resolveDataDir(dataDirectory))
{
    if (const auto created = dataDir.createDirectory(); !created.wasOk())
    {
        log::error("plugins", "failed to create plugin data dir " + dataDir.getFullPathName() + ": "
                                  + created.getErrorMessage());
    }

    formatManager.addFormat(std::make_unique<juce::VST3PluginFormat>());
    knownPlugins.setCustomScanner(std::make_unique<PluginScanCoordinator>());

    if (const auto cached = juce::parseXML(knownPluginsFile()); cached != nullptr)
        knownPlugins.recreateFromXml(*cached);

    log::info("plugins", "catalogue loaded with " + juce::String(knownPlugins.getNumTypes()) + " plugin(s), "
                             + juce::String(knownPlugins.getBlacklistedFiles().size()) + " blacklisted");
}

PluginCatalogue::~PluginCatalogue()
{
    // Destroy the job before the list it writes into.
    scanJob.reset();
}

juce::Array<juce::PluginDescription> PluginCatalogue::getKnownPlugins() const
{
    return knownPlugins.getTypes();
}

juce::StringArray PluginCatalogue::getBlacklistedFiles() const
{
    return knownPlugins.getBlacklistedFiles();
}

bool PluginCatalogue::hasPlugin(const juce::String& fileOrIdentifier) const
{
    for (const auto& type : knownPlugins.getTypes())
        if (type.fileOrIdentifier == fileOrIdentifier) return true;

    return false;
}

juce::FileSearchPath PluginCatalogue::getSearchPaths() const
{
    auto* format = formatManager.getFormat(0);
    auto paths = format != nullptr ? format->getDefaultLocationsToSearch() : juce::FileSearchPath{};

    for (int i = 0; i < userSearchPaths.getNumPaths(); ++i)
        paths.addIfNotAlreadyThere(userSearchPaths[i]);

    return paths;
}

void PluginCatalogue::setUserSearchPaths(const juce::FileSearchPath& paths)
{
    userSearchPaths = paths;
}

bool PluginCatalogue::startScan(juce::FileSearchPath pathsToScan, PluginScanJob::ProgressCallback onProgress,
                               PluginScanJob::FinishedCallback onFinished)
{
    if (isScanning()) return false;

    auto* format = formatManager.getFormat(0);
    if (format == nullptr) return false;

    scanJob = std::make_unique<PluginScanJob>(
        knownPlugins, *format, std::move(pathsToScan), deadMansPedalFile(), std::move(onProgress),
        [this, finished = std::move(onFinished)](bool completed)
        {
            saveKnownPlugins();
            // Cleared before the caller's callback so anything that callback broadcasts —
            // notably the refreshed plugin list — already reports the scan as over.
            scanning.store(false, std::memory_order_release);
            if (finished) finished(completed);
        });

    scanning.store(true, std::memory_order_release);
    scanJob->start();
    return true;
}

void PluginCatalogue::cancelScan()
{
    if (scanJob != nullptr) scanJob->cancel();
}

bool PluginCatalogue::isScanning() const
{
    return scanning.load(std::memory_order_acquire);
}

void PluginCatalogue::clearBlacklist()
{
    knownPlugins.clearBlacklistedFiles();
    // The pedal file is replayed into the blacklist at the start of every scan, so it has to
    // go too or the next scan restores what was just cleared.
    deadMansPedalFile().deleteFile();
    saveKnownPlugins();
}

std::unique_ptr<juce::AudioPluginInstance> PluginCatalogue::createInstance(
    const juce::PluginDescription& description, double sampleRate, int blockSize, juce::String& errorMessage)
{
    return formatManager.createPluginInstance(description, sampleRate, blockSize, errorMessage);
}

juce::File PluginCatalogue::knownPluginsFile() const
{
    return dataDir.getChildFile("known-plugins.xml");
}

juce::File PluginCatalogue::deadMansPedalFile() const
{
    return dataDir.getChildFile("scan-crashes.txt");
}

void PluginCatalogue::saveKnownPlugins() const
{
    const auto xml = knownPlugins.createXml();
    if (xml == nullptr) return;

    if (!xml->writeTo(knownPluginsFile()))
        log::error("plugins", "failed to write " + knownPluginsFile().getFullPathName());
}

} // namespace silverdaw::plugins
