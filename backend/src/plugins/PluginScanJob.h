#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include <functional>

namespace silverdaw::plugins
{

struct ScanProgress
{
    int scanned = 0;
    int total = 0;
    juce::String currentPlugin;
};

// One background scan pass over the search paths. Progress and completion are reported on
// the scan thread, like the peaks worker pool; a caller that needs the message thread
// marshals there itself. The destructor joins the thread, so a callback can never outlive
// what it captures.
class PluginScanJob final : private juce::Thread
{
  public:
    using ProgressCallback = std::function<void(ScanProgress)>;
    using FinishedCallback = std::function<void(bool completed)>;

    PluginScanJob(juce::KnownPluginList& listToAddTo, juce::AudioPluginFormat& formatToScan,
                  const juce::FileSearchPath& pathsToSearch, juce::File deadMansPedalFile,
                  ProgressCallback onProgress, FinishedCallback onFinished);
    ~PluginScanJob() override;

    void start();
    void cancel();
    bool isRunning() const;

  private:
    void run() override;

    juce::KnownPluginList& knownPlugins;
    juce::AudioPluginFormat& format;
    juce::FileSearchPath searchPaths;
    juce::File deadMansPedalFile;
    ProgressCallback progressCallback;
    FinishedCallback finishedCallback;
};

} // namespace silverdaw::plugins
