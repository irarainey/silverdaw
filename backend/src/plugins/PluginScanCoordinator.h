#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include <memory>

namespace silverdaw::plugins
{

// Runs every plugin scan in a child process (ADR 0025). A plugin that crashes takes the
// child down and fails only its own scan; the engine keeps running and the file is
// blacklisted by the scan job.
class PluginScanCoordinator final : public juce::KnownPluginList::CustomScanner
{
  public:
    PluginScanCoordinator();
    ~PluginScanCoordinator() override;

    bool findPluginTypesFor(juce::AudioPluginFormat& format,
                            juce::OwnedArray<juce::PluginDescription>& results,
                            const juce::String& fileOrIdentifier) override;

    void scanFinished() override;

  private:
    class WorkerConnection;
    std::unique_ptr<WorkerConnection> connection;
};

} // namespace silverdaw::plugins
