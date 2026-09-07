#include "RecordingCalibrationCommands.h"

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "Log.h"
#include "RecordingCommands.h"
#include "recording/LatencyCalibrator.h"
#include "recording/RecordingSessionController.h"

#include <juce_events/juce_events.h>

namespace silverdaw
{
namespace
{
constexpr int kCalibrationProtocolVersion = 1;

recording::LatencyCalibrator& calibrator()
{
    static recording::LatencyCalibrator instance;
    return instance;
}

/** Bumped whenever a run is abandoned, so a measurement already in the worker cannot arrive
 *  after the user has cancelled and reinstate a result they walked away from. */
int& calibrationGeneration()
{
    static int generation = 0;
    return generation;
}

/** Throwaway captures go to the system temp directory, not the project: they are deleted the
 *  moment they have been measured, and calibration must work with no project open. */
juce::File calibrationWorkingDirectory()
{
    return juce::File::getSpecialLocation(juce::File::tempDirectory)
        .getChildFile("Silverdaw")
        .getChildFile("calibration");
}

void broadcastCalibrationState(BridgeServer& bridge, const juce::String& status, int detected,
                               int expected, double roundTripMs, const juce::String& error)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("protocolVersion", kCalibrationProtocolVersion);
    obj->setProperty("status", status);
    obj->setProperty("clicksDetected", detected);
    obj->setProperty("clicksTotal", expected);
    obj->setProperty("roundTripMs", roundTripMs > 0.0 ? juce::var(roundTripMs) : juce::var());
    if (error.isNotEmpty()) obj->setProperty("error", error);
    bridge.broadcast("RECORD_CALIBRATE_STATE", juce::var(obj));
}

void broadcastFailure(BridgeServer& bridge, const juce::String& error)
{
    broadcastCalibrationState(bridge, "failed", 0, recording::kCalibrationClickCount, 0.0, error);
}
} // namespace

void handleRecordCalibrateStart(const juce::var&, AudioEngine& engine, BridgeServer& bridge,
                                juce::ThreadPool& peakPool)
{
    auto& session = activeRecordingSession();
    if (! session.hasSession())
    {
        broadcastFailure(bridge, "Open the record window before calibrating.");
        return;
    }

    const auto snapshot = session.getSnapshot();
    // Calibration takes over the input and the output, so it can only run when the session is
    // doing neither. Anything else would measure the take rather than the click.
    if (snapshot.status != "idle")
    {
        broadcastFailure(bridge, "Finish the current take before calibrating.");
        return;
    }

    auto* device = session.getCaptureDevice();
    auto* tap = session.getCaptureTap();
    if (device == nullptr || tap == nullptr)
    {
        broadcastFailure(bridge, "No audio input is available to calibrate.");
        return;
    }

    auto& active = calibrator();
    active.onProgress = [&bridge]
    {
        broadcastCalibrationState(bridge, "measuring", calibrator().getEmittedCount(),
                                  calibrator().getExpectedCount(), 0.0, {});
    };
    // Reading the capture back is file I/O and belongs off the message thread (ADR 0006), the
    // same split the recording finalise uses.
    active.onCaptureReady = [&engine, &bridge, &peakPool,
                             generation = calibrationGeneration()](recording::CalibrationCapture capture)
    {
        peakPool.addJob(
            [capture, generation, &engine, &bridge]() mutable
            {
                if (capture.tap != nullptr) capture.tap->waitForQuiescence();
                const bool wrote = capture.writer != nullptr && capture.writer->finish();
                capture.writer.reset();

                recording::CalibrationOutcome outcome;
                if (capture.error.isNotEmpty())
                    outcome.error = capture.error;
                else if (! wrote)
                    outcome.error = "Nothing was captured. Check the input is receiving signal.";
                else
                    outcome = recording::measureRoundTrip(capture.file, engine.getFormatManager(),
                                                          capture.firstBlockTicks,
                                                          capture.emitTicks);
                capture.file.deleteFile();

                if (outcome.ok)
                    log::info("recording", "latency calibration measured "
                                               + juce::String(outcome.roundTripMs, 1) + "ms from "
                                               + juce::String(outcome.detected) + "/"
                                               + juce::String(outcome.expected) + " bursts");
                else
                    log::warn("recording", "latency calibration failed: " + outcome.error);

                juce::MessageManager::callAsync(
                    [&bridge, outcome, generation]
                    {
                        if (generation != calibrationGeneration()) return;
                        broadcastCalibrationState(bridge, outcome.ok ? "measured" : "failed",
                                                  outcome.detected, outcome.expected,
                                                  outcome.roundTripMs, outcome.error);
                    });
            });
    };

    juce::String error;
    if (! active.start(engine, *device, *tap, snapshot.firstChannel, calibrationWorkingDirectory(),
                       error))
    {
        broadcastFailure(bridge, error.isNotEmpty() ? error : juce::String("Calibration could not start."));
        return;
    }

    log::info("recording", "RECORD_CALIBRATE_START");
    broadcastCalibrationState(bridge, "measuring", 0, active.getExpectedCount(), 0.0, {});
}

void handleRecordCalibrateCancel(const juce::var&, BridgeServer& bridge)
{
    ++calibrationGeneration();
    calibrator().cancel();
    broadcastCalibrationState(bridge, "idle", 0, recording::kCalibrationClickCount, 0.0, {});
}

} // namespace silverdaw
