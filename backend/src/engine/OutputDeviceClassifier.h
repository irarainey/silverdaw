#pragma once

#include <juce_core/juce_core.h>

#include <optional>

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
// one-time first-play wake. Only USB (the known offenders) -> true; onboard / Bluetooth / other /
// unknown -> false. The audible wake burst must never fire on a non-USB endpoint, so an
// unclassifiable device defaults to NO keep-awake; a USB DAC that classification misses is covered
// by the user's keep-awake preference (forceOn). Pure and unit-testable.
bool busPrefersKeepAwake(OutputBus bus) noexcept;

const char* toString(OutputBus bus) noexcept;

// User override for the auto keep-awake policy. autoDetect follows the bus classification above;
// forceOn / forceOff let the user correct a misclassified endpoint (e.g. a USB DAC that classifies
// as unknown, or a USB DAC that does not need the dither and reveals it as hiss).
enum class KeepAwakeMode
{
    autoDetect,
    forceOn,
    forceOff
};

// Resolve the effective keep-awake state from the user's mode and the classified bus. Pure and
// unit-testable; the single source of truth for "should this endpoint be kept awake".
bool resolveKeepAwake(KeepAwakeMode mode, OutputBus bus) noexcept;

// Parse the wire value ("auto" / "on" / "off") to a mode; std::nullopt for anything else.
std::optional<KeepAwakeMode> keepAwakeModeFromString(const juce::String& value) noexcept;

const char* toString(KeepAwakeMode mode) noexcept;

} // namespace silverdaw
