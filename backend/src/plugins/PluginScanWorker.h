#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw::plugins
{

// Identifies the child-process scan mode on the command line; shared with the coordinator.
inline constexpr const char* kScanWorkerUid = "silverdaw-plugin-scan";

// True when this process was launched to scan plugins rather than to run the engine.
bool isScanWorkerCommandLine(const juce::String& commandLine);

// Runs the scan child until the coordinator disconnects. Only valid when the command line
// is a scan-worker one.
int runScanWorker(const juce::String& commandLine);

} // namespace silverdaw::plugins
