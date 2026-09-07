#include "recording/LatencyCalibrator.h"

#include "core/Log.h"
#include "engine/AudioEngine.h"
#include "recording/LatencyCalibration.h"

#include <limits>

namespace silverdaw::recording
{
namespace
{
constexpr int kPollIntervalMs = 50;
/** Anything quieter than this is room noise rather than a burst. Deliberately generous: the
 *  bursts play at a known level, and a threshold that chased the noise floor would start
 *  finding the noise. */
constexpr float kBurstFloor = 0.05F;
/** Ceiling on a whole run, so a device that never delivers a block cannot hang the dialog. */
constexpr double kRunOverrunMs = 2000.0;
} // namespace

LatencyCalibrator::~LatencyCalibrator()
{
    cancel();
}

bool LatencyCalibrator::start(AudioEngine& audioEngine, CaptureDevice& captureDevice,
                              InputCaptureTap& captureTap, int firstChannel,
                              const juce::File& workingDirectory, juce::String& error)
{
    if (running)
    {
        error = "A calibration is already running";
        return false;
    }
    if (! captureDevice.isOpen())
    {
        error = "No audio input is open";
        return false;
    }

    engine = &audioEngine;
    tap = &captureTap;
    captureRate = captureDevice.getSampleRate() > 0.0 ? captureDevice.getSampleRate() : 48000.0;

    const double runMs = kCalibrationClickCount * kCalibrationSpacingMs + kCalibrationTailMs;
    const auto expectedSamples = static_cast<juce::int64>(captureRate * (runMs + kRunOverrunMs) / 1000.0);

    workingDirectory.createDirectory();
    captureFile =
        workingDirectory.getChildFile("calibration-" + juce::Uuid().toDashedString() + ".wav");

    writer = std::make_shared<RecordingWriter>();
    if (! writer->start(captureFile, captureRate, 1, expectedSamples, error))
    {
        writer.reset();
        teardown();
        return false;
    }

    running = true;
    emittedCount = 0;
    tailDeadlineMs = 0.0;
    hardDeadlineMs = juce::Time::getMillisecondCounterHiRes() + runMs + kRunOverrunMs;

    tap->resetCaptureStats();
    tap->setGain(1.0F);
    tap->setMaxSamples(0);
    // One channel only, matching the writer: the round trip is a time, and a second channel
    // just doubles what has to be read back. The session re-applies its own selection when it
    // next arms, so narrowing it here is not sticky.
    tap->setChannelSelection(firstChannel, 1);
    tap->setWriter(writer->getThreadedWriter());

    // Loud: the bursts have to survive the room, the microphone's own processing and whatever
    // the master fader is set to, and a measurement that cannot hear them is no measurement.
    engine->startCalibrationClicks(kCalibrationClickCount, kCalibrationSpacingMs, 0.8F);
    startTimer(kPollIntervalMs);
    log::info("recording", "latency calibration started at " + juce::String(captureRate, 0) + " Hz");
    return true;
}

void LatencyCalibrator::cancel()
{
    if (! running) return;
    stopTimer();
    if (engine != nullptr) engine->cancelCalibrationClicks();
    if (tap != nullptr)
    {
        tap->setWriter(nullptr);
        tap->waitForQuiescence();
    }
    if (writer != nullptr) writer->abort();
    log::info("recording", "latency calibration cancelled");
    teardown();
}

void LatencyCalibrator::timerCallback()
{
    if (! running || engine == nullptr) return;

    const int emitted = engine->getCalibrationClicksEmitted();
    if (emitted != emittedCount)
    {
        emittedCount = emitted;
        if (onProgress) onProgress();
    }

    const double now = juce::Time::getMillisecondCounterHiRes();
    if (tailDeadlineMs <= 0.0 && ! engine->isCalibrationClickActive())
        tailDeadlineMs = now + kCalibrationTailMs;

    if ((tailDeadlineMs > 0.0 && now >= tailDeadlineMs) || now >= hardDeadlineMs) finishCapture();
}

void LatencyCalibrator::finishCapture()
{
    stopTimer();
    if (! running) return;

    CalibrationCapture capture;
    capture.file = captureFile;
    capture.writer = writer;
    capture.tap = tap;
    capture.firstBlockTicks = tap != nullptr ? tap->getFirstBlockTicks() : 0;

    const int emitted = engine != nullptr ? engine->getCalibrationClicksEmitted() : 0;
    capture.emitTicks.reserve(static_cast<size_t>(emitted));
    for (int i = 0; i < emitted; ++i) capture.emitTicks.push_back(engine->getCalibrationEmitTick(i));

    if (engine != nullptr) engine->cancelCalibrationClicks();
    if (tap != nullptr) tap->setWriter(nullptr);

    if (capture.firstBlockTicks == 0 || capture.emitTicks.empty())
        capture.error = "Nothing was captured. Check the input is receiving signal.";

    teardown();
    if (onCaptureReady) onCaptureReady(std::move(capture));
}

void LatencyCalibrator::teardown()
{
    running = false;
    emittedCount = 0;
    tailDeadlineMs = 0.0;
    engine = nullptr;
    tap = nullptr;
    writer.reset();
    captureFile = juce::File();
}

CalibrationOutcome measureRoundTrip(const juce::File& captureFile,
                                    juce::AudioFormatManager& formats, juce::int64 firstBlockTicks,
                                    const std::vector<juce::int64>& emitTicks)
{
    CalibrationOutcome outcome;
    outcome.expected = static_cast<int>(emitTicks.size());

    std::unique_ptr<juce::AudioFormatReader> reader(formats.createReaderFor(captureFile));
    if (reader == nullptr || reader->lengthInSamples <= 0 || reader->sampleRate <= 0.0)
    {
        outcome.error = "The calibration capture could not be read back.";
        return outcome;
    }

    juce::AudioBuffer<float> buffer(1, static_cast<int>(reader->lengthInSamples));
    if (! reader->read(&buffer, 0, static_cast<int>(reader->lengthInSamples), 0, true, false))
    {
        outcome.error = "The calibration capture could not be read back.";
        return outcome;
    }

    const auto rate = reader->sampleRate;
    const auto minSpacing = static_cast<juce::int64>(rate * kCalibrationSpacingMs * 0.5 / 1000.0);
    const auto onsets =
        findBurstOnsets(buffer.getReadPointer(0), buffer.getNumSamples(), kBurstFloor, minSpacing);
    outcome.detected = static_cast<int>(onsets.size());

    if (onsets.empty())
    {
        outcome.error = "The clicks were not heard. Turn the output up, or move the microphone "
                        "closer to the speakers.";
        return outcome;
    }

    const auto ticksPerSecond = static_cast<double>(juce::Time::getHighResolutionTicksPerSecond());
    const double firstBlockMs = static_cast<double>(firstBlockTicks) / ticksPerSecond * 1000.0;

    // Each arrival is matched to the emission it most recently followed rather than by position,
    // so a swallowed burst costs one reading instead of shifting every reading after it.
    std::vector<double> readings;
    readings.reserve(onsets.size());
    for (auto onset : onsets)
    {
        const double arrivalMs = firstBlockMs + static_cast<double>(onset) * 1000.0 / rate;
        double best = std::numeric_limits<double>::max();
        for (auto emitTick : emitTicks)
        {
            const double delta =
                arrivalMs - static_cast<double>(emitTick) / ticksPerSecond * 1000.0;
            if (delta >= 0.0 && delta < best) best = delta;
        }
        if (best < std::numeric_limits<double>::max()) readings.push_back(best);
    }

    const auto agreed = agreedRoundTripMs(readings, kCalibrationAgreementMs);
    if (! agreed.has_value())
    {
        outcome.error = "The readings did not agree. Try again somewhere quieter, with the "
                        "output a little louder.";
        return outcome;
    }

    outcome.ok = true;
    outcome.roundTripMs = *agreed;
    return outcome;
}

} // namespace silverdaw::recording
