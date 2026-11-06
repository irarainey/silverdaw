#include "ProjectPerformanceTrace.h"
#include "TestRegistry.h"

#include <process.h>
#include <thread>

namespace silverdaw::tests
{
namespace
{
using Phase = ProjectPerformancePhase;

juce::Array<juce::var> readTrace(const juce::File& file)
{
    juce::Array<juce::var> entries;
    for (const auto& line : juce::StringArray::fromLines(file.loadFileAsString()))
    {
        if (line.isEmpty())
            continue;
        const auto entry = juce::JSON::parse(line);
        require(entry.isObject(), "trace lines must be JSON objects");
        entries.add(entry);
    }
    return entries;
}

void testProjectTraceDisabledDoesNotWrite()
{
    const auto directory = makeTempDir("performance-trace-disabled");
    const auto file = directory.getChildFile("trace.jsonl");
    {
        ProjectPerformanceTrace trace("PROJECT_LOAD", std::nullopt, file.getFullPathName());
        ProjectPerformanceTrace::checkpoint(Phase::RebuildEngine);
        ProjectPerformanceTrace::progress();
        const ProjectPerformanceSpan span(Phase::ClipConstruction);
    }
    require(!file.existsAsFile(), "unselected operations must not open the trace");
    directory.deleteRecursively();
}

void testProjectTraceCheckpointsAndAggregateSpans()
{
    const auto directory = makeTempDir("performance-trace-phases");
    const auto file = directory.getChildFile("trace.jsonl");
    {
        ProjectPerformanceTrace trace("PROJECT_SAVE", ProjectPerformanceTrace::Clock::now(), file.getFullPathName());
        ProjectPerformanceTrace::checkpoint(Phase::SaveFile);
        const auto progress = readTrace(file);
        require(progress.size() == 2, "phase checkpoints must survive before the operation returns");
        requireEqual(progress.getLast()["phase"].toString(), "saveFile",
                     "progress must identify the phase about to run");
        for (int i = 0; i < 3; ++i)
        {
            const ProjectPerformanceSpan span(Phase::JsonFormatting);
        }
    }
    const auto entries = readTrace(file);
    require(entries.size() == 3, "per-item spans must aggregate without per-item writes");
    const auto last = entries.getLast();
    requireEqual(last["event"].toString(), "return", "return must close the operation");
    requireEqual(last["operationId"].toString(), entries[0]["operationId"].toString(),
                 "checkpoints must correlate to their operation");
    require(static_cast<double>(last["queueWaitMs"]) >= 0.0, "queue delay must be nonnegative");
    const auto formatting = last["timings"]["jsonFormatting"];
    require(static_cast<int>(formatting["calls"]) == 3, "spans must retain the full call count");
    require(static_cast<double>(formatting["totalMs"]) >= static_cast<double>(formatting["maxMs"]),
            "span aggregate must include its longest call");
    directory.deleteRecursively();
}

void testProjectTraceNestedAndWorkerIsolation()
{
    const auto directory = makeTempDir("performance-trace-context");
    const auto outerFile = directory.getChildFile("outer.jsonl");
    const auto innerFile = directory.getChildFile("inner.jsonl");
    {
        ProjectPerformanceTrace outer("outer", ProjectPerformanceTrace::Clock::now(), outerFile.getFullPathName());
        {
            const ProjectPerformanceSpan span(Phase::ClipConstruction);
        }
        std::thread worker([] { const ProjectPerformanceSpan span(Phase::ClipConstruction); });
        worker.join();
        {
            ProjectPerformanceTrace inner("inner", ProjectPerformanceTrace::Clock::now(), innerFile.getFullPathName());
            const ProjectPerformanceSpan span(Phase::ClipConstruction);
        }
        {
            const ProjectPerformanceSpan span(Phase::ClipConstruction);
        }
    }
    const auto outer = readTrace(outerFile).getLast();
    const auto inner = readTrace(innerFile).getLast();
    require(static_cast<int>(outer["timings"]["clipConstruction"]["calls"]) == 2,
            "nested operations and unrelated workers must not contaminate the outer trace");
    require(static_cast<int>(inner["timings"]["clipConstruction"]["calls"]) == 1,
            "nested operations must own their span counts");
    directory.deleteRecursively();
}

void testProjectTraceBoundedProgress()
{
    const auto directory = makeTempDir("performance-trace-progress");
    const auto file = directory.getChildFile("trace.jsonl");
    {
        ProjectPerformanceTrace trace("PROJECT_LOAD", ProjectPerformanceTrace::Clock::now(), file.getFullPathName());
        ProjectPerformanceTrace::checkpoint(Phase::RebuildEngine);
        {
            const ProjectPerformanceSpan span(Phase::ClipConstruction);
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1050));
        ProjectPerformanceTrace::progress();
        const auto entries = readTrace(file);
        require(entries.size() == 3, "bounded progress must be flushed while the operation is still running");
        const auto last = entries.getLast();
        requireEqual(last["event"].toString(), "progress", "progress must not imply a phase transition");
        requireEqual(last["phase"].toString(), "rebuildEngine", "progress must retain the active phase");
        requireEqual(last["operationId"].toString(), entries[0]["operationId"].toString(),
                     "progress must correlate to its operation");
        require(static_cast<juce::int64>(last["processId"]) == ::_getpid(),
                "progress must identify the backend generation");
        require(static_cast<juce::int64>(last["timestampUnixMs"]) > 0,
                "progress must carry an absolute timestamp for watchdog correlation");
        require(static_cast<double>(last["phaseElapsedMs"]) >= 1000.0,
                "progress must report elapsed time in the still-active phase");
        require(static_cast<int>(last["timings"]["clipConstruction"]["calls"]) == 1,
                "progress must retain completed span aggregates");
        ProjectPerformanceTrace::progress();
        require(readTrace(file).size() == entries.size(), "progress must not write per clip");
    }
    const auto last = readTrace(file).getLast();
    requireEqual(last["event"].toString(), "return", "progress must not replace the final return record");
    require(static_cast<int>(last["timings"]["rebuildEngine"]["calls"]) == 1,
            "progress must not split high-level phase counts");
    directory.deleteRecursively();
}
} // namespace

void addProjectPerformanceTraceTests(std::vector<TestCase>& tests)
{
    tests.push_back({"ProjectTrace_DisabledDoesNotWrite", testProjectTraceDisabledDoesNotWrite});
    tests.push_back({"ProjectTrace_CheckpointsAndAggregateSpans", testProjectTraceCheckpointsAndAggregateSpans});
    tests.push_back({"ProjectTrace_NestedAndWorkerIsolation", testProjectTraceNestedAndWorkerIsolation});
    tests.push_back({"ProjectTrace_BoundedProgress", testProjectTraceBoundedProgress});
}
} // namespace silverdaw::tests
