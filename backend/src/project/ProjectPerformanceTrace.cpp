#include "ProjectPerformanceTrace.h"

#include "Log.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <process.h>
#include <string_view>

namespace silverdaw
{
namespace
{
thread_local ProjectPerformanceTrace* currentTrace = nullptr;

constexpr std::array<const char*, static_cast<size_t>(ProjectPerformancePhase::Count)> phaseNames{
    "entry",
    "loadFile",
    "unloadClips",
    "rebuildEngine",
    "primePlayback",
    "projectSnapshotBuild",
    "projectSnapshotSend",
    "capturePluginState",
    "migrateArtifacts",
    "saveFile",
    "markClean",
    "saveAcknowledgement",
    "saveViewState",
    "treeSerialization",
    "portablePaths",
    "jsonFormatting",
    "fileWrite",
    "atomicReplace",
    "clipConstruction",
    "sourcePreparation",
    "trackFx",
    "latencyRecompute",
    "renderSnapshotBuild",
    "renderSnapshotPublish",
    "envelopeSerialization",
    "finalize"};

double milliseconds(ProjectPerformanceTrace::Timestamp from, ProjectPerformanceTrace::Timestamp to) noexcept
{
    return std::chrono::duration<double, std::milli>(to - from).count();
}
} // namespace

struct ProjectPerformanceTrace::State
{
    struct Timing
    {
        std::uint64_t calls = 0;
        double totalMs = 0.0;
        double maxMs = 0.0;
    };

    std::ofstream output;
    juce::String operation;
    juce::String operationId = juce::Uuid().toString();
    Timestamp started = Clock::now();
    Timestamp phaseStarted = started;
    Timestamp nextProgress = started + std::chrono::seconds(1);
    double queueWaitMs = 0.0;
    std::uint64_t projectStateBytes = 0;
    ProjectPerformancePhase phase = ProjectPerformancePhase::Entry;
    std::array<Timing, phaseNames.size()> timings{};
};

const juce::String& ProjectPerformanceTrace::configuredOutputPath()
{
    static const auto path = juce::SystemStats::getEnvironmentVariable("SILVERDAW_PERFORMANCE_TRACE_FILE", {});
    return path;
}

std::optional<ProjectPerformanceTrace::Timestamp> ProjectPerformanceTrace::queuedAt(const juce::String& command)
{
    if (configuredOutputPath().isEmpty())
        return std::nullopt;
    for (const auto* selected : {"PROJECT_LOAD", "PROJECT_LOAD_RECOVERY", "PROJECT_SAVE", "PROJECT_SAVE_AS",
                                 "PROJECT_AUTOSAVE", "PROJECT_SAVE_VIEW_STATE"})
        if (command == selected)
            return Clock::now();
    return std::nullopt;
}

ProjectPerformanceTrace::ProjectPerformanceTrace(const juce::String& operation, std::optional<Timestamp> queued,
                                                 const juce::String& outputPath)
    : previous(currentTrace)
{
    currentTrace = nullptr;
    if (!queued.has_value() || outputPath.isEmpty())
        return;
    const auto entered = Clock::now();
    if (!juce::File::isAbsolutePath(outputPath) || !juce::File(outputPath).getParentDirectory().isDirectory())
    {
        log::error("performance", "Trace target must be absolute with an existing parent directory");
        return;
    }

    state = std::make_unique<State>();
    state->started = entered;
    state->operation = operation;
    state->queueWaitMs = milliseconds(*queued, state->started);
    state->output.open(std::filesystem::path(outputPath.toWideCharPointer()), std::ios::out | std::ios::app);
    if (!state->output.is_open())
    {
        log::error("performance", "Cannot open project performance trace");
        state.reset();
        return;
    }
    currentTrace = this;
    writeRecord("phase");
    state->phaseStarted = Clock::now();
}

ProjectPerformanceTrace::~ProjectPerformanceTrace()
{
    if (state && state->output.good())
    {
        record(state->phase, milliseconds(state->phaseStarted, Clock::now()));
        writeRecord("return");
    }
    currentTrace = previous;
}

void ProjectPerformanceTrace::checkpoint(ProjectPerformancePhase phase)
{
    if (currentTrace != nullptr)
        currentTrace->advance(phase);
}

void ProjectPerformanceTrace::progress()
{
    auto* trace = currentTrace;
    if (trace == nullptr)
        return;
    const auto started = Clock::now();
    if (started < trace->state->nextProgress)
        return;
    trace->writeRecord("progress");
    const auto finished = Clock::now();
    trace->state->phaseStarted += finished - started;
    trace->state->nextProgress = finished + std::chrono::seconds(1);
}

void ProjectPerformanceTrace::recordProjectStateBytes(std::size_t bytes) noexcept
{
    if (currentTrace != nullptr)
        currentTrace->state->projectStateBytes += bytes;
}

void ProjectPerformanceTrace::advance(ProjectPerformancePhase phase)
{
    record(state->phase, milliseconds(state->phaseStarted, Clock::now()));
    state->phase = phase;
    writeRecord("phase");
    state->phaseStarted = Clock::now();
}

void ProjectPerformanceTrace::record(ProjectPerformancePhase phase, double elapsedMs) noexcept
{
    auto& timing = state->timings[static_cast<size_t>(phase)];
    ++timing.calls;
    timing.totalMs += elapsedMs;
    timing.maxMs = std::max(timing.maxMs, elapsedMs);
}

void ProjectPerformanceTrace::writeRecord(const char* event)
{
    auto* entry = new juce::DynamicObject();
    entry->setProperty("version", 1);
    entry->setProperty("operation", state->operation);
    entry->setProperty("operationId", state->operationId);
    entry->setProperty("event", event);
    entry->setProperty("processId", static_cast<juce::int64>(::_getpid()));
    entry->setProperty("timestampUnixMs", juce::Time::getCurrentTime().toMilliseconds());
    entry->setProperty("phase", phaseNames[static_cast<size_t>(state->phase)]);
    entry->setProperty("queueWaitMs", state->queueWaitMs);
    entry->setProperty("projectStateBytes", static_cast<juce::int64>(state->projectStateBytes));
    entry->setProperty("elapsedMs", milliseconds(state->started, Clock::now()));
    if (std::string_view(event) == "progress")
        entry->setProperty("phaseElapsedMs", milliseconds(state->phaseStarted, Clock::now()));
    auto* phases = new juce::DynamicObject();
    for (size_t i = 0; i < state->timings.size(); ++i)
    {
        const auto& timing = state->timings[i];
        if (timing.calls == 0)
            continue;
        auto* values = new juce::DynamicObject();
        values->setProperty("calls", static_cast<juce::int64>(timing.calls));
        values->setProperty("totalMs", timing.totalMs);
        values->setProperty("maxMs", timing.maxMs);
        phases->setProperty(phaseNames[i], juce::var(values));
    }
    entry->setProperty("timings", juce::var(phases));
    state->output << juce::JSON::toString(juce::var(entry), true).toStdString() << '\n';
    state->output.flush();
    if (!state->output.good())
    {
        log::error("performance", "Failed to write project performance trace");
        currentTrace = nullptr;
    }
}

ProjectPerformanceSpan::ProjectPerformanceSpan(ProjectPerformancePhase phaseIn) noexcept
    : trace(currentTrace), phase(phaseIn)
{
    if (trace != nullptr)
        started = ProjectPerformanceTrace::Clock::now();
}

ProjectPerformanceSpan::~ProjectPerformanceSpan() noexcept
{
    if (trace != nullptr)
        trace->record(phase, milliseconds(started, ProjectPerformanceTrace::Clock::now()));
}

} // namespace silverdaw
