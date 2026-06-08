#pragma once

#include <juce_core/juce_core.h>

/**
 * Cross-layer structured logger for the backend.
 *
 * All silverdaw processes (Electron main, renderer, JUCE backend) write
 * to per-session log files under `.logs/<session-stamp>/` so a developer
 * can `tail -F` or post-mortem-grep across layers and align events by
 * the ISO-8601 millisecond timestamp at the start of every line.
 *
 * Line format:
 *
 *   2026-05-16T16:43:17.123Z INFO  [tag] message
 *
 *   - Timestamp: UTC ISO-8601 with millisecond precision (no `T` to
 *     `Z` substitution surprises).
 *   - Level: fixed-width 5 chars (`INFO `, `WARN `, `ERROR`, `DEBUG`)
 *     so columns align in a tail.
 *   - Tag: short subsystem name in brackets (e.g. `[engine]`,
 *     `[bridge]`, `[peakscache]`).
 *   - Message: single line, free-form.
 *
 * The session directory is resolved from the `SILVERDAW_LOG_DIR` env
 * var passed by Electron main on spawn. Stand-alone manual runs (no
 * env var) fall back to writing under `<exe-dir>/.logs/<stamp>/`.
 *
 * Thread-safe: every write takes a mutex and flushes immediately so a
 * crash leaves a maximally-useful tail. The mutex is held only for the
 * duration of one write; logging is not in the audio-thread hot path.
 */
namespace silverdaw::log
{

enum class Level
{
    Debug,
    Info,
    Warn,
    Error
};

/**
 * Initialise the logger. Must be called once near process start, before
 * any other logger call. Subsequent calls are ignored.
 *
 * `logDirOverride` is the `SILVERDAW_LOG_DIR` value (or empty for
 * stand-alone). Creates `<dir>/backend.log` if not already present and
 * opens it for append.
 */
void initialise(const juce::String& logDirOverride);

/** Flush + close the log file. Idempotent. */
void shutdown();

/** Record a log line. Safe to call from any thread (mutex-guarded). */
void write(Level level, const char* tag, const juce::String& message);

inline void debug(const char* tag, const juce::String& m) { write(Level::Debug, tag, m); }
inline void info(const char* tag, const juce::String& m) { write(Level::Info, tag, m); }
inline void warn(const char* tag, const juce::String& m) { write(Level::Warn, tag, m); }
inline void error(const char* tag, const juce::String& m) { write(Level::Error, tag, m); }

} // namespace silverdaw::log
