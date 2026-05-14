#include <iostream>
#include <juce_core/juce_core.h>

//==============================================================================
// Jackdaw headless audio backend - entry point.
//
// Launched as a child process by the Electron frontend. Real responsibilities
// (audio engine, WebSocket server, project state) will land in later phases.
//
// NOTE: keep string literals ASCII-only. juce::String(const char*) asserts on
// any byte > 127. For Unicode text, wrap with juce::CharPointer_UTF8.
//==============================================================================
int main(int /*argc*/, char* /*argv*/[])
{
    const juce::String banner = "Jackdaw Backend v0.1.0 - " + juce::SystemStats::getOperatingSystemName() + " (" +
                                juce::SystemStats::getCpuVendor() + ")";

    std::cout << banner.toStdString() << '\n';
    std::cout << "Headless mode. WebSocket server not yet implemented." << '\n';

    return 0;
}
