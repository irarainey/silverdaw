#pragma once

#include <juce_core/juce_core.h>

// Cross-layer logger; immediate mutex-guarded flushes preserve crash tails.
// Not for audio-thread hot paths.
namespace silverdaw::log
{

enum class Level
{
    Debug,
    Info,
    Warn,
    Error
};

// Initialise once near process start; later calls are ignored. `minLevel` drops
// anything below it. `truncate` overwrites on open instead of appending.
// `startupOnly` marks this as the always-on diagnostics sink: it exists purely to
// catch a backend that can't START, so `markStartupComplete()` closes it the
// moment the app is up — it must never accumulate ongoing session logs (that is
// what the opt-in verbose sink, append inside a unique per-session dir, is for).
void initialise(const juce::String& logDirOverride, Level minLevel = Level::Debug,
                bool truncate = false, bool startupOnly = false);

// Closes the always-on diagnostics sink once startup succeeds (no-op for the
// verbose sink). After this, the diagnostics log holds only the startup trace —
// ending in "startup complete" on success, or cut off at the failing phase.
void markStartupComplete();

void shutdown();

// Thread-safe, but not audio-thread-safe.
void write(Level level, const char* tag, const juce::String& message);

inline void debug(const char* tag, const juce::String& m) { write(Level::Debug, tag, m); }
inline void info(const char* tag, const juce::String& m) { write(Level::Info, tag, m); }
inline void warn(const char* tag, const juce::String& m) { write(Level::Warn, tag, m); }
inline void error(const char* tag, const juce::String& m) { write(Level::Error, tag, m); }

} // namespace silverdaw::log
