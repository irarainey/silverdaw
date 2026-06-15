#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

// The connection bus an output endpoint sits on. Drives whether the endpoint is treated as
// sleep-prone (and so kept awake). USB audio interfaces are the known offenders; onboard /
// Bluetooth / virtual devices are not.
enum class OutputBus
{
    usb,
    onboard,
    bluetooth,
    other,
    unknown
};

// Classify the active render endpoint (matched by the friendly name JUCE reports as the device
// name) by walking up the Windows device tree to its physical bus enumerator (USB / HDAUDIO /
// PCI / BTH...). Fail-safe: any COM/Config-Manager failure, or no matching endpoint, returns
// OutputBus::unknown. Message-thread only — uses COM (MMDevice) + Config Manager.
OutputBus classifyOutputEndpoint(const juce::String& friendlyName);

// Policy: which buses are prone to silence auto-mute and so warrant the keep-awake tone plus the
// one-time first-play wake. USB (the known offenders) and unknown (fail-safe: never risk dropping
// a beat on an unclassifiable device) -> true; onboard / Bluetooth / other -> false. Pure and
// unit-testable.
bool busPrefersKeepAwake(OutputBus bus) noexcept;

const char* toString(OutputBus bus) noexcept;

} // namespace silverdaw
