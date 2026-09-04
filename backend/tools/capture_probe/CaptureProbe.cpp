// Phase A capture spike for ADR 0030 (audio recording).
//
// Silverdaw opens its playback device output-only on purpose, and ADR 0030
// decides that capture runs on a *standalone* input-only device outside the
// engine's AudioDeviceManager. That decision rests on three claims this probe
// exists to measure on real hardware, because none of them can be settled by
// reading code:
//
//   1. Opening and closing a standalone capture device never restarts, stalls
//      or reconfigures the running playback stream.
//   2. Round-trip latency and the relative clock drift between two independent
//      devices are small enough to be corrected once, offline, at finalise.
//   3. The failure modes (denied microphone consent, device loss mid-capture)
//      are distinguishable from a working capture, so the UI can report them.
//
// Dev tool, not shipped, not a CTest test. It writes silence to the output by
// default so it is safe to run on speakers; pass --tone for an audible -30 dBFS
// sine if you want to hear the playback stream survive the capture open.
//
// Run:
//   SilverdawCaptureProbe [--seconds N] [--input "<name>"] [--type "<type>"]
//                         [--tone] [--list]

#include <juce_audio_devices/juce_audio_devices.h>

#include <atomic>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <memory>

namespace
{
constexpr double kDefaultCaptureSeconds = 60.0;
constexpr double kSettleSeconds = 2.0;
// A gap this much larger than the nominal block period is a stall, not jitter.
constexpr double kGapAlarmFactor = 4.0;

double ticksToSeconds(juce::int64 ticks)
{
    return juce::Time::highResolutionTicksToSeconds(ticks);
}

juce::String fmt(double value, int decimals)
{
    return juce::String(value, decimals);
}

// Shared by both streams: enough to reconstruct rate, continuity and level
// after the fact without allocating or locking on the audio thread.
struct StreamStats
{
    std::atomic<juce::int64> callbacks{0};
    std::atomic<juce::int64> samples{0};
    std::atomic<juce::int64> firstTick{0};
    std::atomic<juce::int64> lastTick{0};
    std::atomic<juce::int64> maxGapTicks{0};
    std::atomic<int> starts{0};
    std::atomic<int> stops{0};
    std::atomic<float> peak{0.0F};

    void reset()
    {
        callbacks = 0;
        samples = 0;
        firstTick = 0;
        lastTick = 0;
        maxGapTicks = 0;
        peak = 0.0F;
    }

    void noteBlock(int numSamples, juce::int64 now)
    {
        const auto previous = lastTick.exchange(now, std::memory_order_relaxed);
        if (previous != 0)
        {
            const auto gap = now - previous;
            auto current = maxGapTicks.load(std::memory_order_relaxed);
            while (gap > current
                   && ! maxGapTicks.compare_exchange_weak(current, gap,
                                                          std::memory_order_relaxed))
            {
            }
        }
        else
        {
            firstTick.store(now, std::memory_order_relaxed);
        }
        callbacks.fetch_add(1, std::memory_order_relaxed);
        samples.fetch_add(numSamples, std::memory_order_relaxed);
    }

    void notePeak(float value)
    {
        auto current = peak.load(std::memory_order_relaxed);
        while (value > current
               && ! peak.compare_exchange_weak(current, value, std::memory_order_relaxed))
        {
        }
    }

    // Sample rate implied by the wall clock, which is what drift is measured
    // against. Only meaningful once at least two callbacks have landed.
    double measuredRate() const
    {
        const auto span = ticksToSeconds(lastTick.load() - firstTick.load());
        if (span <= 0.0) return 0.0;
        const auto counted = static_cast<double>(samples.load());
        return counted > 0.0 ? counted / span : 0.0;
    }
};

// Playback side. Deliberately trivial: the point is not what it renders but
// whether it keeps rendering, uninterrupted, while capture opens and closes.
class OutputProbeCallback final : public juce::AudioIODeviceCallback
{
public:
    explicit OutputProbeCallback(bool audibleTone) : tone(audibleTone) {}

    StreamStats stats;
    std::atomic<bool> sawError{false};
    juce::String lastError;

    void audioDeviceIOCallbackWithContext(const float* const*, int,
                                          float* const* outputChannelData,
                                          int numOutputChannels, int numSamples,
                                          const juce::AudioIODeviceCallbackContext&) override
    {
        stats.noteBlock(numSamples, juce::Time::getHighResolutionTicks());

        for (int channel = 0; channel < numOutputChannels; ++channel)
        {
            auto* out = outputChannelData[channel];
            if (out == nullptr) continue;

            if (! tone)
            {
                juce::FloatVectorOperations::clear(out, numSamples);
                continue;
            }

            for (int sample = 0; sample < numSamples; ++sample)
                out[sample] = static_cast<float>(0.0316 * std::sin(phase + sample * phaseStep));
        }

        if (tone)
        {
            phase += phaseStep * numSamples;
            phase = std::fmod(phase, 2.0 * juce::MathConstants<double>::pi);
        }
    }

