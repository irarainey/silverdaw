#pragma once

#include <juce_core/juce_core.h>

// Always-on backend crash reporter. Independent of the user's diagnostic-logging
// preference: when the backend faults during startup (e.g. an access violation
// raised deep inside a WASAPI/COM audio driver on a machine we can't attach to),
// this writes a small, easy-to-find exception report so the failure can be
// diagnosed from the crash alone. The backend is useless without its audio
// engine, so a fault is fatal by design — this just makes it leave a trace.
namespace silverdaw::crash
{

// Installs a process-wide unhandled-exception handler that writes
// `<diagDir>/backend-crash-<stamp>.log` on a hard fault. No-op when `diagDir` is
// empty or on non-Windows. Call once, as early in startup as possible.
void install(const juce::String& diagDir);

// Records what the backend is currently doing so a crash report names the phase
// (e.g. "audio-device-init"). Cheap and lock-free; call at each startup
// milestone. The pointer must outlive the process (use a string literal).
void setPhase(const char* phase);

} // namespace silverdaw::crash
