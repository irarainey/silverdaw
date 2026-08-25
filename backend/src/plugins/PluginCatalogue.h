#pragma once

#include "PluginScanJob.h"

#include <juce_audio_processors/juce_audio_processors.h>

#include <atomic>
#include <memory>

namespace silverdaw::plugins
{

// Message-thread owner of the known VST3 plugins, their disk cache, and the scan that fills
// it. VST3 is the only hosted format (ADR 0025).
class PluginCatalogue
{
  public:
    // The data directory defaults to %APPDATA%/Silverdaw/plugins; tests override it so a run
    // cannot disturb the user's real catalogue.
    explicit PluginCatalogue(const juce::File& dataDirectory = {});
    ~PluginCatalogue();

    juce::Array<juce::PluginDescription> getKnownPlugins() const;
    juce::StringArray getBlacklistedFiles() const;

    /** True when a plugin with this `fileOrIdentifier` is installed and scanned. */
    bool hasPlugin(const juce::String& fileOrIdentifier) const;

    /** The standard VST3 install locations, which are not user-configurable by design. */
    juce::FileSearchPath getSearchPaths() const;

    // False when a scan is already running. Callbacks arrive on the scan thread; a caller
    // that needs the message thread marshals there itself.
    bool startScan(const juce::FileSearchPath& pathsToScan, PluginScanJob::ProgressCallback onProgress,
                   PluginScanJob::FinishedCallback onFinished);
    void cancelScan();
    bool isScanning() const;

    // Forgets every plugin that previously failed so the next scan retries it.
    void clearBlacklist();

    std::unique_ptr<juce::AudioPluginInstance> createInstance(const juce::PluginDescription& description,
                                                              double sampleRate, int blockSize,
                                                              juce::String& errorMessage);

  private:
    juce::File knownPluginsFile() const;
    juce::File deadMansPedalFile() const;
    void saveKnownPlugins() const;
    // Drops cached entries whose binary is no longer installed, and answers how many went.
    // Runs at load and at the end of a scan; it only tests for existence, never loads anything.
    int removeUninstalledPlugins();

    juce::File dataDir;
    juce::AudioPluginFormatManager formatManager;
    juce::KnownPluginList knownPlugins;
    // Declared before `scanJob` so the job's finished callback, which may fire while the job
    // is being destroyed, never touches a member that has already gone.
    // Not derived from the scan thread's liveness: the finished callback fires from inside
    // `run()`, so a thread that is merely on its way out would still report itself as
    // running and leave the renderer's scan indicator stuck on.
    std::atomic<bool> scanning{false};
    std::unique_ptr<PluginScanJob> scanJob;
};

} // namespace silverdaw::plugins