    void audioDeviceAboutToStart(juce::AudioIODevice* device) override
    {
        stats.starts.fetch_add(1, std::memory_order_relaxed);
        if (device != nullptr && device->getCurrentSampleRate() > 0.0)
            phaseStep = 2.0 * juce::MathConstants<double>::pi * 440.0
                        / device->getCurrentSampleRate();
    }

    void audioDeviceStopped() override { stats.stops.fetch_add(1, std::memory_order_relaxed); }

    void audioDeviceError(const juce::String& message) override
    {
        sawError = true;
        lastError = message;
    }

private:
    bool tone = false;
    double phase = 0.0;
    double phaseStep = 0.0;
};

// Capture side. Models the real design's audio-thread discipline: counters and
// atomics only, no allocation, no locking, no logging.
class CaptureProbeCallback final : public juce::AudioIODeviceCallback
{
public:
    StreamStats stats;
    std::atomic<bool> sawError{false};
    juce::String lastError;

    void audioDeviceIOCallbackWithContext(const float* const* inputChannelData,
                                          int numInputChannels, float* const* outputChannelData,
                                          int numOutputChannels, int numSamples,
                                          const juce::AudioIODeviceCallbackContext&) override
    {
        stats.noteBlock(numSamples, juce::Time::getHighResolutionTicks());

        for (int channel = 0; channel < numInputChannels; ++channel)
        {
            const auto* in = inputChannelData[channel];
            if (in == nullptr) continue;
            const auto range = juce::FloatVectorOperations::findMinAndMax(in, numSamples);
            stats.notePeak(juce::jmax(std::abs(range.getStart()), std::abs(range.getEnd())));
        }

        // An input-only device should present no outputs; clear defensively.
        for (int channel = 0; channel < numOutputChannels; ++channel)
            if (outputChannelData[channel] != nullptr)
                juce::FloatVectorOperations::clear(outputChannelData[channel], numSamples);
    }

    void audioDeviceAboutToStart(juce::AudioIODevice*) override
    {
        stats.starts.fetch_add(1, std::memory_order_relaxed);
    }

    void audioDeviceStopped() override { stats.stops.fetch_add(1, std::memory_order_relaxed); }

    void audioDeviceError(const juce::String& message) override
    {
        sawError = true;
        lastError = message;
    }
};

struct Options
{
    double seconds = kDefaultCaptureSeconds;
    juce::String inputName;
    juce::String typeName;
    bool tone = false;
    bool listOnly = false;
};

Options parseOptions(int argc, char* argv[])
{
    Options options;
    for (int i = 1; i < argc; ++i)
    {
        const juce::String arg(argv[i]);
        const auto next = [&]() -> juce::String {
            return i + 1 < argc ? juce::String(argv[++i]) : juce::String();
        };
        if (arg == "--seconds") options.seconds = juce::jmax(2.0, next().getDoubleValue());
        else if (arg == "--input") options.inputName = next();
        else if (arg == "--type") options.typeName = next();
        else if (arg == "--tone") options.tone = true;
        else if (arg == "--list") options.listOnly = true;
    }
    return options;
}

void printInputInventory(juce::AudioDeviceManager& manager)
{
    std::cout << "\n== Input devices (by driver type) ==\n";
    for (auto* type : manager.getAvailableDeviceTypes())
    {
        if (type == nullptr) continue;
        type->scanForDevices();
        const auto names = type->getDeviceNames(/*wantInputNames*/ true);
        std::cout << "  [" << type->getTypeName() << "]"
                  << (names.isEmpty() ? " (none)" : "") << "\n";
        for (const auto& name : names)
            std::cout << "      " << name << "\n";
    }
}

// Create a standalone input-only device, honouring an explicit type/name when
// given and otherwise taking the first input any type offers.
std::unique_ptr<juce::AudioIODevice> createCaptureDevice(juce::AudioDeviceManager& manager,
                                                         const Options& options,
                                                         juce::String& chosenType,
                                                         juce::String& chosenName)
{
    for (auto* type : manager.getAvailableDeviceTypes())
    {
        if (type == nullptr) continue;
        if (options.typeName.isNotEmpty() && type->getTypeName() != options.typeName) continue;

        type->scanForDevices();
        for (const auto& name : type->getDeviceNames(/*wantInputNames*/ true))
        {
            if (options.inputName.isNotEmpty() && name != options.inputName) continue;
            if (auto* device = type->createDevice(/*outputDeviceName*/ {}, name))
            {
                chosenType = type->getTypeName();
                chosenName = name;
                return std::unique_ptr<juce::AudioIODevice>(device);
            }
        }
    }
    return nullptr;
}

void reportWindow(const char* label, const StreamStats& stats, double nominalRate,
                  int bufferSize, double windowSeconds)
{
    const auto callbacks = stats.callbacks.load();
    const auto expectedPeriod =
        nominalRate > 0.0 && bufferSize > 0 ? bufferSize / nominalRate : 0.0;
    const auto maxGap = ticksToSeconds(stats.maxGapTicks.load());
    const auto stalled = expectedPeriod > 0.0 && maxGap > expectedPeriod * kGapAlarmFactor;

    std::cout << "  " << std::left << std::setw(24) << label
              << " callbacks=" << callbacks << "  expected~"
              << static_cast<juce::int64>(expectedPeriod > 0.0 ? windowSeconds / expectedPeriod
                                                               : 0.0)
              << "  maxGap=" << fmt(maxGap * 1000.0, 2) << " ms"
              << (stalled ? "   <-- STALL" : "") << "\n";
}
} // namespace

