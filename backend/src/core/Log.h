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

// Initialise once near process start; later calls are ignored.
void initialise(const juce::String& logDirOverride);

void shutdown();

// Thread-safe, but not audio-thread-safe.
void write(Level level, const char* tag, const juce::String& message);

inline void debug(const char* tag, const juce::String& m) { write(Level::Debug, tag, m); }
inline void info(const char* tag, const juce::String& m) { write(Level::Info, tag, m); }
inline void warn(const char* tag, const juce::String& m) { write(Level::Warn, tag, m); }
inline void error(const char* tag, const juce::String& m) { write(Level::Error, tag, m); }

} // namespace silverdaw::log
