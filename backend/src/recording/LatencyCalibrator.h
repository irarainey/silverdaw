#pragma once

#include "recording/CaptureDevice.h"
#include "recording/InputCaptureTap.h"
#include "recording/RecordingWriter.h"

#include <juce_core/juce_core.h>

#include <functional>
#include <memory>
#include <vector>

namespace silverdaw
{
class AudioEngine;
}

namespace silverdaw::recording
{

/** How many bursts a run emits, and how far apart. Enough readings to throw away several
 *  swallowed by an echo canceller and still corroborate the rest, over a run short enough to
 *  sit through. */
inline constexpr int kCalibrationClickCount = 12;
inline constexpr double kCalibrationSpacingMs = 300.0;
/** Tail kept after the last burst so its echo is inside the capture even on a slow path. */
inline constexpr double kCalibrationTailMs = 700.0;

struct CalibrationOutcome
{
    bool ok = false;
    double roundTripMs = 0.0;
    int detected = 0;
    int expected = kCalibrationClickCount;
    juce::String error;
};

/** A finished calibration capture, handed to the commands layer to be read back and measured
 *  off the message thread — the same split the recording finalise uses (ADR 0006). */
struct CalibrationCapture
{
    juce::File file;
    std::shared_ptr<RecordingWriter> writer;
    InputCaptureTap* tap = nullptr;
    /** Wall-clock stamp of the capture's first sample, and of each burst as it was emitted.
     *  The round trip is the gap between them. */
    juce::int64 firstBlockTicks = 0;
    std::vector<juce::int64> emitTicks;
    juce::String error;
};

/**
 * Measures the real output-to-input round trip by playing bursts and listening for them
 * (ADR 0030, Amendment 17).
 *
 * This exists because Windows does not report the number. A processed capture endpoint hides
 * its DSP delay entirely and a shared-mode output reports little more than its buffer, so the
 * head trim built from those figures can be short by most of the true round trip. Playing a
 * sound and timing its return is the only way to see the whole path.
 *
 * Message thread only; the capture runs through the session's own tap.
 */
class LatencyCalibrator final : private juce::Timer
{
  public:
    ~LatencyCalibrator() override;

    /** Capture finished, or failed before anything was measurable; the caller reads it back off
     *  the message thread. Fired exactly once per successful `start`. */
    std::function<void(CalibrationCapture)> onCaptureReady;
    /** Fired as bursts are emitted, so the dialog can show progress. */
    std::function<void()> onProgress;

    /** Begins a run against the already-open capture device, listening on `firstChannel`.
     *  Returns false, having reported nothing, when the input is not open or a run is already
     *  going. */
    bool start(AudioEngine& engine, CaptureDevice& device, InputCaptureTap& tap, int firstChannel,
               const juce::File& workingDirectory, juce::String& error);
    /** Abandons a run and throws away its capture. Safe when nothing is running. */
    void cancel();

    bool isRunning() const noexcept { return running; }
    int getEmittedCount() const noexcept { return emittedCount; }

  private:
    void timerCallback() override;
    void finishCapture();
    void teardown();

    AudioEngine* engine = nullptr;
    InputCaptureTap* tap = nullptr;
    std::shared_ptr<RecordingWriter> writer;
    juce::File captureFile;
    double captureRate = 48000.0;
    bool running = false;
    int emittedCount = 0;
    /** Set once the last burst is out, so the tail is waited from there rather than from the
     *  start of the run — a slow path is exactly when the last echo is still in flight. */
    double tailDeadlineMs = 0.0;
    double hardDeadlineMs = 0.0;
};

/**
 * Turns a finished calibration capture into a round trip.
 *
 * Split from the run itself so it can be tested without an audio device: everything it needs is
 * the captured file, when its first sample was taken, and when each burst was emitted. Reads
 * the file, so worker thread only.
 */
CalibrationOutcome measureRoundTrip(const juce::File& captureFile,
                                    juce::AudioFormatManager& formats, juce::int64 firstBlockTicks,
                                    const std::vector<juce::int64>& emitTicks);

} // namespace silverdaw::recording
