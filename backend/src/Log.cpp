#include "Log.h"

#include <chrono>
#include <ctime>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <sstream>

namespace silverdaw::log
{

namespace
{

std::mutex g_mutex;
std::ofstream g_file;
bool g_initialised = false;

const char* levelName(Level level)
{
    switch (level)
    {
    case Level::Debug:
        return "DEBUG";
    case Level::Info:
        return "INFO ";
    case Level::Warn:
        return "WARN ";
    case Level::Error:
        return "ERROR";
    }
    return "INFO ";
}

std::string currentIso8601Ms()
{
    using namespace std::chrono;
    const auto now = system_clock::now();
    const auto ms = duration_cast<milliseconds>(now.time_since_epoch()) % 1000;
    const auto seconds = system_clock::to_time_t(now);
    std::tm tm{};
#if defined(_WIN32)
    gmtime_s(&tm, &seconds);
#else
    gmtime_r(&seconds, &tm);
#endif
    std::ostringstream out;
    out << std::put_time(&tm, "%Y-%m-%dT%H:%M:%S") << '.' << std::setfill('0') << std::setw(3) << ms.count() << 'Z';
    return out.str();
}

/**
 * Resolve the directory the backend writes its log file into. Priority:
 *   1. `SILVERDAW_LOG_DIR` (passed by Electron main on spawn).
 *   2. `<exe-dir>/../.logs/standalone-<timestamp>` for hand-run sessions.
 * Either way the directory is created if missing.
 */
juce::File resolveLogDirectory(const juce::String& override)
{
    if (override.isNotEmpty())
    {
        juce::File dir(override);
        dir.createDirectory();
        return dir;
    }
    const auto exe = juce::File::getSpecialLocation(juce::File::currentExecutableFile);
    const auto repoRoot = exe.getParentDirectory().getParentDirectory().getParentDirectory().getParentDirectory();
    const auto fallback =
        repoRoot.getChildFile(".logs").getChildFile("standalone-" + juce::String(currentIso8601Ms()).replace(":", "-"));
    fallback.createDirectory();
    return fallback;
}

} // namespace

void initialise(const juce::String& logDirOverride)
{
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_initialised)
    {
        return;
    }
    const auto dir = resolveLogDirectory(logDirOverride);
    const auto file = dir.getChildFile("backend.log");
    g_file.open(file.getFullPathName().toStdString(), std::ios::out | std::ios::app);
    if (!g_file.is_open())
    {
        // We can't log the logger's own failure (chicken-and-egg). Drop
        // a single stderr line so a developer can see why the file
        // doesn't appear later.
        std::cerr << "[log] failed to open backend.log at " << file.getFullPathName().toStdString() << '\n';
        return;
    }
    g_initialised = true;
    // Mark the session boundary so a multi-run backend.log can be split
    // visually.
    g_file << currentIso8601Ms() << " INFO  [log] backend logger initialised; logDir="
           << dir.getFullPathName().toStdString() << '\n';
    g_file.flush();
}

void shutdown()
{
    std::lock_guard<std::mutex> lock(g_mutex);
    if (!g_initialised)
    {
        return;
    }
    g_file << currentIso8601Ms() << " INFO  [log] backend logger shutdown\n";
    g_file.flush();
    g_file.close();
    g_initialised = false;
}

void write(Level level, const char* tag, const juce::String& message)
{
    std::lock_guard<std::mutex> lock(g_mutex);
    if (!g_initialised)
    {
        return;
    }
    g_file << currentIso8601Ms() << ' ' << levelName(level) << " [" << (tag != nullptr ? tag : "?") << "] "
           << message.toStdString() << '\n';
    g_file.flush();
}

} // namespace silverdaw::log
