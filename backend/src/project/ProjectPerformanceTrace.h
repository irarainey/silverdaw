#pragma once

#include <chrono>
#include <cstddef>
#include <juce_core/juce_core.h>
#include <memory>
#include <optional>

namespace silverdaw
{

enum class ProjectPerformancePhase
{
    Entry,
    LoadFile,
    UnloadClips,
    RebuildEngine,
    PrimePlayback,
    ProjectSnapshotBuild,
    ProjectSnapshotSend,
    CapturePluginState,
    MigrateArtifacts,
    SaveFile,
    MarkClean,
    SaveAcknowledgement,
    SaveViewState,
    TreeSerialization,
    PortablePaths,
    JsonFormatting,
    FileWrite,
    AtomicReplace,
    ClipConstruction,
    SourcePreparation,
    TrackFx,
    LatencyRecompute,
    RenderSnapshotBuild,
    RenderSnapshotPublish,
    EnvelopeSerialization,
    Finalize,
    Count
};

// Opt-in control-thread diagnostics. Never construct or record on the audio callback.
class ProjectPerformanceTrace
{
  public:
    using Clock = std::chrono::steady_clock;
    using Timestamp = Clock::time_point;

    static const juce::String& configuredOutputPath();
    static std::optional<Timestamp> queuedAt(const juce::String& command);
    static void checkpoint(ProjectPerformancePhase phase);
    static void progress();
    static void recordProjectStateBytes(std::size_t bytes) noexcept;

    ProjectPerformanceTrace(const juce::String& operation, std::optional<Timestamp> queued,
                            const juce::String& outputPath = configuredOutputPath());
    ~ProjectPerformanceTrace();

    ProjectPerformanceTrace(const ProjectPerformanceTrace&) = delete;
    ProjectPerformanceTrace& operator=(const ProjectPerformanceTrace&) = delete;

  private:
    friend class ProjectPerformanceSpan;
    struct State;
    std::unique_ptr<State> state;
    ProjectPerformanceTrace* previous = nullptr;

    void record(ProjectPerformancePhase phase, double elapsedMs) noexcept;
    void writeRecord(const char* event);
    void advance(ProjectPerformancePhase phase);
};

class ProjectPerformanceSpan
{
  public:
    explicit ProjectPerformanceSpan(ProjectPerformancePhase phase) noexcept;
    ~ProjectPerformanceSpan() noexcept;

    ProjectPerformanceSpan(const ProjectPerformanceSpan&) = delete;
    ProjectPerformanceSpan& operator=(const ProjectPerformanceSpan&) = delete;

  private:
    ProjectPerformanceTrace* trace = nullptr;
    ProjectPerformancePhase phase;
    ProjectPerformanceTrace::Timestamp started;
};

} // namespace silverdaw