int main(int argc, char* argv[])
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    const auto options = parseOptions(argc, argv);

    juce::AudioDeviceManager manager;

    std::cout << "Silverdaw capture probe (ADR 0030, Phase A)\n";
    printInputInventory(manager);
    if (options.listOnly) return 0;

    // Open playback exactly as AudioEngine::openDefaultOutputOnly() does, so the
    // probe measures the real configuration rather than a convenient one.
    juce::AudioDeviceManager::AudioDeviceSetup outputOnly;
    outputOnly.inputDeviceName = {};
    outputOnly.inputChannels.clear();
    outputOnly.useDefaultInputChannels = false;
    outputOnly.useDefaultOutputChannels = true;
    const auto outputError = manager.initialise(0, 2, nullptr, true, {}, &outputOnly);
    if (outputError.isNotEmpty())
    {
        std::cout << "FAIL: could not open output device: " << outputError << "\n";
        return 2;
    }

    auto* outputDevice = manager.getCurrentAudioDevice();
    if (outputDevice == nullptr)
    {
        std::cout << "FAIL: no current output device after initialise\n";
        return 2;
    }

    OutputProbeCallback outputProbe(options.tone);
    manager.addAudioCallback(&outputProbe);

    const auto outRate = outputDevice->getCurrentSampleRate();
    const auto outBuffer = outputDevice->getCurrentBufferSizeSamples();
    const auto outLatency = outputDevice->getOutputLatencyInSamples();
    std::cout << "\n== Playback stream ==\n"
              << "  type=" << outputDevice->getTypeName() << "  device=" << outputDevice->getName()
              << "\n  rate=" << fmt(outRate, 1) << " Hz  buffer=" << outBuffer
              << "  outputLatency=" << outLatency << " samples ("
              << fmt(1000.0 * outLatency / juce::jmax(1.0, outRate), 2) << " ms)\n";

    // --- Claim 1: opening capture must not disturb playback -----------------
    std::cout << "\n== Claim 1: does opening capture disturb playback? ==\n";
    outputProbe.stats.reset();
    juce::Thread::sleep(static_cast<int>(kSettleSeconds * 1000.0));
    reportWindow("baseline (no capture)", outputProbe.stats, outRate, outBuffer, kSettleSeconds);

    juce::String captureType, captureName;
    auto captureDevice = createCaptureDevice(manager, options, captureType, captureName);
    if (captureDevice == nullptr)
    {
        std::cout << "\nNo input device available (or none matched --input/--type).\n"
                  << "This is itself a Phase A result: the UI must handle it.\n";
        manager.removeAudioCallback(&outputProbe);
        return 1;
    }

    const auto startsBeforeOpen = outputProbe.stats.starts.load();
    const auto stopsBeforeOpen = outputProbe.stats.stops.load();

    juce::BigInteger inputChannels;
    inputChannels.setRange(0, juce::jmax(1, captureDevice->getInputChannelNames().size()), true);
    const juce::BigInteger noOutputs;
    const auto requestedRate =
        captureDevice->getCurrentSampleRate() > 0.0 ? captureDevice->getCurrentSampleRate() : outRate;
    const auto openError = captureDevice->open(inputChannels, noOutputs, requestedRate,
                                               captureDevice->getDefaultBufferSize());
    if (openError.isNotEmpty())
    {
        std::cout << "  capture open FAILED: " << openError << "\n";
        manager.removeAudioCallback(&outputProbe);
        return 1;
    }

    CaptureProbeCallback captureProbe;
    outputProbe.stats.reset();
    captureDevice->start(&captureProbe);
    juce::Thread::sleep(static_cast<int>(kSettleSeconds * 1000.0));
    reportWindow("while capture running", outputProbe.stats, outRate, outBuffer, kSettleSeconds);

    const auto inRate = captureDevice->getCurrentSampleRate();
    const auto inBuffer = captureDevice->getCurrentBufferSizeSamples();
    const auto inLatency = captureDevice->getInputLatencyInSamples();
    std::cout << "\n== Capture stream ==\n"
              << "  type=" << captureType << "  device=" << captureName
              << "\n  rate=" << fmt(inRate, 1) << " Hz  buffer=" << inBuffer
              << "  channels=" << captureDevice->getActiveInputChannels().countNumberOfSetBits()
              << "\n  inputLatency=" << inLatency << " samples ("
              << fmt(1000.0 * inLatency / juce::jmax(1.0, inRate), 2) << " ms)\n";

    const auto roundTripMs = 1000.0 * inLatency / juce::jmax(1.0, inRate)
                             + 1000.0 * outLatency / juce::jmax(1.0, outRate);
    std::cout << "  reported round trip (input + output) = " << fmt(roundTripMs, 2) << " ms\n";

    // --- Claims 2 and 3: drift, level and failure signalling ----------------
    std::cout << "\n== Claims 2/3: drift and capture health over " << fmt(options.seconds, 0)
              << " s ==\n"
              << "  (unplug the capture device during this window to exercise device loss)\n";

    outputProbe.stats.reset();
    captureProbe.stats.reset();
    const auto measureStart = juce::Time::getHighResolutionTicks();
    juce::Thread::sleep(static_cast<int>(options.seconds * 1000.0));
    const auto measuredSeconds = ticksToSeconds(juce::Time::getHighResolutionTicks() - measureStart);

    const auto capturedRate = captureProbe.stats.measuredRate();
    const auto renderedRate = outputProbe.stats.measuredRate();
    const auto capturePpm =
        inRate > 0.0 && capturedRate > 0.0 ? (capturedRate - inRate) / inRate * 1.0e6 : 0.0;
    const auto outputPpm =
        outRate > 0.0 && renderedRate > 0.0 ? (renderedRate - outRate) / outRate * 1.0e6 : 0.0;
    const auto relativePpm = capturePpm - outputPpm;

    std::cout << "  wall clock       = " << fmt(measuredSeconds, 3) << " s\n"
              << "  captured samples = " << captureProbe.stats.samples.load() << "  -> measured "
              << fmt(capturedRate, 3) << " Hz (" << fmt(capturePpm, 1) << " ppm vs nominal)\n"
              << "  rendered samples = " << outputProbe.stats.samples.load() << "  -> measured "
              << fmt(renderedRate, 3) << " Hz (" << fmt(outputPpm, 1) << " ppm vs nominal)\n"
              << "  RELATIVE DRIFT   = " << fmt(relativePpm, 1) << " ppm  = "
              << fmt(std::abs(relativePpm) * 60.0 / 1000.0, 2) << " ms per minute\n";

    reportWindow("playback continuity", outputProbe.stats, outRate, outBuffer, options.seconds);
    reportWindow("capture continuity", captureProbe.stats, inRate, inBuffer, options.seconds);

    const auto peak = captureProbe.stats.peak.load();
    std::cout << "  capture peak     = " << fmt(peak, 6);
    if (peak <= 0.0F)
        std::cout << "   <-- DIGITAL SILENCE (consent denied, muted, or wrong endpoint)";
    std::cout << "\n";

    if (captureProbe.sawError)
        std::cout << "  capture error    = " << captureProbe.lastError << "\n";
    if (outputProbe.sawError)
        std::cout << "  playback error   = " << outputProbe.lastError << "\n";
    if (captureProbe.stats.stops.load() > 0)
        std::cout << "  capture stopped mid-run (device loss signalled)\n";

    // --- Claim 1 again: closing capture must not disturb playback -----------
    captureDevice->stop();
    captureDevice->close();
    captureDevice.reset();

    outputProbe.stats.reset();
    juce::Thread::sleep(static_cast<int>(kSettleSeconds * 1000.0));
    std::cout << "\n== Claim 1: after capture closed ==\n";
    reportWindow("playback after close", outputProbe.stats, outRate, outBuffer, kSettleSeconds);

    const auto restarted = outputProbe.stats.starts.load() != startsBeforeOpen
                           || outputProbe.stats.stops.load() != stopsBeforeOpen;
    std::cout << "  playback device restarts during run = "
              << (restarted ? "YES  <-- ADR 0030 assumption broken" : "none") << "\n"
              << "  playback device still open          = "
              << (manager.getCurrentAudioDevice() != nullptr ? "yes" : "NO") << "\n";

    manager.removeAudioCallback(&outputProbe);
    std::cout << "\nDone.\n";
    return 0;
}
