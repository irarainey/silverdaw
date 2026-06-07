#include "AudioEngine.h"
#include "AudioConstants.h"
#include "AudioDeviceCommands.h"
#include "BpmDetector.h"
#include "BridgeServer.h"
#include "ClipCommands.h"
#include "CommandHelpers.h"
#include "DecodedCache.h"
#include "Log.h"
#include "MixdownEngine.h"
#include "EnginePlaybackPath.h"
#include "LibraryAnalysis.h"
#include "LibraryCommands.h"
#include "PreviewCommands.h"
#include "TransportCommands.h"
#include "MarkerCommands.h"
#include "PayloadHelpers.h"
#include "PeaksCache.h"
#include "ProjectFile.h"
#include "ProjectFxCommands.h"
#include "ProjectState.h"
#include "TransitionCommands.h"
#include "TrackCommands.h"
#include "Waveform.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <iostream>
#include <juce_events/juce_events.h>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <thread>

//==============================================================================
// Silverdaw headless audio backend - entry point.
//
// Lifecycle:
//   1. Initialise JUCE GUI singletons (MessageManager, AudioFormatManager pool).
//   2. Spin up the audio engine (default output device, stereo).
//   3. Start the WebSocket bridge on ws://localhost:8765.
//   4. Run the JUCE message dispatch loop. Audio runs on its own thread,
//      WebSocket I/O runs on ixwebsocket's threads; all engine mutations
//      are marshalled onto the message thread for safety.
//
// NOTE: keep string literals ASCII-only. juce::String(const char*) asserts on
// any byte > 127. For Unicode text, wrap with juce::CharPointer_UTF8.
//==============================================================================

namespace
{
constexpr int kMinBridgePort = 1024;
constexpr int kMaxBridgePort = 65535;
constexpr int kPlayheadUpdateHz = 60;
// 4 workers keeps peak computation responsive without burning every core
// on a giant project import. Each job is disk-bound + a tight scan loop,
// so 4 is plenty even on a 16-core machine.
constexpr int kPeakWorkerCount = 4;

std::atomic<bool> g_shouldQuit{false};
// Mixdown job state. `g_mixdownBusy` is set true while a render is in
// flight and gates `TRANSPORT_PLAY` so transport can't audibly start
// mid-render. `g_mixdownCancel` is the cancel flag the engine polls
// every block.
std::atomic<bool> g_mixdownBusy{false};
std::atomic<bool> g_mixdownCancel{false};

void broadcastEditUndoState(silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge);

double effectivePeaksPerSecond(const silverdaw::waveform::PeaksResult& result)
{
    if (result.sampleRate <= 0.0 || result.peaksPerSecond <= 0) return static_cast<double>(result.peaksPerSecond);
    const int samplesPerPeak = juce::jmax(1, static_cast<int>(result.sampleRate / result.peaksPerSecond));
    return result.sampleRate / static_cast<double>(samplesPerPeak);
}

juce::String sanitiseSampleFileName(juce::String name)
{
    name = name.trim();
    if (name.isEmpty()) name = "Sample";
    if (name.endsWithIgnoreCase(" sample")) name = name.dropLastCharacters(7).trim();
    static constexpr const char* bad = "<>:\"/\\|?*";
    for (int i = 0; bad[i] != '\0'; ++i)
        name = name.replaceCharacter(bad[i], '_');
    return name.trim().isNotEmpty() ? name.trim() : juce::String("Sample");
}

juce::File uniqueWavFile(const juce::File& dir, const juce::String& baseName)
{
    for (int i = 1; i < 10000; ++i)
    {
        const auto suffix = "-sample-" + juce::String(i).paddedLeft('0', 3);
        auto file = dir.getChildFile(baseName + suffix + ".wav");
        if (!file.existsAsFile()) return file;
    }
    return dir.getChildFile(baseName + "-sample-" + juce::Uuid().toString().substring(0, 8) + ".wav");
}

RubberBand::RubberBandStretcher::Options sampleWarpModeOptions(const juce::String& mode)
{
    return silverdaw::parseWarpMode(mode);
}

struct SampleWarpOptions
{
    bool enabled = false;
    juce::String mode = "rhythmic";
    double tempoRatio = 1.0;
    double semitones = 0.0;
    double cents = 0.0;
};

double pitchScaleFor(double semitones, double cents)
{
    return std::pow(2.0, (semitones + cents / 100.0) / 12.0);
}

bool writeSourceWindowToWav(const juce::File& sourceFile, const juce::File& outputFile,
                            double inMs, double durationMs, silverdaw::AudioEngine& engine,
                            double& outDurationMs, double& outSampleRate, int& outChannels,
                            juce::String& error, const std::optional<SampleWarpOptions>& warpOptions = std::nullopt)
{
    std::unique_ptr<juce::AudioFormatReader> reader(engine.getFormatManager().createReaderFor(sourceFile));
    if (reader == nullptr)
    {
        if (auto stream = sourceFile.createInputStream())
            reader.reset(engine.getFormatManager().createReaderFor(std::move(stream)));
    }
    if (reader == nullptr || reader->sampleRate <= 0.0 || reader->lengthInSamples <= 0)
    {
        error = "Could not decode source file";
        return false;
    }

    outSampleRate = reader->sampleRate;
    outChannels = juce::jmax(1, static_cast<int>(reader->numChannels));
    const auto startSample = juce::jlimit(
        static_cast<juce::int64>(0),
        reader->lengthInSamples,
        static_cast<juce::int64>((juce::jmax(0.0, inMs) * reader->sampleRate) / 1000.0));
    const auto available = reader->lengthInSamples - startSample;
    const auto requested =
        durationMs > 0.0
            ? static_cast<juce::int64>((durationMs * reader->sampleRate) / 1000.0)
            : available;
    const auto samplesToWrite = juce::jlimit(static_cast<juce::int64>(0), available, requested);
    if (samplesToWrite <= 0)
    {
        error = "Clip has no audio to export";
        return false;
    }

    if (auto parent = outputFile.getParentDirectory(); !parent.exists() && parent.createDirectory().failed())
    {
        error = "Could not create sample folder";
        return false;
    }
    outputFile.deleteFile();
    juce::WavAudioFormat wav;
    std::unique_ptr<juce::FileOutputStream> stream(outputFile.createOutputStream());
    if (stream == nullptr)
    {
        error = "Could not create sample file";
        return false;
    }
    std::unique_ptr<juce::AudioFormatWriter> writer(
        wav.createWriterFor(stream.release(), reader->sampleRate,
                            static_cast<unsigned int>(outChannels), 24, {}, 0));
    if (writer == nullptr)
    {
        error = "Could not create WAV writer";
        return false;
    }

    constexpr int kBlock = 8192;
    juce::AudioBuffer<float> buffer(outChannels, kBlock);
    std::vector<float*> outputPtrs(static_cast<std::size_t>(outChannels));
    const bool renderWarped =
        warpOptions.has_value() &&
        warpOptions->enabled &&
        (std::abs(warpOptions->tempoRatio - 1.0) > 1e-4 ||
         std::abs(pitchScaleFor(warpOptions->semitones, warpOptions->cents) - 1.0) > 1e-4);

    if (renderWarped)
    {
        silverdaw::WarpProcessor warp(outChannels, reader->sampleRate, sampleWarpModeOptions(warpOptions->mode));
        warp.prepareToPlay(kBlock);
        warp.setTempoRatio(warpOptions->tempoRatio);
        warp.setPitchScale(pitchScaleFor(warpOptions->semitones, warpOptions->cents));
        warp.seekSource(startSample);

        const auto outSamples = silverdaw::WarpProcessor::timelineSamplesForSourceSamples(
            samplesToWrite, warpOptions->tempoRatio);
        juce::int64 written = 0;
        const auto sourceEnd = startSample + samplesToWrite;
        while (written < outSamples)
        {
            const int n = static_cast<int>(juce::jmin(static_cast<juce::int64>(kBlock), outSamples - written));
            buffer.clear();
            for (int c = 0; c < outChannels; ++c) outputPtrs[static_cast<std::size_t>(c)] = buffer.getWritePointer(c);
            warp.process(outputPtrs.data(), n,
                         [&](float* const* dest, juce::int64 srcPos, int sourceN)
                         {
                             juce::AudioBuffer<float> srcView(const_cast<float**>(dest), outChannels, sourceN);
                             srcView.clear();
                             const auto readStart = juce::jmax(srcPos, startSample);
                             const auto readEnd = juce::jmin(srcPos + sourceN, sourceEnd);
                             if (readEnd <= readStart) return;
                             const int destOffset = static_cast<int>(readStart - srcPos);
                             const int count = static_cast<int>(readEnd - readStart);
                             reader->read(&srcView, destOffset, count, readStart, true, true);
                         });
            if (!writer->writeFromAudioSampleBuffer(buffer, 0, n))
            {
                error = "Could not write warped sample audio";
                return false;
            }
            written += n;
        }
        outDurationMs = static_cast<double>(outSamples) * 1000.0 / reader->sampleRate;
        return true;
    }

    juce::int64 written = 0;
    while (written < samplesToWrite)
    {
        const int n = static_cast<int>(juce::jmin(static_cast<juce::int64>(kBlock), samplesToWrite - written));
        buffer.clear();
        reader->read(&buffer, 0, n, startSample + written, true, true);
        if (!writer->writeFromAudioSampleBuffer(buffer, 0, n))
        {
            error = "Could not write sample audio";
            return false;
        }
        written += n;
    }
    outDurationMs = static_cast<double>(samplesToWrite) * 1000.0 / reader->sampleRate;
    return true;
}

void onSignal(int /*sig*/)
{
    g_shouldQuit.store(true);
    juce::MessageManager::getInstance()->stopDispatchLoop();
}

/**
 * Parse an integer port from a string. Returns the parsed value on
 * success, or `-1` on any failure (empty / non-numeric / trailing
 * garbage / out of `[kMinBridgePort, kMaxBridgePort]`). A warning is
 * logged so silent fallbacks remain debuggable.
 */
int parsePort(std::string_view value, std::string_view source)
{
    if (value.empty())
    {
        silverdaw::log::warn("main",
                             juce::String("empty port value from ") + juce::String(std::string(source)));
        return -1;
    }

    int port = 0;
    try
    {
        std::size_t consumed = 0;
        port = std::stoi(std::string(value), &consumed);
        if (consumed != value.size())
        {
            throw std::invalid_argument("trailing characters");
        }
    }
    catch (const std::exception& e)
    {
        silverdaw::log::warn("main",
                             juce::String("invalid port from ") + juce::String(std::string(source)) + " (" +
                                 juce::String(std::string(value)) + "): " + juce::String(e.what()));
        return -1;
    }

    if (port < kMinBridgePort || port > kMaxBridgePort)
    {
        silverdaw::log::warn("main",
                             juce::String("port ") + juce::String(port) + " from " +
                                 juce::String(std::string(source)) + " outside [" +
                                 juce::String(kMinBridgePort) + ", " + juce::String(kMaxBridgePort) + "]");
        return -1;
    }

    return port;
}

/**
 * Resolve the bridge listen port from `--port <N>` / `--port=N`. The
 * Electron main process is the single source of truth for the port —
 * it picks an unused loopback port (so multiple Silverdaw instances
 * can coexist) and passes it to every spawned backend via `--port`.
 *
 * Returns `-1` when `--port` is missing or invalid; `runBackend` then
 * refuses to start. There is no compiled-in default and no env-var
 * fallback: a missing `--port` is always a configuration bug.
 */
// `argv` is necessarily a C-style array — that's the only legal signature for
// `main` and forwarded helpers. clang-tidy's modernize check doesn't model that.
// NOLINTNEXTLINE(modernize-avoid-c-arrays,hicpp-avoid-c-arrays,cppcoreguidelines-avoid-c-arrays)
int resolveBridgePort(int argc, char* argv[])
{
    for (int i = 1; i < argc; ++i)
    {
        const std::string_view arg{argv[i]};
        if (arg == "--port" && i + 1 < argc)
        {
            return parsePort(argv[i + 1], "--port");
        }
        constexpr std::string_view prefix = "--port=";
        if (arg.size() > prefix.size() && arg.substr(0, prefix.size()) == prefix)
        {
            return parsePort(arg.substr(prefix.size()), "--port=");
        }
    }

    silverdaw::log::error("main",
                          juce::String("missing required --port <N> argument (range [") +
                              juce::String(kMinBridgePort) + ", " + juce::String(kMaxBridgePort) +
                              "]); refusing to start");
    return -1;
}

/**
 * Resolve the per-session AUTH token the bridge will require from every
 * connecting client. Precedence (highest first):
 *   1. `--token <hex>` or `--token=<hex>` command-line argument
 *   2. `SILVERDAW_BRIDGE_TOKEN` environment variable
 *   3. empty string → authentication disabled (stand-alone manual debug only;
 *      `BridgeServer` logs a loud warning when this happens at startup).
 *
 * Electron main generates a fresh random token per session and forwards it
 * via the env var. The CLI form is provided for hand-testing the backend
 * out of process — never use it in production: command-line arguments are
 * visible to other processes via the OS process table.
 */
// `argv` is necessarily a C-style array — see note on `resolveBridgePort`.
// NOLINTNEXTLINE(modernize-avoid-c-arrays,hicpp-avoid-c-arrays,cppcoreguidelines-avoid-c-arrays)
juce::String resolveBridgeToken(int argc, char* argv[])
{
    for (int i = 1; i < argc; ++i)
    {
        const std::string_view arg{argv[i]};
        if (arg == "--token" && i + 1 < argc)
        {
            return juce::String{argv[i + 1]};
        }
        constexpr std::string_view prefix = "--token=";
        if (arg.size() > prefix.size() && arg.substr(0, prefix.size()) == prefix)
        {
            return juce::String{std::string(arg.substr(prefix.size()))};
        }
    }

    return juce::SystemStats::getEnvironmentVariable("SILVERDAW_BRIDGE_TOKEN", {});
}

/** Polls the audio engine and broadcasts PLAYHEAD_UPDATE while playing. */
class PlayheadEmitter : public juce::Timer
{
  public:
    PlayheadEmitter(silverdaw::AudioEngine& e, silverdaw::BridgeServer& b)
        : engine(e), bridge(b), payloadObject(new juce::DynamicObject()), payload(payloadObject.get())
    {
    }

    void timerCallback() override
    {
        const bool playing = engine.isPlaying();
        const double rawPosMs = engine.getPositionMs();

        // While the transport is playing, subtract the device's
        // effective output latency from the broadcast position so the
        // visual playhead matches what the user is hearing — critical
        // for high-latency outputs like Bluetooth headphones, where
        // the uncompensated value drifts ~200 ms ahead of the audio.
        //
        // Paused / seek-anchor reads stay raw (see
        // `AudioEngine::getPositionMs` for the rationale): click-to-
        // seek lands exactly where the user clicked, and Save's
        // persisted playhead matches the engine's write position.
        // The play/pause transition does cause a one-off visual snap
        // (~latency ms), absorbed by the renderer's existing position
        // smoothing.
        const double latencyMs = playing ? engine.getOutputLatencyMs() : 0.0;
        const double posMs = playing ? juce::jmax(0.0, rawPosMs - latencyMs) : rawPosMs;

        // Always broadcast on transitions; while playing, broadcast every tick so the
        // renderer can drive a smooth playhead. Reuse a single DynamicObject so we
        // don't churn the heap 60x/s on the message thread.
        if (playing || posMs != lastPosMs)
        {
            payloadObject->setProperty("positionMs", posMs);
            payloadObject->setProperty("isPlaying", playing);
            bridge.broadcast("PLAYHEAD_UPDATE", payload);
            lastPosMs = posMs;
        }

        // Preview voice — independent of the project transport. Broadcast
        // position while playing, and detect end-of-window here (the
        // OffsetSource emits silence past durationMs but the transport
        // keeps "playing"; we explicitly stop and notify).
        const bool previewPlaying = engine.isPreviewPlaying();
        const double previewPos = engine.getPreviewPositionMs();
        const double previewDur = engine.getPreviewDurationMs();
        if (previewPlaying && previewDur > 0.0 && previewPos >= previewDur)
        {
            engine.stopPreview();
            auto* endedObj = new juce::DynamicObject();
            endedObj->setProperty("generation", static_cast<juce::int64>(engine.getPreviewGeneration()));
            bridge.broadcast("PREVIEW_ENDED", juce::var(endedObj));
            auto* stateObj = new juce::DynamicObject();
            stateObj->setProperty("isPlaying", false);
            stateObj->setProperty("isLoaded", engine.isPreviewLoaded());
            stateObj->setProperty("durationMs", previewDur);
            stateObj->setProperty("generation", static_cast<juce::int64>(engine.getPreviewGeneration()));
            bridge.broadcast("PREVIEW_STATE", juce::var(stateObj));
            lastPreviewPosMs = 0.0;
        }
        else if (previewPlaying || previewPos != lastPreviewPosMs)
        {
            previewPayloadObject->setProperty("positionMs", previewPos);
            previewPayloadObject->setProperty("isPlaying", previewPlaying);
            previewPayloadObject->setProperty(
                "generation", static_cast<juce::int64>(engine.getPreviewGeneration()));
            bridge.broadcast("PREVIEW_POSITION", previewPayload);
            lastPreviewPosMs = previewPos;
        }

        // Master peak meter. Drain the audio thread's "max since last
        // read" lanes and broadcast a MASTER_LEVEL envelope. We gate
        // on activity (signal above ~ -100 dBFS, plus one trailing
        // zero so the renderer's hold/decay can finish gracefully)
        // to avoid spamming envelopes during long silent stretches.
        float peakL = 0.0F;
        float peakR = 0.0F;
        engine.consumeMasterPeaks(peakL, peakR);
        constexpr float kMeterEpsilon = 1.0e-5F;
        const bool hasSignal = peakL > kMeterEpsilon || peakR > kMeterEpsilon;
        if (hasSignal || lastMasterLevelHadSignal)
        {
            masterLevelObject->setProperty("peakL", static_cast<double>(peakL));
            masterLevelObject->setProperty("peakR", static_cast<double>(peakR));
            bridge.broadcast("MASTER_LEVEL", masterLevelPayload);
            lastMasterLevelHadSignal = hasSignal;
        }

        // Diagnostic: record the final post-master-gain output peak — the
        // signal actually handed to the device. Fires both while PLAYING (was
        // the first play silent at the engine, or did real audio reach the
        // device?). A peak at the keep-alive floor (~0.004) is dither only; a
        // music-level peak (≳ 0.1) is real audio; a flat 0 while playing means
        // the output never reached the device. We accumulate the running max
        // across every drained tick so a throttled sample can't miss a
        // transient, then emit it on the message thread (free of any
        // audio-thread cost) and reset. Only accumulate while playing so the
        // brief wake-pre-roll floor can't contaminate the first post-resume
        // sample.
        if (playing)
        {
            masterPeakLogMaxL = juce::jmax(masterPeakLogMaxL, peakL);
            masterPeakLogMaxR = juce::jmax(masterPeakLogMaxR, peakR);
        }
        else
        {
            masterPeakLogMaxL = 0.0F;
            masterPeakLogMaxR = 0.0F;
        }
        const double nowMs = juce::Time::getMillisecondCounterHiRes();
        // Only log during active playback — idle/paused output is now true
        // silence, so logging it would just spam zeros every interval.
        if (playing && (nowMs - lastMasterPeakLogMs) >= kMasterPeakLogIntervalMs)
        {
            silverdaw::log::debug("perf.master",
                                  "playing=" + juce::String(playing ? 1 : 0) +
                                      " peakL=" + juce::String(masterPeakLogMaxL, 5) +
                                      " peakR=" + juce::String(masterPeakLogMaxR, 5) +
                                      " posMs=" + juce::String(rawPosMs, 1));
            lastMasterPeakLogMs = nowMs;
            masterPeakLogMaxL = 0.0F;
            masterPeakLogMaxR = 0.0F;
        }

        // Per-track peak meters. Same gating rules as the master
        // meter (only broadcast on activity; emit one trailing zero
        // on the active→silent transition so the renderer's
        // hold/decay finishes cleanly). The payload carries a flat
        // array — small at typical project sizes (≤ few dozen
        // tracks) and the renderer fans out by `id` to the
        // matching track-meter component.
        engine.drainAllTrackPeaks(trackPeakScratch);
        bool anyTrackHasSignal = false;
        for (const auto& snap : trackPeakScratch)
        {
            if (snap.peakL > kMeterEpsilon || snap.peakR > kMeterEpsilon)
            {
                anyTrackHasSignal = true;
                break;
            }
        }
        if (anyTrackHasSignal || lastTrackLevelsHadSignal)
        {
            juce::Array<juce::var> tracksVar;
            tracksVar.ensureStorageAllocated(static_cast<int>(trackPeakScratch.size()));
            for (const auto& snap : trackPeakScratch)
            {
                auto* trackObj = new juce::DynamicObject();
                trackObj->setProperty("id", snap.trackId);
                trackObj->setProperty("peakL", static_cast<double>(snap.peakL));
                trackObj->setProperty("peakR", static_cast<double>(snap.peakR));
                tracksVar.add(juce::var(trackObj));
            }
            trackLevelsObject->setProperty("tracks", tracksVar);
            bridge.broadcast("TRACK_LEVELS", trackLevelsPayload);
            lastTrackLevelsHadSignal = anyTrackHasSignal;
        }
    }

  private:
    silverdaw::AudioEngine& engine;
    silverdaw::BridgeServer& bridge;
    // Reference-counted: held alive by `payloadObject`; `payload` is the
    // pre-wrapped juce::var we hand to broadcast() each tick.
    juce::DynamicObject::Ptr payloadObject;
    juce::var payload;
    double lastPosMs = -1.0;
    juce::DynamicObject::Ptr previewPayloadObject{new juce::DynamicObject()};
    juce::var previewPayload{previewPayloadObject.get()};
    double lastPreviewPosMs = -1.0;
    juce::DynamicObject::Ptr masterLevelObject{new juce::DynamicObject()};
    juce::var masterLevelPayload{masterLevelObject.get()};
    bool lastMasterLevelHadSignal = false;
    // Wall-clock throttle for the perf.master output-peak diagnostic.
    static constexpr double kMasterPeakLogIntervalMs = 250.0;
    double lastMasterPeakLogMs = 0.0;
    float masterPeakLogMaxL = 0.0F;
    float masterPeakLogMaxR = 0.0F;
    juce::DynamicObject::Ptr trackLevelsObject{new juce::DynamicObject()};
    juce::var trackLevelsPayload{trackLevelsObject.get()};
    bool lastTrackLevelsHadSignal = false;
    // Reused across ticks so steady-state metering broadcasts allocate
    // only the per-track DynamicObject envelope payloads (not this
    // scratch vector itself).
    std::vector<silverdaw::BusGraph::TrackPeakSnapshot> trackPeakScratch;
};

// Bridge payload validation helpers live in `PayloadHelpers.h` so the
// backend test binary can link them in. Hoist them into the
// anonymous namespace here so existing dispatch call sites
// (`tryGetNumber(payload, "X")` etc.) keep working unchanged.
using silverdaw::bridge::tryGetNumber;
using silverdaw::bridge::tryGetRequiredString;
using silverdaw::bridge::tryGetString;
using silverdaw::bridge::readOptionalNumber;
using silverdaw::bridge::readOptionalBool;
using silverdaw::bridge::readOptionalString;
using silverdaw::broadcastApplied;

/**
 * Compute or load peaks for `filePath` and notify clients that a fresh
 * cache file is on disk via a tiny `WAVEFORM_READY` text envelope. The
 * renderer reads the on-disk bytes via main's IPC — bulk data never
 * crosses the WebSocket. This is the architectural counterpart to how
 * the design plan already treats audio files / stems / mixdowns:
 * "Disk only: the backend sends file paths; the frontend never receives
 * raw audio data over the socket."
 *
 * Designed to be called from a `juce::ThreadPool` job — disk I/O only,
 * never touches the message thread, and `BridgeServer::broadcast` is
 * mutex-guarded internally.
 *
 * Cache lookup first; on miss, compute + persist. An empty result
 * (decode failure) is NOT broadcast — silent failure means the renderer
 * keeps drawing the empty placeholder until the user retries or the
 * file becomes readable.
 */
void produceAndBroadcastPeaks(const juce::String& clipId, const juce::File& filePath,
                              silverdaw::AudioEngine& engine, const silverdaw::PeaksCache& cache,
                              silverdaw::BridgeServer& bridge)
{
    constexpr int kPeaksPerSecond = silverdaw::waveform::kDefaultPeaksPerSecond;
    silverdaw::log::info("peaksjob", "start clipId=" + clipId + " file=" + filePath.getFileName());
    auto result = cache.tryLoad(filePath, kPeaksPerSecond);
    const bool fromCache = !result.peaks.empty();
    if (!fromCache)
    {
        result = silverdaw::waveform::computePeaks(filePath, engine.getFormatManager(), kPeaksPerSecond);
        if (!result.peaks.empty())
        {
            cache.store(filePath, result);
        }
    }
    if (result.peaks.empty())
    {
        silverdaw::log::warn("peaksjob", "no peaks produced for clipId=" + clipId);
        return;
    }

    // Build a small JSON envelope. `peakCount` is the number of (min,max)
    // pairs PER LANE — the renderer reads `peakCount * laneCount * 2 *
    // sizeof(float)` bytes from the file after the 28-byte header. Same
    // layout the cache itself uses (see `PeaksCache.cpp`).
    const auto cacheFile = cache.getCacheFilePath(filePath, kPeaksPerSecond);
    auto* obj = new juce::DynamicObject();
    obj->setProperty("clipId", clipId);
    obj->setProperty("cachePath", cacheFile.getFullPathName());
    obj->setProperty("peakCount", result.bucketsPerLane());
    obj->setProperty("laneCount", result.laneCount);
    obj->setProperty("peaksPerSecond", effectivePeaksPerSecond(result));
    obj->setProperty("sampleRate", result.sampleRate);
    bridge.broadcast("WAVEFORM_READY", juce::var(obj));

    silverdaw::log::info("peaksjob", "done clipId=" + clipId + " peaks=" +
                                          juce::String(result.bucketsPerLane()) +
                                          (fromCache ? " (cache hit)" : " (computed)"));
}

void handleClipAdd(const juce::var& payload, silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                   silverdaw::BridgeServer& bridge, juce::ThreadPool& peakPool, const silverdaw::PeaksCache& cache,
                   const silverdaw::DecodedCache& decodedCache)
{
    const juce::String trackId = tryGetRequiredString(payload, "trackId").value_or(juce::String{});
    const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
    const juce::String libraryItemId = tryGetRequiredString(payload, "libraryItemId").value_or(juce::String{});
    if (trackId.isEmpty() || clipId.isEmpty() || libraryItemId.isEmpty())
    {
        silverdaw::log::warn("bridge", "CLIP_ADD missing trackId / clipId / libraryItemId");
        return;
    }

    // Resolve the source file through the linked library item. A clip
    // is now a pure window into a library item; the library is the
    // single source of truth for the underlying file path.
    const juce::String filePath = projectState.getLibraryItemFilePath(libraryItemId);
    if (filePath.isEmpty())
    {
        silverdaw::log::warn("bridge", "CLIP_ADD libraryItemId=" + libraryItemId + " has no filePath in library");
        auto* err = new juce::DynamicObject();
        err->setProperty("trackId", trackId);
        err->setProperty("clipId", clipId);
        err->setProperty("libraryItemId", libraryItemId);
        err->setProperty("ok", false);
        err->setProperty("error", juce::String("Unknown library item"));
        bridge.broadcast("CLIP_ADD_FAILED", juce::var(err));
        return;
    }

    // Pull the initial offset out of the payload up front so addClip can
    // apply it atomically with the load — otherwise a separate
    // setClipOffsetMs call would race against the audio thread, briefly
    // playing the clip at offset 0.
    const juce::var posVar = payload.getProperty("positionMs", juce::var());
    const double initialOffsetMs =
        (posVar.isDouble() || posVar.isInt() || posVar.isInt64()) ? juce::jmax(0.0, static_cast<double>(posVar)) : 0.0;

    // Optional trim window: split / duplicate send these so the new
    // clip plays a subset of the source file. Absent (== 0) means
    // "play the whole file from the start" — the un-trimmed default.
    const juce::var inVar = payload.getProperty("inMs", juce::var());
    const double inMs =
        (inVar.isDouble() || inVar.isInt() || inVar.isInt64()) ? juce::jmax(0.0, static_cast<double>(inVar)) : 0.0;
    const juce::var durVar = payload.getProperty("durationMs", juce::var());
    const double payloadDurationMs =
        (durVar.isDouble() || durVar.isInt() || durVar.isInt64()) ? juce::jmax(0.0, static_cast<double>(durVar)) : 0.0;

    // Optional per-clip colour override. Negative / absent means "inherit
    // from track" — the renderer-side default. Clamped on the renderer
    // side; we trust the value here because the bridge wire format is
    // type-checked.
    const juce::var colorVar = payload.getProperty("colorIndex", juce::var());
    const int payloadColorIndex =
        (colorVar.isInt() || colorVar.isInt64()) ? static_cast<int>(colorVar) : -1;

    // Auto-create the parent track in the ValueTree if the renderer didn't
    // (e.g. older clients that never send TRACK_ADD). Idempotent.
    projectState.addTrack(trackId);

    // Always read from the decoded-WAV cache: compressed sources
    // (MP3, M4A, …) are too slow to seek for the read-ahead buffer to
    // hide latency at clip boundaries. `resolveEnginePlaybackPath`
    // prefers the cache file when it exists and keeps the persisted
    // `playbackFilePath` in sync so subsequent loads pick it up.
    const juce::String engineFilePath =
        silverdaw::resolveEnginePlaybackPath(filePath, projectState, decodedCache);
    // Kick off a background decode if the cache is missing. The first
    // play of a freshly-imported file still uses the original (the only
    // option until decoding completes), but every subsequent CLIP_ADD
    // of the same source picks up the cache.
    if (engineFilePath == filePath)
    {
        silverdaw::ensureDecodedCache(filePath, engine, projectState, peakPool, decodedCache);
    }

    juce::String errorMsg;
    // Pass the effective gain (post-mute/solo) to `addClip` directly
    // so a brand-new clip starts at the audible level the rest of
    // the timeline is playing at — no brief blip at the user volume
    // before the explicit `setClipGain` below clamps it down.
    const auto effectiveGain = projectState.getEffectiveTrackGain(trackId);
    bool ok = engine.addClip(trackId, clipId, juce::File(engineFilePath), initialOffsetMs, inMs, payloadDurationMs,
                             effectiveGain, &errorMsg);
    if (ok)
    {
        // For un-trimmed clips fall back to the engine-discovered source
        // duration so PROJECT_STATE on reconnect can rebuild the clip
        // block geometry without re-reading the file from the renderer.
        // For trimmed clips (durationMs > 0) trust the renderer.
        const double effectiveDurationMs =
            payloadDurationMs > 0.0 ? payloadDurationMs : engine.getClipDurationMs(clipId);
        if (!projectState.addClip(trackId, clipId, libraryItemId, initialOffsetMs, effectiveDurationMs, inMs,
                                   payloadColorIndex))
        {
            engine.removeClip(clipId);
            ok = false;
            errorMsg = "duplicate clipId or unknown trackId";
        }
        else
        {
            engine.setClipGain(clipId, effectiveGain);
        }
    }

    auto* p = new juce::DynamicObject();
    p->setProperty("trackId", trackId);
    p->setProperty("clipId", clipId);
    p->setProperty("libraryItemId", libraryItemId);
    p->setProperty("ok", ok);
    if (!ok)
    {
        p->setProperty("error", errorMsg);
    }
    bridge.broadcast(ok ? "CLIP_ADDED" : "CLIP_ADD_FAILED", juce::var(p));

    if (ok)
    {
        // Kick off peaks generation on the worker pool. The job is fire-and-
        // forget from the message thread's perspective; clients receive the
        // waveform as a separate binary frame whenever the worker finishes
        // (or instantly if the disk cache already has an entry for this file).
        peakPool.addJob(
            [clipId, file = juce::File(filePath), &engine, &cache, &bridge]
            { produceAndBroadcastPeaks(clipId, file, engine, cache, bridge); });
        // Also schedule BPM detection for the source file if the
        // matching library item has no BPM yet. Belt-and-braces: covers
        // the case where the renderer deduplicates a LIBRARY_ADD (so
        // detection wouldn't otherwise have a chance to start) and the
        // case where a clip arrives without a preceding LIBRARY_ADD.
        // The same worker job also writes the decoded-WAV cache for
        // future clip adds.
        silverdaw::ensureBpmDetection(filePath, engine, projectState, bridge, peakPool, decodedCache);
        // If the matching library item already has a known BPM (e.g.
        // the user imported the file to the library earlier and is
        // only now placing it on a track), re-evaluate the seed
        // gates now that the project has a clip.
        silverdaw::maybeSeedProjectBpmFor(libraryItemId, projectState, bridge);
    }
}

void handleWaveformRequest(const juce::var& payload, silverdaw::AudioEngine& engine,
                           silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                           juce::ThreadPool& peakPool, const silverdaw::PeaksCache& cache)
{
    const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
    if (clipId.isEmpty())
    {
        return;
    }
    // Find the file the backend has on record for this clip. The renderer
    // never sends the path on a WAVEFORM_REQUEST — the backend is the
    // authority over what file each clipId resolves to.
    const auto trackId = projectState.getClipTrackId(clipId);
    if (trackId.isEmpty())
    {
        silverdaw::log::warn("bridge", "WAVEFORM_REQUEST for unknown clipId " + clipId);
        return;
    }
    const auto filePath = projectState.getClipFilePath(clipId);
    if (filePath.isEmpty())
    {
        return;
    }

    peakPool.addJob(
        [clipId, file = juce::File(filePath), &engine, &cache, &bridge]
        { produceAndBroadcastPeaks(clipId, file, engine, cache, bridge); });
}

// Variant of `produceAndBroadcastPeaks` that targets a library item id
// at a caller-specified resolution. Used by the Clip Editor's
// `CLIP_EDITOR_PEAKS_REQUEST` flow: when the user zooms past the
// detail level that the default-resolution peaks can resolve, the
// renderer asks for a high-res rebuild (typically 2000+ peaks/sec) of
// the source file. PeaksCache keys on `(filePath, peaksPerSecond)`,
// so the high-res result lives alongside the default-res one and
// every saved-clip sharing the source reuses it.
void produceAndBroadcastEditorPeaks(const juce::String& libraryItemId, const juce::File& filePath,
                                    int peaksPerSecond, silverdaw::AudioEngine& engine,
                                    const silverdaw::PeaksCache& cache, silverdaw::BridgeServer& bridge)
{
    silverdaw::log::info("peaksjob", "editor start libId=" + libraryItemId +
                                          " file=" + filePath.getFileName() +
                                          " ppS=" + juce::String(peaksPerSecond));
    auto result = cache.tryLoad(filePath, peaksPerSecond);
    const bool fromCache = !result.peaks.empty();
    if (!fromCache)
    {
        result = silverdaw::waveform::computePeaks(filePath, engine.getFormatManager(), peaksPerSecond);
        if (!result.peaks.empty())
        {
            cache.store(filePath, result);
        }
    }
    if (result.peaks.empty())
    {
        silverdaw::log::warn("peaksjob", "editor no peaks libId=" + libraryItemId);
        return;
    }
    const auto cacheFile = cache.getCacheFilePath(filePath, peaksPerSecond);
    auto* obj = new juce::DynamicObject();
    obj->setProperty("libraryItemId", libraryItemId);
    obj->setProperty("cachePath", cacheFile.getFullPathName());
    obj->setProperty("peakCount", result.bucketsPerLane());
    obj->setProperty("laneCount", result.laneCount);
    obj->setProperty("peaksPerSecond", effectivePeaksPerSecond(result));
    obj->setProperty("sampleRate", result.sampleRate);
    bridge.broadcast("CLIP_EDITOR_PEAKS_READY", juce::var(obj));
    silverdaw::log::info("peaksjob", "editor done libId=" + libraryItemId + " peaks=" +
                                          juce::String(result.bucketsPerLane()) +
                                          (fromCache ? " (cache hit)" : " (computed)"));
}

void saveWindowAsSampleAsync(const juce::String& clipId, const juce::String& libraryItemId,
                             const juce::String& newItemId, const juce::String& sampleName,
                             const juce::String& outputDir, const juce::File& sourceFile,
                             double inMs, double durationMs, silverdaw::AudioEngine& engine,
                             silverdaw::ProjectState& projectState, juce::ThreadPool& peakPool,
                             const silverdaw::PeaksCache& cache, silverdaw::BridgeServer& bridge,
                             std::optional<SampleWarpOptions> warpOptions = std::nullopt)
{
    peakPool.addJob(
        [clipId, libraryItemId, newItemId, sampleName, outputDir, sourceFile, inMs, durationMs,
         warpOptions, &engine, &projectState, &cache, &bridge]
        {
            const auto safeName = sanitiseSampleFileName(sampleName);
            const auto outDir = juce::File(outputDir);
            const auto outFile = uniqueWavFile(outDir, safeName);
            double actualDurationMs = 0.0;
            double sampleRate = 0.0;
            int channels = 0;
            juce::String error;
            const bool ok = writeSourceWindowToWav(sourceFile, outFile, inMs, durationMs, engine,
                                                   actualDurationMs, sampleRate, channels, error, warpOptions);
            silverdaw::waveform::PeaksResult peaks;
            juce::File peaksFile;
            if (ok)
            {
                peaks = silverdaw::waveform::computePeaks(outFile, engine.getFormatManager(),
                                                          silverdaw::waveform::kDefaultPeaksPerSecond);
                if (!peaks.peaks.empty())
                {
                    cache.store(outFile, peaks);
                    peaksFile = cache.getCacheFilePath(outFile, silverdaw::waveform::kDefaultPeaksPerSecond);
                }
            }

            juce::MessageManager::callAsync(
                [clipId, libraryItemId, newItemId, safeName, outFile, actualDurationMs, sampleRate, channels,
                 ok, error, peaks, peaksFile, &projectState, &bridge]
                {
                    auto* obj = new juce::DynamicObject();
                    if (clipId.isNotEmpty()) obj->setProperty("clipId", clipId);
                    if (libraryItemId.isNotEmpty()) obj->setProperty("libraryItemId", libraryItemId);
                    obj->setProperty("itemId", newItemId);
                    obj->setProperty("ok", ok && !peaks.peaks.empty());
                    if (!ok || peaks.peaks.empty())
                    {
                        obj->setProperty("error", error.isNotEmpty() ? error : juce::String("Could not create peaks for sample"));
                        bridge.broadcast("SAMPLE_SAVED", juce::var(obj));
                        return;
                    }

                    projectState.getUndoManager().beginNewTransaction("Save sample");
                    projectState.addLibraryItem(newItemId, outFile.getFullPathName(), outFile.getFileName(),
                                                actualDurationMs, static_cast<int>(sampleRate), channels,
                                                outFile.getFullPathName(), {}, "audio-file", safeName);
                    obj->setProperty("filePath", outFile.getFullPathName());
                    obj->setProperty("fileName", outFile.getFileName());
                    obj->setProperty("name", safeName);
                    obj->setProperty("durationMs", actualDurationMs);
                    obj->setProperty("sampleRate", sampleRate);
                    obj->setProperty("channelCount", channels);
                    obj->setProperty("cachePath", peaksFile.getFullPathName());
                    obj->setProperty("peakCount", peaks.bucketsPerLane());
                    obj->setProperty("laneCount", peaks.laneCount);
                    obj->setProperty("peaksPerSecond", effectivePeaksPerSecond(peaks));
                    bridge.broadcast("SAMPLE_SAVED", juce::var(obj));
                    broadcastEditUndoState(projectState, bridge);
                });
        });
}

void handleClipEditorPeaksRequest(const juce::var& payload, silverdaw::AudioEngine& engine,
                                   silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                                   juce::ThreadPool& peakPool, const silverdaw::PeaksCache& cache)
{
    const juce::String libraryItemId = tryGetRequiredString(payload, "libraryItemId").value_or(juce::String{});
    const int peaksPerSecond =
        juce::jmax(silverdaw::waveform::kDefaultPeaksPerSecond,
                   juce::jmin(20000, static_cast<int>(payload.getProperty("peaksPerSecond", 0))));
    if (libraryItemId.isEmpty()) return;
    const auto filePath = projectState.getLibraryItemFilePath(libraryItemId);
    if (filePath.isEmpty()) return;
    peakPool.addJob(
        [libraryItemId, file = juce::File(filePath), peaksPerSecond, &engine, &cache, &bridge]
        { produceAndBroadcastEditorPeaks(libraryItemId, file, peaksPerSecond, engine, cache, bridge); });
}

// ─── Project-level state (save / load / new / rename) ────────────────────

/**
 * Per-process project-lifecycle state. Owned by `runBackend`, captured by
 * reference into every project-mutating handler. `currentPath` is empty
 * for a project that has never been saved (the renderer shows the name
 * "Untitled" alongside).
 */
struct ProjectSession
{
    juce::String currentPath;
};

/** Walk every clip in `projectState` and gather their ids in tree order. */
juce::StringArray collectClipIds(const silverdaw::ProjectState& projectState)
{
    juce::StringArray ids;
    const auto& root = projectState.getTree();
    for (int t = 0; t < root.getNumChildren(); ++t)
    {
        const auto track = root.getChild(t);
        for (int c = 0; c < track.getNumChildren(); ++c)
        {
            const auto clip = track.getChild(c);
            if (clip.hasType(juce::Identifier{"CLIP"}))
            {
                ids.add(clip.getProperty("id").toString());
            }
        }
    }
    return ids;
}

/**
 * Build the PROJECT_STATE envelope payload. `reset` is added (as `true`)
 * when the snapshot is a hard replacement (PROJECT_NEW / PROJECT_LOAD)
 * so the renderer wipes optimistic local state first; on the connect
 * path the snapshot is purely additive and `reset` is omitted.
 */
juce::var buildProjectStateEnvelope(const ProjectSession& session, const silverdaw::ProjectState& projectState,
                                    bool reset)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("filePath", session.currentPath.isEmpty() ? juce::var() : juce::var(session.currentPath));
    obj->setProperty("name", projectState.getName());
    if (reset)
    {
        obj->setProperty("reset", true);
    }
    obj->setProperty("tracks", projectState.tracksAsJson());
    obj->setProperty("library", projectState.libraryAsJson());
    obj->setProperty("markers", projectState.markersAsJson());
    obj->setProperty("viewPxPerSecond", projectState.getViewPxPerSecond());
    obj->setProperty("viewScrollX", projectState.getViewScrollX());
    obj->setProperty("viewSelectedTrack", projectState.getViewSelectedTrack());
    obj->setProperty("viewFxPanelOpen", projectState.getViewFxPanelOpen());
    obj->setProperty("playheadMs", projectState.getPlayheadMs());
    obj->setProperty("bpm", projectState.getBpm());
    obj->setProperty("projectLengthMs", projectState.getProjectLengthMs());
    // Per-project preferred audio output. Emit as null when no
    // preference is set so the renderer can distinguish "absent" from
    // "explicitly cleared".
    {
        const auto outType = projectState.getAudioOutputTypeName();
        const auto outDevice = projectState.getAudioOutputDeviceName();
        obj->setProperty("audioOutputTypeName", outType.isEmpty() ? juce::var() : juce::var(outType));
        obj->setProperty("audioOutputDeviceName", outDevice.isEmpty() ? juce::var() : juce::var(outDevice));
    }
    // Per-project target sample rate (Hz). Emit only when set so the
    // renderer can distinguish "absent → use user-scope default"
    // from "explicit project value".
    {
        const auto rate = projectState.getTargetSampleRate();
        if (rate > 0) obj->setProperty("targetSampleRate", rate);
    }
    // Persisted export-dialog settings (opaque JSON, renderer-owned schema).
    // Absent until the user runs an export at least once on this project.
    {
        const auto exportSettings = projectState.getExportSettingsJson();
        if (exportSettings.isNotEmpty()) obj->setProperty("exportSettingsJson", exportSettings);
    }
    // Master output volume. Omitted when at unity (1.0) so legacy
    // projects round-trip without an extra field; renderer falls
    // back to 1.0 when absent.
    {
        const auto masterVolume = projectState.getMasterVolume();
        if (! juce::approximatelyEqual(masterVolume, 1.0F))
            obj->setProperty("masterVolume", masterVolume);
    }
    // Project-shared Reverb + Delay. Each scalar is emitted
    // only when non-default so the Track FX Reverb / Delay modules restore
    // after a reload while legacy projects round-trip byte-clean (the
    // renderer reads each field as optional and falls back to the
    // inaudible default when absent). The audio engine restores these
    // separately in rebuildEngineFromProject.
    {
        const auto emitUnit = [obj](const char* key, float v) {
            if (v > 1.0e-4f) obj->setProperty(key, v);
        };
        emitUnit("reverbSize", projectState.getProjectReverbSize());
        emitUnit("reverbDecay", projectState.getProjectReverbDecay());
        emitUnit("reverbTone", projectState.getProjectReverbTone());
        emitUnit("reverbMix", projectState.getProjectReverbMix());
        const auto noteValue = projectState.getProjectDelayNoteValue();
        if (noteValue != "1/8") obj->setProperty("delayNoteValue", noteValue);
        emitUnit("delayFeedback", projectState.getProjectDelayFeedback());
        emitUnit("delayTone", projectState.getProjectDelayTone());
        emitUnit("delayMix", projectState.getProjectDelayMix());
    }
    return juce::var(obj);
}

/**
 * Library-item relink. Updates the source file path on a library item
 * and rebuilds every clip that references it. Every dependent clip
 * picks up the new file automatically because clips reference the
 * library item by id, not by path.
 */
void handleLibraryItemRelink(const juce::var& payload, silverdaw::AudioEngine& engine,
                             silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                             const ProjectSession& session, juce::ThreadPool& peakPool,
                             const silverdaw::DecodedCache& decodedCache)
{
    const juce::String itemId = tryGetRequiredString(payload, "itemId").value_or(juce::String{});
    const juce::String filePath = tryGetRequiredString(payload, "filePath").value_or(juce::String{});
    if (itemId.isEmpty() || filePath.isEmpty())
    {
        return;
    }
    if (!projectState.setLibraryItemFilePath(itemId, filePath))
    {
        silverdaw::log::warn("project", "LIBRARY_ITEM_RELINK unknown itemId=" + itemId);
        return;
    }

    // Re-create every clip that points at this library item so the
    // engine swaps in the new source file. Each clip is its own
    // playable source in the engine, so we rebuild them individually.
    const auto& root = projectState.getTree();
    int rebuilt = 0;
    int failed = 0;
    for (int t = 0; t < root.getNumChildren(); ++t)
    {
        const auto track = root.getChild(t);
        if (!track.hasType(juce::Identifier{"TRACK"})) continue;
        for (int c = 0; c < track.getNumChildren(); ++c)
        {
            const auto clip = track.getChild(c);
            if (!clip.hasType(juce::Identifier{"CLIP"})) continue;
            if (clip.getProperty("libraryItemId", {}).toString() != itemId) continue;

            const juce::String clipId = clip.getProperty("id").toString();
            const double offsetMs = static_cast<double>(clip.getProperty("offsetMs", 0.0));
            const double inMs = static_cast<double>(clip.getProperty("inMs", 0.0));
            const double durationMs = static_cast<double>(clip.getProperty("durationMs", 0.0));
            const auto trackId = track.getProperty("id").toString();
            const auto effectiveGain = projectState.getEffectiveTrackGain(trackId);

            engine.removeClip(clipId);
            const juce::String engineFilePath =
                silverdaw::resolveEnginePlaybackPath(filePath, projectState, decodedCache);
            if (engineFilePath == filePath)
            {
                silverdaw::ensureDecodedCache(filePath, engine, projectState, peakPool, decodedCache);
            }
            juce::String err;
            if (engine.addClip(trackId, clipId, juce::File(engineFilePath), offsetMs, inMs, durationMs, effectiveGain, &err))
            {
                engine.setClipGain(clipId, effectiveGain);
                ++rebuilt;
            }
            else
            {
                ++failed;
                silverdaw::log::warn("project", "relink-rebuild failed clipId=" + clipId + " err=" + err);
            }
        }
    }
    silverdaw::log::info("project", "LIBRARY_ITEM_RELINK itemId=" + itemId + " rebuilt=" + juce::String(rebuilt) +
                                        " failed=" + juce::String(failed));

    // Re-broadcast PROJECT_STATE so the renderer learns the new
    // filePath + clears the unresolved flag on every dependent clip.
    bridge.broadcast("PROJECT_STATE", buildProjectStateEnvelope(session, projectState, false));
}

/**
 * Replace the engine's playable sources with one per clip described in
 * `projectState`. Caller is responsible for first dropping every clip
 * the engine currently holds — `handleProjectLoad` / `handleProjectNew`
 * do that immediately before invoking this.
 */
void rebuildEngineFromProject(silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                              juce::ThreadPool& peakPool, const silverdaw::DecodedCache& decodedCache)
{
    const auto& root = projectState.getTree();
    int rebuilt = 0;
    int failed = 0;
    for (int t = 0; t < root.getNumChildren(); ++t)
    {
        const auto track = root.getChild(t);
        if (!track.hasType(juce::Identifier{"TRACK"}))
        {
            continue;
        }
        // Phase 5 — restore persisted per-track Tone EQ. Pushed once per
        // track (independent of clips) and snapped so the response is
        // steady-state immediately, matching offline export. Only push
        // when non-default so a freshly-loaded flat project doesn't
        // hammer the audio thread with identity updates.
        {
            const auto toneTrackId = track.getProperty("id").toString();
            const float tBass = projectState.getTrackToneBassDb(toneTrackId);
            const float tMid = projectState.getTrackToneMidDb(toneTrackId);
            const float tTreble = projectState.getTrackToneTrebleDb(toneTrackId);
            const bool tLowCut = projectState.getTrackToneLowCut(toneTrackId);
            const bool tHighCut = projectState.getTrackToneHighCut(toneTrackId);
            if (tBass != 0.0F || tMid != 0.0F || tTreble != 0.0F || tLowCut || tHighCut)
                engine.setTrackTone(toneTrackId, tBass, tMid, tTreble, tLowCut, tHighCut, /*snap*/ true);

            // Phase 5 — restore persisted per-track Leveler Amount. Snapped so
            // the compressor response is steady-state immediately; only pushed
            // when non-zero so a flat project doesn't fan out identity updates.
            const float tLeveler = projectState.getTrackLevelerAmount(toneTrackId);
            if (tLeveler != 0.0F)
                engine.setTrackLeveler(toneTrackId, tLeveler, /*snap*/ true);

            // Phase 5 — restore persisted per-track Reverb / Delay send
            // amounts. Snapped; only pushed when non-zero so a flat
            // project doesn't fan out identity updates.
            const float sReverb = projectState.getTrackReverbSend(toneTrackId);
            const float sDelay = projectState.getTrackDelaySend(toneTrackId);
            if (sReverb != 0.0F || sDelay != 0.0F)
                engine.setTrackSends(toneTrackId, sReverb, sDelay);

            // Phase 5 — restore persisted per-track pan. Pushed only when
            // off-centre so a default project doesn't fan out identity
            // updates (the engine keeps the bit-exact unity path at 0).
            const float pan = projectState.getTrackPan(toneTrackId);
            if (pan != 0.0F)
                engine.setTrackPan(toneTrackId, pan);
        }
        for (int c = 0; c < track.getNumChildren(); ++c)
        {
            const auto clip = track.getChild(c);
            if (!clip.hasType(juce::Identifier{"CLIP"}))
            {
                continue;
            }
            const juce::String clipId = clip.getProperty("id").toString();
            const juce::String libraryItemId = clip.getProperty("libraryItemId", {}).toString();
            const juce::String filePath = projectState.getLibraryItemFilePath(libraryItemId);
            const double offsetMs = static_cast<double>(clip.getProperty("offsetMs", 0.0));
            const double inMs = static_cast<double>(clip.getProperty("inMs", 0.0));
            const double durationMs = static_cast<double>(clip.getProperty("durationMs", 0.0));
            if (clipId.isEmpty() || libraryItemId.isEmpty() || filePath.isEmpty())
            {
                ++failed;
                silverdaw::log::warn("project", "skip clipId=" + clipId + " libraryItemId=" + libraryItemId +
                                                    " (no resolvable source)");
                continue;
            }
            // Same WAV-first resolution as `handleClipAdd` so a loaded
            // project never plays compressed sources at the engine.
            const juce::String engineFilePath =
                silverdaw::resolveEnginePlaybackPath(filePath, projectState, decodedCache);
            if (engineFilePath == filePath)
            {
                silverdaw::ensureDecodedCache(filePath, engine, projectState, peakPool, decodedCache);
            }
            juce::String err;
            // Project rebuild after load must use the EFFECTIVE
            // track gain (post-mute/solo) so a project saved with a
            // soloed track replays correctly: the soloed track plays
            // at its user volume and every other track is silenced.
            // Reading `track.gain` raw here was the bug — it gave
            // every track its user volume regardless of mute/solo
            // state, so a reopened soloed project played everyone.
            const auto trackId = track.getProperty("id").toString();
            const auto effectiveGain = projectState.getEffectiveTrackGain(trackId);
            if (engine.addClip(trackId, clipId, juce::File(engineFilePath), offsetMs, inMs, durationMs, effectiveGain, &err))
            {
                ++rebuilt;
                // If the saved project carried warp settings on this
                // clip, replay them onto the freshly-built engine
                // clip so a loaded project plays at the user's
                // intended tempo / pitch. Identical to what a fresh
                // CLIP_SET_WARP envelope would do.
                const auto warpEnabled = static_cast<bool>(clip.getProperty("warpEnabled", false));
                if (warpEnabled)
                {
                    const auto warpMode = clip.getProperty("warpMode", "rhythmic").toString();
                    std::optional<double> tempoRatio;
                    if (clip.hasProperty("tempoRatio"))
                        tempoRatio = static_cast<double>(clip.getProperty("tempoRatio", 1.0));
                    else
                    {
                        // No pin: derive live from project BPM vs source BPM.
                        const auto warpLibraryItemId = clip.getProperty("libraryItemId", {}).toString();
                        const double sourceBpm = projectState.getLibraryItemBpm(warpLibraryItemId);
                        const double projectBpm = projectState.getBpm();
                        if (sourceBpm > 0.0 && projectBpm > 0.0)
                            tempoRatio = projectBpm / sourceBpm;
                    }
                    const std::optional<double> semitones =
                        clip.hasProperty("semitones")
                            ? std::optional<double>{static_cast<double>(clip.getProperty("semitones", 0.0))}
                            : std::nullopt;
                    const std::optional<double> cents =
                        clip.hasProperty("cents")
                            ? std::optional<double>{static_cast<double>(clip.getProperty("cents", 0.0))}
                            : std::nullopt;
                    engine.setClipWarp(clipId, true, warpMode, tempoRatio, semitones, cents);
                }

                // Phase 5 — restore persisted per-clip volume envelope.
                // Only push when the clip actually carries breakpoints so
                // legacy / unshaped clips stay on the no-op fast path.
                if (clip.hasProperty("envelopePoints"))
                {
                    const auto& envVar = clip.getProperty("envelopePoints");
                    if (envVar.isArray() && envVar.getArray()->size() > 0)
                    {
                        engine.setClipEnvelope(clipId, *envVar.getArray());
                    }
                }
            }
            else
            {
                ++failed;
                silverdaw::log::warn("project", "addClip failed clipId=" + clipId + " path=" + filePath +
                                                     " err=" + err);
            }
        }
    }
    if (failed > 0)
    {
        silverdaw::log::warn("project",
                             "rebuilt " + juce::String(rebuilt) + " clip(s); " + juce::String(failed) +
                                 " failed (audio for those clips will be silent)");
    }
    // §12.1 — drop any transitions whose invariants no longer hold (e.g. a
    // hand-edited or future-version project file) WITHOUT polluting the undo
    // history, then publish each clip's derived edge-fade to the live engine
    // so a loaded project's crossfades sound immediately.
    projectState.reconcileTransitions(/*useUndo*/ false);
    silverdaw::syncClipEdgeFades(engine, projectState);

    // Restore project-level master volume to the live engine. PROJECT_NEW
    // resets to 1.0; PROJECT_LOAD / recovery / undo / redo all reuse this
    // path so the slider value persists across a load and undo never
    // diverges audio from the visible UI value.
    engine.setMasterGain(projectState.getMasterVolume());

    // Phase 5 — restore project-shared Reverb / Delay. Pushed UNCONDITIONALLY
    // (snapped) so a PROJECT_NEW / PROJECT_LOAD resets the single shared
    // FX instance to this project's values rather than inheriting the
    // previous project's settings. Delay time resolves via the shared
    // helper so live ↔ export parity holds.
    engine.setProjectReverb(projectState.getProjectReverbSize(),
                            projectState.getProjectReverbDecay(),
                            projectState.getProjectReverbTone(),
                            projectState.getProjectReverbMix(), /*snap*/ true);
    engine.setProjectDelay(
        silverdaw::delayNoteToMs(projectState.getProjectDelayNoteValue(), projectState.getBpm()),
        projectState.getProjectDelayFeedback(), projectState.getProjectDelayTone(),
        projectState.getProjectDelayMix(), /*snap*/ true);
}

void handleProjectNew(silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                      silverdaw::BridgeServer& bridge, ProjectSession& session)
{
    // Capture the CURRENT project's clip ids before we replace the tree —
    // otherwise we'd ask the engine to remove the freshly-empty set,
    // leaking the old playable sources.
    const auto previousClipIds = collectClipIds(projectState);

    engine.stop();
    for (const auto& id : previousClipIds)
    {
        engine.removeClip(id);
    }

    juce::ValueTree fresh(juce::Identifier{"PROJECT"});
    fresh.setProperty(juce::Identifier{"name"}, silverdaw::ProjectState::kDefaultName, nullptr);
    projectState.replaceTree(fresh);
    session.currentPath.clear();

    bridge.broadcast("PROJECT_STATE", buildProjectStateEnvelope(session, projectState, true));
}

void handleProjectLoad(const juce::var& payload, silverdaw::AudioEngine& engine,
                       silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                       ProjectSession& session, juce::ThreadPool& peakPool,
                       const silverdaw::DecodedCache& decodedCache)
{
    const juce::String filePath = tryGetRequiredString(payload, "filePath").value_or(juce::String{});
    if (filePath.isEmpty())
    {
        auto* p = new juce::DynamicObject();
        p->setProperty("filePath", filePath);
        p->setProperty("error", juce::String("Missing filePath"));
        bridge.broadcast("PROJECT_LOAD_FAILED", juce::var(p));
        return;
    }

    // Capture OLD clip ids before the load wipes the ValueTree — needed
    // to tear down the engine's playable sources for the previous
    // project. Done before `ProjectFile::load` so a load failure leaves
    // the engine intact (we only call removeClip / addClip on success).
    const auto previousClipIds = collectClipIds(projectState);

    const auto result = silverdaw::ProjectFile::load(juce::File(filePath), projectState);
    if (!result.ok)
    {
        auto* p = new juce::DynamicObject();
        p->setProperty("filePath", filePath);
        p->setProperty("error", result.error);
        bridge.broadcast("PROJECT_LOAD_FAILED", juce::var(p));
        silverdaw::log::warn("project", "PROJECT_LOAD failed: " + result.error);
        return;
    }

    engine.stop();
    for (const auto& id : previousClipIds)
    {
        engine.removeClip(id);
    }
    rebuildEngineFromProject(engine, projectState, peakPool, decodedCache);
    // Restore the persisted playhead position so the user reopens the
    // project at the same point they left it. `engine.stop()` reset to
    // 0 above; this puts us back where the project file says.
    const double persistedPlayhead = projectState.getPlayheadMs();
    if (persistedPlayhead > 0.0)
    {
        engine.setPositionMs(persistedPlayhead);
    }
    // Block-prime the read-ahead buffers at the restored playhead so the
    // first "press play" after a load is instant — never an audible gap
    // while the background reader catches up at a non-zero position.
    engine.primeTracksForPlayback(silverdaw::kLoadPrimeBudgetMs);
    session.currentPath = filePath;

    bridge.broadcast("PROJECT_STATE", buildProjectStateEnvelope(session, projectState, true));
    silverdaw::log::info("project", "PROJECT_LOAD ok path=" + filePath);
}

void handleProjectSave(const juce::var& payload, silverdaw::AudioEngine& engine,
                       silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                       ProjectSession& session, bool isSaveAs)
{
    juce::String filePath = tryGetRequiredString(payload, "filePath").value_or(juce::String{});
    if (filePath.isEmpty())
    {
        // PROJECT_SAVE with no path falls back to the current project's
        // path. The renderer is supposed to gate this on currentFilePath
        // being non-null, but we double-check defensively.
        filePath = session.currentPath;
    }
    if (filePath.isEmpty())
    {
        auto* p = new juce::DynamicObject();
        p->setProperty("filePath", filePath);
        p->setProperty("ok", false);
        p->setProperty("error", juce::String("No project path; use Save As first"));
        bridge.broadcast("PROJECT_SAVED", juce::var(p));
        return;
    }

    const auto scrollX = tryGetNumber(payload, "viewScrollX");
    if (scrollX.has_value())
    {
        projectState.setViewScrollX(juce::jmax(0.0, *scrollX));
    }

    // Capture the engine's current playhead position into the project
    // tree just before serialisation so the saved file remembers where
    // the user was. Suppressed from dirty-tracking inside `setPlayheadMs`
    // — capturing this value is a save-side concern, not a user edit.
    projectState.setPlayheadMs(engine.getPositionMs());

    const auto result = silverdaw::ProjectFile::save(juce::File(filePath), projectState);
    auto* p = new juce::DynamicObject();
    p->setProperty("filePath", filePath);
    p->setProperty("ok", result.wasOk());
    if (!result.wasOk())
    {
        p->setProperty("error", result.getErrorMessage());
    }
    if (result.wasOk())
    {
        session.currentPath = filePath;
        // If the project still has its default name (Untitled), fold
        // the file basename in so the title bar reflects the chosen
        // filename. Once the user has explicitly renamed the project
        // to anything else we leave their choice alone — Save / Save
        // As should never silently overwrite a user-chosen name.
        if (projectState.getName() == silverdaw::ProjectState::kDefaultName)
        {
            const auto stem = juce::File(filePath).getFileNameWithoutExtension();
            if (stem.isNotEmpty())
            {
                projectState.setName(stem);
            }
        }
        // A successful save makes the in-memory state match disk; clear
        // dirty. `markClean` fires a PROJECT_DIRTY(false) transition.
        projectState.markClean();
    }
    bridge.broadcast("PROJECT_SAVED", juce::var(p));
    silverdaw::log::info("project",
                         juce::String("PROJECT_SAVE ") + (isSaveAs ? "(as) " : "") +
                             (result.wasOk() ? "ok" : "fail: " + result.getErrorMessage()) + " path=" + filePath);
    if (result.wasOk() && isSaveAs)
    {
        // Push the updated project state so the renderer picks up the
        // new filePath + name without waiting on a rename ack.
        bridge.broadcast("PROJECT_STATE", buildProjectStateEnvelope(session, projectState, false));
    }
}

void handleProjectSaveViewState(const juce::var& payload, silverdaw::AudioEngine& engine,
                                silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                                const ProjectSession& session)
{
    juce::String filePath = tryGetRequiredString(payload, "filePath").value_or(juce::String{});
    if (filePath.isEmpty())
    {
        filePath = session.currentPath;
    }

    auto* p = new juce::DynamicObject();
    p->setProperty("filePath", filePath);
    if (filePath.isEmpty())
    {
        p->setProperty("ok", false);
        p->setProperty("error", juce::String("No project path for view-state save"));
        bridge.broadcast("PROJECT_VIEW_STATE_SAVED", juce::var(p));
        return;
    }

    const double scrollX = juce::jmax(0.0, tryGetNumber(payload, "viewScrollX").value_or(projectState.getViewScrollX()));
    const double playheadMs = juce::jmax(0.0, engine.getPositionMs());
    projectState.setViewScrollX(scrollX);
    projectState.setPlayheadMs(playheadMs);

    // Selection + panel state are kept current on the project tree via
    // PROJECT_SET_VIEW pushes, so the lightweight view-state save just
    // mirrors whatever is already there into the file.
    const juce::String selectedTrackId = projectState.getViewSelectedTrack();
    const bool fxPanelOpen = projectState.getViewFxPanelOpen();

    const auto result = silverdaw::ProjectFile::saveViewState(juce::File(filePath), scrollX, playheadMs,
                                                              selectedTrackId, fxPanelOpen);
    p->setProperty("ok", result.wasOk());
    if (!result.wasOk())
    {
        p->setProperty("error", result.getErrorMessage());
    }
    bridge.broadcast("PROJECT_VIEW_STATE_SAVED", juce::var(p));
    silverdaw::log::info("project",
                         juce::String("PROJECT_SAVE_VIEW_STATE ") +
                             (result.wasOk() ? "ok" : "fail: " + result.getErrorMessage()) + " path=" + filePath);
}

void handleProjectRename(const juce::var& payload, silverdaw::ProjectState& projectState,
                         silverdaw::BridgeServer& bridge)
{
    const juce::String name = tryGetRequiredString(payload, "name").value_or(juce::String{});
    projectState.setName(name);
    auto* p = new juce::DynamicObject();
    p->setProperty("name", projectState.getName());
    p->setProperty("ok", true);
    bridge.broadcast("PROJECT_RENAMED", juce::var(p));
}

// Background autosave: serialise the current ValueTree to `filePath`
// without touching `session.currentPath` or the dirty flag. Used by the
// renderer's autosave manager — autosave is deliberately invisible to
// the user-facing project lifecycle so an in-progress edit session is
// never silently "saved" against the wrong file or quietly marked
// clean. Playhead and scroll setters are dirty-suppressed (see
// `ProjectState::setPlayheadMs` / `setViewScrollX`) so capturing them
// here doesn't pollute the dirty bit.
void handleProjectAutosave(const juce::var& payload, silverdaw::AudioEngine& engine,
                           silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge)
{
    const juce::String filePath = tryGetRequiredString(payload, "filePath").value_or(juce::String{});
    auto* p = new juce::DynamicObject();
    p->setProperty("filePath", filePath);
    if (filePath.isEmpty())
    {
        p->setProperty("ok", false);
        p->setProperty("error", juce::String("Missing filePath"));
        bridge.broadcast("PROJECT_AUTOSAVED", juce::var(p));
        return;
    }

    // Capture playhead + scroll so a recovered autosave restores the
    // user where they actually were. Both setters are explicitly
    // dirty-suppressed so this does not turn into a feedback loop with
    // the autosave manager (which only runs while the project is
    // already dirty).
    const auto scrollX = tryGetNumber(payload, "viewScrollX");
    if (scrollX.has_value())
    {
        projectState.setViewScrollX(juce::jmax(0.0, *scrollX));
    }
    projectState.setPlayheadMs(juce::jmax(0.0, engine.getPositionMs()));

    const auto result = silverdaw::ProjectFile::save(juce::File(filePath), projectState);
    p->setProperty("ok", result.wasOk());
    if (!result.wasOk())
    {
        p->setProperty("error", result.getErrorMessage());
    }
    bridge.broadcast("PROJECT_AUTOSAVED", juce::var(p));
    silverdaw::log::debug("project",
                         juce::String("PROJECT_AUTOSAVE ") +
                             (result.wasOk() ? "ok" : "fail: " + result.getErrorMessage()) + " path=" + filePath);
}

// Crash-recovery load. Same restore pipeline as PROJECT_LOAD but
// `session.currentPath` is set to the *original* backing path (or left
// empty when the autosave was for an untitled project) so File > Save
// either overwrites the original or falls through to Save As. The
// project is marked dirty after the load so the user is clearly
// steered to a deliberate save (the autosave file should be a transient
// safety net, not a stand-in for the real project).
void handleProjectLoadRecovery(const juce::var& payload, silverdaw::AudioEngine& engine,
                               silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                               ProjectSession& session, juce::ThreadPool& peakPool,
                               const silverdaw::DecodedCache& decodedCache)
{
    const juce::String autosavePath = tryGetRequiredString(payload, "autosavePath").value_or(juce::String{});
    const juce::var originalVar = payload.getProperty("originalPath", juce::var());
    const juce::String originalPath = originalVar.isString() ? originalVar.toString() : juce::String();

    if (autosavePath.isEmpty())
    {
        auto* p = new juce::DynamicObject();
        p->setProperty("filePath", autosavePath);
        p->setProperty("error", juce::String("Missing autosavePath"));
        bridge.broadcast("PROJECT_LOAD_FAILED", juce::var(p));
        return;
    }

    const auto previousClipIds = collectClipIds(projectState);

    const auto result = silverdaw::ProjectFile::load(juce::File(autosavePath), projectState);
    if (!result.ok)
    {
        auto* p = new juce::DynamicObject();
        p->setProperty("filePath", autosavePath);
        p->setProperty("error", result.error);
        bridge.broadcast("PROJECT_LOAD_FAILED", juce::var(p));
        silverdaw::log::warn("project", "PROJECT_LOAD_RECOVERY failed: " + result.error);
        return;
    }

    engine.stop();
    for (const auto& id : previousClipIds)
    {
        engine.removeClip(id);
    }
    rebuildEngineFromProject(engine, projectState, peakPool, decodedCache);

    const double persistedPlayhead = projectState.getPlayheadMs();
    if (persistedPlayhead > 0.0)
    {
        engine.setPositionMs(persistedPlayhead);
    }
    // Block-prime the read-ahead buffers at the restored playhead so the
    // first "press play" after a recovery is instant (see PROJECT_LOAD).
    engine.primeTracksForPlayback(silverdaw::kLoadPrimeBudgetMs);

    // Aim the user's "current project" pointer at the original backing
    // path (or clear it for an untitled recovery). The autosave path
    // itself is never exposed as the user's working file.
    session.currentPath = originalPath;

    bridge.broadcast("PROJECT_STATE", buildProjectStateEnvelope(session, projectState, true));

    // Force dirty so the user is steered to save. `ProjectFile::load`
    // calls `markClean()` at the end of replaceTree, so we have to
    // re-dirty the project here rather than rely on the listener.
    projectState.markDirty();

    silverdaw::log::info("project",
                         juce::String("PROJECT_LOAD_RECOVERY ok autosavePath=") + autosavePath +
                             " originalPath=" + originalPath);
}

// ─── Undo / Redo plumbing ─────────────────────────────────────────────
//
// The backend's `juce::UndoManager` already collects every ValueTree
// mutation that goes through `&undoManager` (see ProjectState.cpp).
// Without explicit transaction boundaries every individual
// `setProperty` becomes its own undoable action — a 60Hz drag would
// produce hundreds of useless one-pixel undo steps. We call
// `beginNewTransaction(name)` at the start of every project-mutating
// dispatch so each bridge envelope is exactly one undo step, with a
// small coalescing window for streaming drags.

// Bridge envelope types whose handlers actually mutate
// `setProperty(..., &undoManager)`-tracked state.
bool isUndoableEnvelopeType(const juce::String& type) noexcept
{
    return type == "CLIP_ADD" || type == "CLIP_MOVE" || type == "CLIP_TRIM" || type == "CLIP_COLOR" ||
           type == "CLIP_SET_LOCKED" ||
           type == "CLIP_REMOVE" || type == "CLIP_RENAME" || type == "CLIP_REBIND" ||
           type == "CLIP_SET_WARP" ||
           type == "CLIP_RELINK" ||
           type == "TRACK_ADD" || type == "TRACK_REMOVE" || type == "TRACK_RENAME" ||
           type == "TRACK_GAIN" || type == "TRACK_MUTE" || type == "TRACK_SOLO" ||
           type == "TRACK_SET_HEIGHT" || type == "TRACK_REORDER" ||
           type == "TRACK_SET_SENDS" || type == "TRACK_SET_TONE" || type == "TRACK_SET_LEVELER" ||
           type == "TRACK_SET_PAN" ||
           type == "CLIP_SET_ENVELOPE" ||
           type == "PROJECT_SET_REVERB" || type == "PROJECT_SET_DELAY" ||
           type == "LIBRARY_ADD" || type == "LIBRARY_REMOVE" ||
           type == "LIBRARY_REANALYSE" || type == "LIBRARY_ITEM_RELINK" ||
           type == "LIBRARY_ITEM_SET_SAMPLE_MODE" ||
           type == "PROJECT_RENAME" || type == "PROJECT_SET_BPM" || type == "PROJECT_SET_LENGTH" ||
           type == "PROJECT_SET_AUDIO_OUTPUT" ||
           type == "PROJECT_SET_TARGET_SAMPLE_RATE" ||
           type == "PROJECT_SET_MASTER_VOLUME" ||
           type == "PROJECT_MARKER_ADD" || type == "PROJECT_MARKER_MOVE" ||
           type == "PROJECT_MARKER_REMOVE" ||
           type == "TRANSITION_CREATE" || type == "TRANSITION_DELETE" ||
           type == "TRANSITION_SET_RECIPE";
}

juce::String prettyTransactionName(const juce::String& type)
{
    if (type == "CLIP_ADD") return "Add clip";
    if (type == "CLIP_MOVE") return "Move clip";
    if (type == "CLIP_TRIM") return "Trim clip";
    if (type == "CLIP_COLOR") return "Recolour clip";
    if (type == "CLIP_SET_LOCKED") return "Toggle clip lock";
    if (type == "CLIP_REMOVE") return "Delete clip";
    if (type == "CLIP_RENAME") return "Rename clip";
    if (type == "CLIP_REBIND") return "Save clip to library";
    if (type == "CLIP_SET_WARP") return "Change warp";
    if (type == "CLIP_RELINK") return "Relink clip";
    if (type == "TRACK_ADD") return "Add track";
    if (type == "TRACK_REMOVE") return "Remove track";
    if (type == "TRACK_RENAME") return "Rename track";
    if (type == "TRACK_GAIN") return "Change track gain";
    if (type == "TRACK_MUTE") return "Mute track";
    if (type == "TRACK_SOLO") return "Solo track";
    if (type == "TRACK_SET_HEIGHT") return "Resize track";
    if (type == "TRACK_REORDER") return "Reorder track";
    if (type == "TRACK_SET_SENDS") return "Change track reverb/delay";
    if (type == "TRACK_SET_TONE") return "Change track tone";
    if (type == "TRACK_SET_LEVELER") return "Change track leveler";
    if (type == "TRACK_SET_PAN") return "Change track pan";
    if (type == "CLIP_SET_ENVELOPE") return "Edit clip volume envelope";
    if (type == "PROJECT_SET_REVERB") return "Change reverb";
    if (type == "PROJECT_SET_DELAY") return "Change delay";
    if (type == "LIBRARY_ADD") return "Update library item";
    if (type == "LIBRARY_REMOVE") return "Remove library item";
    if (type == "LIBRARY_REANALYSE") return "Reanalyse library item";
    if (type == "LIBRARY_ITEM_RELINK") return "Relink library item";
    if (type == "LIBRARY_ITEM_SET_SAMPLE_MODE") return "Change library item classification";
    if (type == "PROJECT_RENAME") return "Rename project";
    if (type == "PROJECT_SET_BPM") return "Change tempo";
    if (type == "PROJECT_SET_LENGTH") return "Change project length";
    if (type == "PROJECT_SET_AUDIO_OUTPUT") return "Change audio output";
    if (type == "PROJECT_SET_TARGET_SAMPLE_RATE") return "Change project sample rate";
    if (type == "PROJECT_SET_MASTER_VOLUME") return "Change master volume";
    if (type == "PROJECT_MARKER_ADD") return "Add marker";
    if (type == "PROJECT_MARKER_MOVE") return "Move marker";
    if (type == "PROJECT_MARKER_REMOVE") return "Remove marker";
    if (type == "TRANSITION_CREATE") return "Add transition";
    if (type == "TRANSITION_DELETE") return "Remove transition";
    if (type == "TRANSITION_SET_RECIPE") return "Change transition";
    return type;
}

// File-scope coalescing state. Dispatch always runs on the JUCE message
// thread so no synchronisation is needed.
//
// Two coalescing modes are supported:
//   1. **Time-window mode** (legacy): same `(type, idPart)` within
//      `kUndoCoalesceWindowMs` reuses the open transaction. This is what
//      the existing CLIP_MOVE / CLIP_TRIM / TRACK_GAIN / slider drag
//      paths rely on and the new fader paths fall back to when the
//      renderer doesn't mint a gestureId.
//   2. **Explicit-gesture mode** (Phase 5): when the envelope carries a
//      `gestureId` string, coalescing keys on `(type, idPart, gestureId)`
//      regardless of elapsed time. The terminal event of a gesture sets
//      `gestureEnd: true` — that event still folds into the open
//      transaction; the coalesce state is cleared AFTER it lands so the
//      next gesture opens a fresh undo step.
struct UndoCoalesceState
{
    juce::String lastKey;
    juce::int64 lastTimeMs = 0;
    bool gestureActive = false;
};

static UndoCoalesceState& undoCoalesceState()
{
    static UndoCoalesceState state;
    return state;
}

void resetUndoCoalesceState() noexcept
{
    auto& s = undoCoalesceState();
    s.lastKey = {};
    s.lastTimeMs = 0;
    s.gestureActive = false;
}

// 60Hz drag streams (CLIP_MOVE / CLIP_TRIM / TRACK_GAIN) coalesce
// same-target events within this window into a single undo step. Other
// mutating envelopes get a fresh transaction every time.
constexpr juce::int64 kUndoCoalesceWindowMs = 500;

void beginUndoTransactionIfNeeded(const juce::String& type, const juce::var& payload,
                                  silverdaw::ProjectState& projectState)
{
    if (!isUndoableEnvelopeType(type)) return;

    juce::String idPart;
    if (type == "CLIP_MOVE" || type == "CLIP_TRIM" || type == "CLIP_SET_WARP" ||
        type == "CLIP_SET_ENVELOPE")
    {
        idPart = payload.getProperty("clipId", "").toString();
    }
    else if (type == "TRACK_GAIN" || type == "TRACK_SET_SENDS" ||
             type == "TRACK_SET_TONE" || type == "TRACK_SET_LEVELER" ||
             type == "TRACK_SET_PAN")
    {
        idPart = payload.getProperty("trackId", "").toString();
    }
    else if (type == "PROJECT_SET_MASTER_VOLUME" ||
             type == "PROJECT_SET_REVERB" || type == "PROJECT_SET_DELAY")
    {
        // Singleton project-level edit — slider drag coalesces.
        idPart = "_";
    }
    else if (type == "PROJECT_MARKER_MOVE")
    {
        idPart = payload.getProperty("markerId", "").toString();
    }
    else if (type == "PROJECT_SET_BPM" || type == "PROJECT_SET_LENGTH" || type == "PROJECT_RENAME")
    {
        // Singleton project-level edits coalesce against themselves
        // — typing in the BPM / length / name field commits per
        // keystroke, but we want one undo step per "edit session".
        idPart = "_";
    }

    const auto gestureId = payload.getProperty("gestureId", "").toString();

    juce::String key = type;
    if (idPart.isNotEmpty()) key << ":" << idPart;
    if (gestureId.isNotEmpty()) key << "#" << gestureId;

    const auto now = juce::Time::currentTimeMillis();
    auto& s = undoCoalesceState();

    // Explicit-gesture coalesce ignores the time window entirely. The
    // renderer's pointerdown/pointermove/pointerup loop drives the same
    // `gestureId` for every sample so even a paused-mid-drag stream
    // stays in the same undo step.
    const bool gestureCoalesce =
        gestureId.isNotEmpty() && s.gestureActive && key == s.lastKey;

    const bool timeCoalesce =
        gestureId.isEmpty() && idPart.isNotEmpty() && key == s.lastKey &&
        (now - s.lastTimeMs) < kUndoCoalesceWindowMs;

    if (!gestureCoalesce && !timeCoalesce)
    {
        projectState.getUndoManager().beginNewTransaction(prettyTransactionName(type));
    }
    s.lastKey = key;
    s.lastTimeMs = now;
    s.gestureActive = gestureId.isNotEmpty();
}

// Companion to `beginUndoTransactionIfNeeded`. Called by the dispatcher
// AFTER the handler runs so that the terminal `gestureEnd: true` event
// folds into the open transaction (it was just applied above) and only
// THEN clears the coalesce state. Without this, a same-gesture follow-up
// sample arriving after `gestureEnd` would silently start a new undo
// step.
void endUndoTransactionIfNeeded(const juce::String& type, const juce::var& payload) noexcept
{
    if (!isUndoableEnvelopeType(type)) return;
    const auto gestureId = payload.getProperty("gestureId", "").toString();
    if (gestureId.isEmpty()) return;
    const bool gestureEnd = static_cast<bool>(payload.getProperty("gestureEnd", false));
    if (!gestureEnd) return;
    auto& s = undoCoalesceState();
    s.lastKey = {};
    s.lastTimeMs = 0;
    s.gestureActive = false;
}

juce::var buildEditUndoStateEnvelope(silverdaw::ProjectState& projectState)
{
    auto& um = projectState.getUndoManager();
    auto* obj = new juce::DynamicObject();
    const bool canUndo = um.canUndo();
    const bool canRedo = um.canRedo();
    obj->setProperty("canUndo", canUndo);
    obj->setProperty("canRedo", canRedo);
    if (canUndo)
    {
        const auto label = um.getUndoDescription();
        if (label.isNotEmpty()) obj->setProperty("undoLabel", label);
    }
    if (canRedo)
    {
        const auto label = um.getRedoDescription();
        if (label.isNotEmpty()) obj->setProperty("redoLabel", label);
    }
    return juce::var(obj);
}

void broadcastEditUndoState(silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge)
{
    bridge.broadcast("EDIT_UNDO_STATE", buildEditUndoStateEnvelope(projectState));
}

// Build a PROJECT_STATE envelope with the `softReplace` flag set —
// used by undo / redo to authoritatively reconcile the renderer's
// mirror (so removed tracks/clips actually vanish) without rotating
// projectId, marking clean, or clearing the renderer's clipboard /
// selection. The dirty state is communicated separately via a
// follow-up PROJECT_DIRTY broadcast.
juce::var buildSoftReplaceProjectStateEnvelope(const ProjectSession& session,
                                                silverdaw::ProjectState& projectState)
{
    auto envelope = buildProjectStateEnvelope(session, projectState, false);
    if (auto* obj = envelope.getDynamicObject())
    {
        obj->setProperty("softReplace", true);
    }
    return envelope;
}

void handleEditUndo(silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                    silverdaw::BridgeServer& bridge, ProjectSession& session,
                    juce::ThreadPool& peakPool, const silverdaw::DecodedCache& decodedCache)
{
    auto& um = projectState.getUndoManager();
    // Flush any in-flight coalesced transaction so this undo step is
    // a clean unit.
    um.beginNewTransaction();
    resetUndoCoalesceState();
    if (!um.canUndo())
    {
        silverdaw::log::debug("project", "EDIT_UNDO ignored (nothing to undo)");
        return;
    }

    // Capture engine playhead so the user doesn't get teleported to 0
    // by the rebuild's `engine.stop()`. View state (zoom, scroll) is
    // outside the undo stack so it survives naturally.
    const double playheadMs = engine.getPositionMs();
    const auto preIds = collectClipIds(projectState);

    engine.stop();
    um.undo();
    for (const auto& id : preIds) engine.removeClip(id);
    rebuildEngineFromProject(engine, projectState, peakPool, decodedCache);
    engine.setPositionMs(playheadMs);

    bridge.broadcast("PROJECT_STATE", buildSoftReplaceProjectStateEnvelope(session, projectState));

    // The dirty listener only fires on transitions. Force-broadcast the
    // current dirty state so the renderer's title-bar indicator picks up
    // the "still dirty after undo" case.
    {
        auto* p = new juce::DynamicObject();
        p->setProperty("dirty", projectState.isDirty());
        bridge.broadcast("PROJECT_DIRTY", juce::var(p));
    }

    silverdaw::log::info("project", "EDIT_UNDO ok");
}

void handleEditRedo(silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                    silverdaw::BridgeServer& bridge, ProjectSession& session,
                    juce::ThreadPool& peakPool, const silverdaw::DecodedCache& decodedCache)
{
    auto& um = projectState.getUndoManager();
    um.beginNewTransaction();
    resetUndoCoalesceState();
    if (!um.canRedo())
    {
        silverdaw::log::debug("project", "EDIT_REDO ignored (nothing to redo)");
        return;
    }

    const double playheadMs = engine.getPositionMs();
    const auto preIds = collectClipIds(projectState);

    engine.stop();
    um.redo();
    for (const auto& id : preIds) engine.removeClip(id);
    rebuildEngineFromProject(engine, projectState, peakPool, decodedCache);
    engine.setPositionMs(playheadMs);

    bridge.broadcast("PROJECT_STATE", buildSoftReplaceProjectStateEnvelope(session, projectState));
    {
        auto* p = new juce::DynamicObject();
        p->setProperty("dirty", projectState.isDirty());
        bridge.broadcast("PROJECT_DIRTY", juce::var(p));
    }

    silverdaw::log::info("project", "EDIT_REDO ok");
}

// ─── §12.1 clip-transition dispatch helpers ───────────────────────────────
//
// Shared epilogue for the discrete TRANSITION_* edits: re-derive every clip's
// edge-fade, drop any transition the edit invalidated (folding into the same
// open undo step), then rebroadcast the authoritative PROJECT_STATE. The
// renderer has no bespoke ack — the snapshot IS the ack — so we always
// rebroadcast, even when the mutation was rejected, to re-sync the client.
void finishTransitionEdit(silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                          silverdaw::BridgeServer& bridge, ProjectSession& session)
{
    projectState.reconcileTransitions(/*useUndo*/ true);
    silverdaw::syncClipEdgeFades(engine, projectState);
    bridge.broadcast("PROJECT_STATE", buildProjectStateEnvelope(session, projectState, false));
}

// Geometry edits that can move / resize a clip (or change its warp-scaled
// footprint) and therefore break a transition's sanctioned overlap. Undo /
// redo / load go through rebuildEngineFromProject (which reconciles + syncs
// separately), so they are intentionally excluded here.
bool transitionGeometryMayHaveChanged(const juce::String& type) noexcept
{
    return type == "CLIP_MOVE" || type == "CLIP_TRIM" || type == "CLIP_REMOVE" ||
           type == "CLIP_SET_WARP" || type == "TRACK_REMOVE" || type == "PROJECT_SET_BPM" ||
           type == "CLIP_RELINK";
}

// Re-derive edge-fades after a geometry edit and auto-delete any transition
// whose invariants broke. Gated on the project actually carrying a transition
// so a transition-free project keeps a byte-for-byte unchanged hot path (the
// dormancy invariant). Only rebroadcasts PROJECT_STATE when a transition was
// removed (a rare terminal event), so a 60 Hz move/trim drag does not spam
// full snapshots.
void reconcileTransitionsAfterGeometryEdit(silverdaw::AudioEngine& engine,
                                           silverdaw::ProjectState& projectState,
                                           silverdaw::BridgeServer& bridge, ProjectSession& session)
{
    if (!projectState.hasAnyTransition()) return;
    const bool removed = projectState.reconcileTransitions(/*useUndo*/ true);
    silverdaw::syncClipEdgeFades(engine, projectState);
    if (removed)
    {
        bridge.broadcast("PROJECT_STATE", buildProjectStateEnvelope(session, projectState, false));
    }
}

// Same wire-protocol convention as BridgeServer::broadcast: (type, payload) order is
// fixed by design, so the easily-swappable-parameters check is intentionally silenced.
// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
void dispatchBridgeMessage(const juce::String& type, const juce::var& payload, silverdaw::AudioEngine& engine,
                           silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                           juce::ThreadPool& peakPool, const silverdaw::PeaksCache& cache,
                           const silverdaw::DecodedCache& decodedCache, ProjectSession& session)
{
    // Liveness fast-path. PING is answered on the message thread so a
    // round-trip proves the engine command thread itself is responsive,
    // not merely that the socket is open. It mutates nothing, so it
    // bypasses the undo prologue/epilogue entirely.
    if (type == "PING")
    {
        auto* p = new juce::DynamicObject();
        p->setProperty("id", payload.getProperty("id", 0));
        bridge.broadcast("PONG", juce::var(p));
        return;
    }

    // Undo-transaction prologue. Each project-mutating envelope is wrapped
    // in its own UndoManager transaction so Ctrl+Z reverts one logical
    // edit. Drag streams (CLIP_MOVE / CLIP_TRIM / TRACK_GAIN) coalesce
    // same-target events within a 500 ms window so a 60 Hz drag is one
    // undo step.
    beginUndoTransactionIfNeeded(type, payload, projectState);
    if (type == "CLIP_ADD")
    {
        silverdaw::log::info("bridge", "recv CLIP_ADD trackId=" + payload.getProperty("trackId", "").toString() +
                                           " clipId=" + payload.getProperty("clipId", "").toString());
        handleClipAdd(payload, engine, projectState, bridge, peakPool, cache, decodedCache);
    }
    else if (type == "CLIP_MOVE")
    {
        silverdaw::log::debug("bridge", "recv CLIP_MOVE clipId=" + payload.getProperty("clipId", "").toString() +
                                            " pos=" + payload.getProperty("positionMs", "").toString());
        silverdaw::handleClipMove(payload, engine, projectState);
    }
    else if (type == "CLIP_TRIM")
    {
        silverdaw::log::debug("bridge", "recv CLIP_TRIM clipId=" + payload.getProperty("clipId", "").toString() +
                                            " start=" + payload.getProperty("startMs", "").toString() +
                                            " in=" + payload.getProperty("inMs", "").toString() +
                                            " dur=" + payload.getProperty("durationMs", "").toString());
        silverdaw::handleClipTrim(payload, engine, projectState);
    }
    else if (type == "CLIP_COLOR")
    {
        silverdaw::log::debug("bridge", "recv CLIP_COLOR clipId=" + payload.getProperty("clipId", "").toString() +
                                            " idx=" + payload.getProperty("colorIndex", "").toString());
        silverdaw::handleClipColor(payload, projectState);
    }
    else if (type == "CLIP_SET_LOCKED")
    {
        const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
        const bool locked = static_cast<bool>(payload.getProperty("locked", false));
        silverdaw::log::info("bridge", "recv CLIP_SET_LOCKED clipId=" + clipId +
                                          " locked=" + (locked ? "true" : "false"));
        if (clipId.isNotEmpty())
        {
            projectState.setClipLocked(clipId, locked);
        }
    }
    else if (type == "CLIP_REMOVE")
    {
        silverdaw::log::info("bridge", "recv CLIP_REMOVE clipId=" + payload.getProperty("clipId", "").toString());
        silverdaw::handleClipRemove(payload, engine, projectState, bridge);
    }
    else if (type == "LIBRARY_ITEM_RELINK")
    {
        silverdaw::log::info("bridge", "recv LIBRARY_ITEM_RELINK itemId=" + payload.getProperty("itemId", "").toString() +
                                            " path=" + payload.getProperty("filePath", "").toString());
        handleLibraryItemRelink(payload, engine, projectState, bridge, session, peakPool, decodedCache);
    }
    else if (type == "CLIP_RENAME")
    {
        const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
        const juce::String name = tryGetRequiredString(payload, "name").value_or(juce::String{});
        silverdaw::log::info("bridge", "recv CLIP_RENAME clipId=" + clipId + " name=" + name);
        projectState.setClipName(clipId, name);
    }
    else if (type == "CLIP_REBIND")
    {
        const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
        const juce::String libraryItemId = tryGetRequiredString(payload, "libraryItemId").value_or(juce::String{});
        silverdaw::log::info("bridge", "recv CLIP_REBIND clipId=" + clipId + " libraryItemId=" +
                                           libraryItemId);
        if (clipId.isNotEmpty() && libraryItemId.isNotEmpty())
        {
            projectState.setClipLibraryItemId(clipId, libraryItemId);
        }
    }
    else if (type == "CLIP_SET_WARP")
    {
        const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
        silverdaw::log::info("bridge", "recv CLIP_SET_WARP clipId=" + clipId);
        if (clipId.isNotEmpty())
        {
            std::optional<bool> warpEnabled;
            if (payload.hasProperty("warpEnabled"))
                warpEnabled = static_cast<bool>(payload.getProperty("warpEnabled", false));
            std::optional<juce::String> warpMode;
            if (payload.hasProperty("warpMode"))
                warpMode = tryGetRequiredString(payload, "warpMode").value_or(juce::String{});
            // `tempoRatio: null` clears the override (clip reverts to
            // project-BPM tracking); a finite number pins the ratio.
            std::optional<double> tempoRatio;
            bool tempoRatioClear = false;
            if (payload.hasProperty("tempoRatio"))
            {
                const auto& v = payload["tempoRatio"];
                if (v.isVoid() || v.isUndefined())
                    tempoRatioClear = true;
                else
                    tempoRatio = static_cast<double>(v);
            }
            std::optional<double> semitones;
            if (payload.hasProperty("semitones"))
                semitones = static_cast<double>(payload.getProperty("semitones", 0.0));
            std::optional<double> cents;
            if (payload.hasProperty("cents"))
                cents = static_cast<double>(payload.getProperty("cents", 0.0));
            std::optional<bool> pendingAutoWarp;
            if (payload.hasProperty("pendingAutoWarp"))
                pendingAutoWarp = static_cast<bool>(payload.getProperty("pendingAutoWarp", false));
            projectState.setClipWarp(clipId, warpEnabled, warpMode, tempoRatio, tempoRatioClear,
                                     semitones, cents, pendingAutoWarp);
            bool clipFound = false;
            bool enabledNow = false;
            bool tempoRatioPinnedNow = false;
            double pinnedTempoRatioNow = 1.0;
            juce::String libraryItemIdNow;
            projectState.forEachWarpClip(
                [&](const silverdaw::ProjectState::WarpClipInfo& info)
                {
                    if (info.clipId != clipId) return;
                    clipFound = true;
                    enabledNow = info.warpEnabled;
                    tempoRatioPinnedNow = info.tempoRatioPinned;
                    pinnedTempoRatioNow = info.tempoRatio;
                    libraryItemIdNow = info.libraryItemId;
                });
            // If the renderer enabled warp WITHOUT pinning a ratio
            // ("follow project BPM"), derive the effective ratio from
            // project / source BPM right here so the engine's lazily-
            // built WarpProcessor doesn't end up at its default 1.0
            // and play unwarped. Mirrors the derivation in
            // `rebuildEngineFromProject` so freshly-warped clips and
            // freshly-loaded warped clips end up identical.
            std::optional<double> effectiveRatio = tempoRatio;
            if (!effectiveRatio.has_value() && !tempoRatioClear && tempoRatioPinnedNow)
            {
                effectiveRatio = pinnedTempoRatioNow;
            }
            if (enabledNow && !effectiveRatio.has_value() && !tempoRatioClear)
            {
                const auto libraryItemId =
                    libraryItemIdNow.isNotEmpty() ? libraryItemIdNow : projectState.getClipLibraryItemId(clipId);
                if (libraryItemId.isNotEmpty())
                {
                    const double sourceBpm = projectState.getLibraryItemBpm(libraryItemId);
                    const double projectBpm = projectState.getBpm();
                    if (sourceBpm > 0.0 && projectBpm > 0.0)
                    {
                        effectiveRatio = projectBpm / sourceBpm;
                    }
                }
            }
            silverdaw::log::info("warp",
                "CLIP_SET_WARP clipId=" + clipId
                + " enabled=" + (clipFound ? (enabledNow ? "true" : "false") : "unknown")
                + " mode=" + (warpMode.has_value() ? *warpMode : juce::String("unset"))
                + " tempoRatio=" + (tempoRatio.has_value() ? juce::String(*tempoRatio) : juce::String(tempoRatioClear ? "null" : "unset"))
                + " pendingAutoWarp=" + (pendingAutoWarp.has_value() ? (*pendingAutoWarp ? "true" : "false") : "unset")
                + " effectiveRatio=" + (effectiveRatio.has_value() ? juce::String(*effectiveRatio) : juce::String("unset")));
            // Fan the same change out to the audio engine so the next
            // audio block reflects it. The engine owns the per-clip
            // WarpProcessor lifetime; it builds one lazily when
            // warp is first enabled and tears it down when disabled.
            engine.setClipWarp(clipId, warpEnabled, warpMode, effectiveRatio, semitones, cents);
            auto appliedPayload = silverdaw::buildClipWarpAppliedPayload(projectState, clipId);
            bridge.broadcast("CLIP_WARP_APPLIED", juce::var(appliedPayload.release()));
        }
    }
    else if (type == "CLIP_SAVE_AS_SAMPLE")
    {
        const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
        const juce::String itemId = tryGetRequiredString(payload, "itemId").value_or(juce::String{});
        const juce::String sampleName = tryGetRequiredString(payload, "sampleName").value_or(juce::String{});
        const juce::String outputDir = tryGetRequiredString(payload, "outputDir").value_or(juce::String{});
        if (clipId.isEmpty() || itemId.isEmpty() || outputDir.isEmpty()) return;
        std::optional<SampleWarpOptions> sampleWarp;
        projectState.forEachWarpClip(
            [&](const silverdaw::ProjectState::WarpClipInfo& info)
            {
                if (info.clipId == clipId)
                {
                    SampleWarpOptions opts;
                    opts.enabled = info.warpEnabled;
                    opts.mode = info.warpMode;
                    opts.tempoRatio = info.tempoRatioPinned ? info.tempoRatio : 1.0;
                    if (info.warpEnabled && !info.tempoRatioPinned)
                    {
                        const auto sourceBpm = projectState.getLibraryItemBpm(info.libraryItemId);
                        const auto projectBpm = projectState.getBpm();
                        if (sourceBpm > 0.0 && projectBpm > 0.0) opts.tempoRatio = projectBpm / sourceBpm;
                    }
                    opts.semitones = info.semitones;
                    opts.cents = info.cents;
                    sampleWarp = opts;
                }
            });
        const juce::String libraryItemId = projectState.getClipLibraryItemId(clipId);
        auto sourcePath = projectState.getLibraryItemPlaybackPath(libraryItemId);
        if (sourcePath.isEmpty()) sourcePath = projectState.getClipFilePath(clipId);
        saveWindowAsSampleAsync(clipId, {}, itemId, sampleName, outputDir, juce::File(sourcePath),
                                projectState.getClipInMs(clipId), projectState.getClipDurationMs(clipId),
                                engine, projectState, peakPool, cache, bridge, sampleWarp);
    }
    else if (type == "LIBRARY_ITEM_SAVE_AS_SAMPLE")
    {
        const juce::String libraryItemId = tryGetRequiredString(payload, "libraryItemId").value_or(juce::String{});
        const juce::String itemId = tryGetRequiredString(payload, "itemId").value_or(juce::String{});
        const juce::String sampleName = tryGetRequiredString(payload, "sampleName").value_or(juce::String{});
        const juce::String outputDir = tryGetRequiredString(payload, "outputDir").value_or(juce::String{});
        if (libraryItemId.isEmpty() || itemId.isEmpty() || outputDir.isEmpty()) return;
        juce::var found;
        const auto library = projectState.libraryAsJson();
        if (auto* arr = library.getArray())
        {
            for (const auto& v : *arr)
            {
                if (v.getProperty("id", {}).toString() == libraryItemId)
                {
                    found = v;
                    break;
                }
            }
        }
        if (!found.isObject()) return;
        const juce::String sourceItemId = found.getProperty("sourceItemId", juce::var()).toString();
        const double sourceInMs = static_cast<double>(found.getProperty("sourceInMs", 0.0));
        const double sourceDurationMs = static_cast<double>(found.getProperty("sourceDurationMs", found.getProperty("durationMs", 0.0)));
        auto sourcePath = projectState.getLibraryItemPlaybackPath(sourceItemId);
        if (sourcePath.isEmpty()) sourcePath = projectState.getLibraryItemFilePath(sourceItemId);
        if (sourcePath.isEmpty()) sourcePath = found.getProperty("filePath", juce::var()).toString();
        std::optional<SampleWarpOptions> sampleWarp;
        if (static_cast<bool>(found.getProperty("warpEnabled", false)))
        {
            SampleWarpOptions opts;
            opts.enabled = true;
            opts.mode = found.getProperty("warpMode", "rhythmic").toString();
            opts.tempoRatio = 1.0;
            if (found.hasProperty("tempoRatio"))
            {
                opts.tempoRatio = static_cast<double>(found.getProperty("tempoRatio", 1.0));
            }
            else
            {
                const auto sourceBpm = projectState.getLibraryItemBpm(sourceItemId);
                const auto projectBpm = projectState.getBpm();
                if (sourceBpm > 0.0 && projectBpm > 0.0) opts.tempoRatio = projectBpm / sourceBpm;
            }
            opts.semitones = static_cast<double>(found.getProperty("semitones", 0.0));
            opts.cents = static_cast<double>(found.getProperty("cents", 0.0));
            sampleWarp = opts;
        }
        saveWindowAsSampleAsync({}, libraryItemId, itemId, sampleName, outputDir, juce::File(sourcePath),
                                sourceInMs, sourceDurationMs, engine, projectState, peakPool, cache, bridge, sampleWarp);
    }
    else if (type == "LIBRARY_ADD")
    {
        silverdaw::handleLibraryAdd(payload, engine, projectState, bridge, peakPool, decodedCache);
    }
    else if (type == "LIBRARY_REMOVE")
    {
        silverdaw::handleLibraryRemove(payload, projectState);
    }
    else if (type == "LIBRARY_REANALYSE")
    {
        silverdaw::handleLibraryReanalyse(payload, engine, projectState, bridge, peakPool, decodedCache);
    }
    else if (type == "LIBRARY_ITEM_SET_SAMPLE_MODE")
    {
        silverdaw::handleLibraryItemSetSampleMode(payload, projectState);
    }
    else if (type == "TRANSPORT_PLAY")
    {
        silverdaw::handleTransportPlay(engine, g_mixdownBusy.load());
    }
    else if (type == "TRANSPORT_PAUSE")
    {
        silverdaw::handleTransportPause(engine);
    }
    else if (type == "TRANSPORT_STOP")
    {
        silverdaw::handleTransportStop(engine, projectState);
    }
    else if (type == "TRANSPORT_SEEK")
    {
        silverdaw::handleTransportSeek(payload, engine, projectState);
    }
    else if (type == "PREVIEW_LOAD")
    {
        silverdaw::handlePreviewLoad(payload, engine, projectState, bridge, decodedCache);
    }
    else if (type == "PREVIEW_UNLOAD")
    {
        silverdaw::handlePreviewUnload(engine, bridge);
    }
    else if (type == "PREVIEW_PLAY")
    {
        silverdaw::handlePreviewPlay(engine, bridge);
    }
    else if (type == "PREVIEW_PAUSE")
    {
        silverdaw::handlePreviewPause(engine, bridge);
    }
    else if (type == "PREVIEW_STOP")
    {
        silverdaw::handlePreviewStop(engine, bridge);
    }
    else if (type == "PREVIEW_SEEK")
    {
        silverdaw::handlePreviewSeek(payload, engine);
    }
    else if (type == "PREVIEW_SET_WARP")
    {
        silverdaw::handlePreviewSetWarp(payload, engine);
    }
    else if (type == "PREVIEW_SET_ENVELOPE")
    {
        silverdaw::handlePreviewSetEnvelope(payload, engine);
    }
    else if (type == "TRACK_ADD")
    {
        silverdaw::log::info("bridge", "recv TRACK_ADD trackId=" + payload.getProperty("trackId", "").toString());
        silverdaw::handleTrackAdd(payload, projectState, bridge);
    }
    else if (type == "TRACK_REMOVE")
    {
        silverdaw::log::info("bridge", "recv TRACK_REMOVE trackId=" + payload.getProperty("trackId", "").toString());
        silverdaw::handleTrackRemove(payload, engine, projectState, bridge);
    }
    else if (type == "TRACK_RENAME")
    {
        silverdaw::log::info("bridge", "recv TRACK_RENAME trackId=" + payload.getProperty("trackId", "").toString());
        silverdaw::handleTrackRename(payload, projectState);
    }
    else if (type == "TRACK_GAIN")
    {
        silverdaw::log::debug("bridge", "recv TRACK_GAIN trackId=" + payload.getProperty("trackId", "").toString() +
                                            " gain=" + payload.getProperty("gain", "").toString());
        silverdaw::handleTrackGain(payload, engine, projectState, bridge);
    }
    else if (type == "TRACK_MUTE")
    {
        silverdaw::log::info("bridge", "recv TRACK_MUTE trackId=" + payload.getProperty("trackId", "").toString() +
                                            " muted=" + payload.getProperty("muted", "").toString());
        silverdaw::handleTrackMute(payload, engine, projectState, bridge);
    }
    else if (type == "TRACK_SOLO")
    {
        silverdaw::log::info("bridge", "recv TRACK_SOLO trackId=" + payload.getProperty("trackId", "").toString() +
                                            " soloed=" + payload.getProperty("soloed", "").toString());
        silverdaw::handleTrackSolo(payload, engine, projectState, bridge);
    }
    else if (type == "TRACK_SET_HEIGHT")
    {
        const auto trackId = tryGetRequiredString(payload, "trackId").value_or(juce::String{});
        const auto heightVar = tryGetNumber(payload, "heightPx");
        silverdaw::log::debug("bridge", "recv TRACK_SET_HEIGHT trackId=" + trackId +
                                            " heightPx=" + payload.getProperty("heightPx", "").toString());
        if (trackId.isNotEmpty() && heightVar.has_value())
        {
            projectState.setTrackHeightPx(trackId, *heightVar);
        }
    }
    else if (type == "TRACK_REORDER")
    {
        const auto trackId = tryGetRequiredString(payload, "trackId").value_or(juce::String{});
        const auto idxVar = tryGetNumber(payload, "newIndex");
        silverdaw::log::info("bridge", "recv TRACK_REORDER trackId=" + trackId +
                                           " newIndex=" + payload.getProperty("newIndex", "").toString());
        if (trackId.isNotEmpty() && idxVar.has_value())
        {
            projectState.moveTrack(trackId, static_cast<int>(*idxVar));
        }
    }
    else if (type == "TRACK_SET_SENDS")
    {
        silverdaw::log::debug("bridge",
                              "recv TRACK_SET_SENDS trackId=" +
                                  payload.getProperty("trackId", "").toString() +
                                  " rev=" + payload.getProperty("reverbSend", "").toString() +
                                  " dly=" + payload.getProperty("delaySend", "").toString());
        silverdaw::handleTrackSetSends(payload, engine, projectState, bridge);
    }
    else if (type == "TRACK_SET_TONE")
    {
        silverdaw::log::debug("bridge", "recv TRACK_SET_TONE trackId=" +
                                            payload.getProperty("trackId", "").toString());
        silverdaw::handleTrackSetTone(payload, engine, projectState, bridge);
    }
    else if (type == "TRACK_SET_LEVELER")
    {
        silverdaw::log::debug("bridge", "recv TRACK_SET_LEVELER trackId=" +
                                            payload.getProperty("trackId", "").toString() +
                                            " amount=" + payload.getProperty("amount", "").toString());
        silverdaw::handleTrackSetLeveler(payload, engine, projectState, bridge);
    }
    else if (type == "TRACK_SET_PAN")
    {
        silverdaw::log::debug("bridge", "recv TRACK_SET_PAN trackId=" +
                                            payload.getProperty("trackId", "").toString() +
                                            " pan=" + payload.getProperty("pan", "").toString());
        silverdaw::handleTrackSetPan(payload, engine, projectState, bridge);
    }
    else if (type == "CLIP_SET_ENVELOPE")
    {
        silverdaw::log::debug("bridge", "recv CLIP_SET_ENVELOPE clipId=" +
                                            payload.getProperty("clipId", "").toString());
        silverdaw::handleClipSetEnvelope(payload, engine, projectState, bridge);
    }
    else if (type == "PROJECT_SET_REVERB")
    {
        silverdaw::log::debug("bridge", "recv PROJECT_SET_REVERB");
        silverdaw::handleProjectSetReverb(payload, engine, projectState, bridge);
    }
    else if (type == "PROJECT_SET_DELAY")
    {
        silverdaw::log::debug("bridge", "recv PROJECT_SET_DELAY");
        silverdaw::handleProjectSetDelay(payload, engine, projectState, bridge);
    }
    else if (type == "WAVEFORM_REQUEST")
    {
        silverdaw::log::debug("bridge", "recv WAVEFORM_REQUEST clipId=" + payload.getProperty("clipId", "").toString());
        handleWaveformRequest(payload, engine, projectState, bridge, peakPool, cache);
    }
    else if (type == "CLIP_EDITOR_PEAKS_REQUEST")
    {
        silverdaw::log::debug("bridge",
                              "recv CLIP_EDITOR_PEAKS_REQUEST libId=" +
                                  payload.getProperty("libraryItemId", "").toString() +
                                  " ppS=" + payload.getProperty("peaksPerSecond", "").toString());
        handleClipEditorPeaksRequest(payload, engine, projectState, bridge, peakPool, cache);
    }
    else if (type == "PROJECT_NEW")
    {
        silverdaw::log::info("bridge", "recv PROJECT_NEW");
        handleProjectNew(engine, projectState, bridge, session);
    }
    else if (type == "PROJECT_SAVE")
    {
        silverdaw::log::info("bridge", "recv PROJECT_SAVE");
        handleProjectSave(payload, engine, projectState, bridge, session, /*isSaveAs*/ false);
    }
    else if (type == "PROJECT_SAVE_AS")
    {
        silverdaw::log::info("bridge", "recv PROJECT_SAVE_AS path=" + payload.getProperty("filePath", "").toString());
        handleProjectSave(payload, engine, projectState, bridge, session, /*isSaveAs*/ true);
    }
    else if (type == "PROJECT_SAVE_VIEW_STATE")
    {
        silverdaw::log::info("bridge", "recv PROJECT_SAVE_VIEW_STATE");
        handleProjectSaveViewState(payload, engine, projectState, bridge, session);
    }
    else if (type == "PROJECT_LOAD")
    {
        silverdaw::log::info("bridge", "recv PROJECT_LOAD path=" + payload.getProperty("filePath", "").toString());
        handleProjectLoad(payload, engine, projectState, bridge, session, peakPool, decodedCache);
    }
    else if (type == "PROJECT_LOAD_RECOVERY")
    {
        silverdaw::log::info("bridge", "recv PROJECT_LOAD_RECOVERY autosavePath=" +
                                           payload.getProperty("autosavePath", "").toString());
        handleProjectLoadRecovery(payload, engine, projectState, bridge, session, peakPool, decodedCache);
    }
    else if (type == "PROJECT_AUTOSAVE")
    {
        silverdaw::log::debug("bridge", "recv PROJECT_AUTOSAVE path=" +
                                            payload.getProperty("filePath", "").toString());
        handleProjectAutosave(payload, engine, projectState, bridge);
    }
    else if (type == "PROJECT_RENAME")
    {
        silverdaw::log::info("bridge", "recv PROJECT_RENAME name=" + payload.getProperty("name", "").toString());
        handleProjectRename(payload, projectState, bridge);
    }
    else if (type == "PROJECT_SET_VIEW")
    {
        // View preferences (zoom + scroll position) travel with the
        // project so opening a saved file restores the exact view the
        // user had when they saved. Suppressed from the dirty-flag
        // listener inside the setters so view changes don't prompt an
        // unsaved-changes dialog.
        const auto pxVar = payload.getProperty("pxPerSecond", juce::var());
        if (pxVar.isDouble() || pxVar.isInt() || pxVar.isInt64())
        {
            const double px = static_cast<double>(pxVar);
            if (px > 0.0)
            {
                projectState.setViewPxPerSecond(px);
            }
        }
        const auto sxVar = payload.getProperty("scrollX", juce::var());
        if (sxVar.isDouble() || sxVar.isInt() || sxVar.isInt64())
        {
            projectState.setViewScrollX(juce::jmax(0.0, static_cast<double>(sxVar)));
        }
        // Selected track + Track-FX-panel-open flag travel with the
        // project too, so reopening restores which track's effects the
        // user was editing. Both are non-dirty view state. Guard on the
        // property being present: scroll/zoom-only pushes omit these and
        // must not be treated as "clear the selection".
        if (payload.hasProperty("selectedTrackId"))
        {
            const auto selVar = payload.getProperty("selectedTrackId", juce::var());
            projectState.setViewSelectedTrack(selVar.isString() ? selVar.toString() : juce::String{});
        }
        const auto fxVar = payload.getProperty("fxPanelOpen", juce::var());
        if (fxVar.isBool())
        {
            projectState.setViewFxPanelOpen(static_cast<bool>(fxVar));
        }
    }
    else if (type == "PROJECT_SET_BPM")
    {
        // Tempo edits flip the dirty flag — this is a meaningful change
        // to the project that the user should be prompted to save.
        const auto bpmVar = payload.getProperty("bpm", juce::var());
        if (bpmVar.isDouble() || bpmVar.isInt() || bpmVar.isInt64())
        {
            const double bpm = static_cast<double>(bpmVar);
            if (bpm > 0.0)
            {
                projectState.setBpm(bpm);
                // Live re-warp: every warped clip with a derived (not
                // pinned) tempo ratio re-stretches to match the new
                // project BPM. Clips with an explicit `tempoRatio`
                // override keep their pinned value — the user opted
                // out of project-BPM tracking on those.
                projectState.forEachWarpClip(
                    [&](const silverdaw::ProjectState::WarpClipInfo& info)
                    {
                        if (!info.warpEnabled || info.tempoRatioPinned) return;
                        const double sourceBpm = projectState.getLibraryItemBpm(info.libraryItemId);
                        if (sourceBpm <= 0.0) return;
                        const double ratio = bpm / sourceBpm;
                        engine.setClipWarp(info.clipId, std::nullopt, std::nullopt,
                                           ratio, std::nullopt, std::nullopt);
                        auto appliedPayload = silverdaw::buildClipWarpAppliedPayload(projectState, info.clipId);
                        bridge.broadcast("CLIP_WARP_APPLIED", juce::var(appliedPayload.release()));
                    });
            }
        }
    }
    else if (type == "PROJECT_SET_LENGTH")
    {
        // Length edits flip the dirty flag (same rationale as BPM).
        const auto lenVar = payload.getProperty("lengthMs", juce::var());
        if (lenVar.isDouble() || lenVar.isInt() || lenVar.isInt64())
        {
            const double lenMs = static_cast<double>(lenVar);
            if (lenMs >= 0.0)
            {
                projectState.setProjectLengthMs(lenMs);
            }
        }
    }
    else if (type == "PROJECT_SET_AUDIO_OUTPUT")
    {
        // Per-project preferred audio output. Both fields are nullable —
        // the renderer passes `null` to clear the preference. We accept
        // either an explicit empty string or a non-string (e.g. JSON
        // null) as "clear", and validate strings strictly otherwise so
        // a malformed envelope can't smuggle a debug-stringified value
        // into the persisted project file.
        const auto extract = [](const juce::var& payloadIn, const char* key) -> juce::String {
            const juce::var v = payloadIn.getProperty(key, juce::var());
            if (v.isString()) return v.toString();
            return {};
        };
        const auto typeName = extract(payload, "typeName");
        const auto deviceName = extract(payload, "deviceName");
        projectState.setAudioOutput(typeName, deviceName);
    }
    else if (type == "PROJECT_SET_TARGET_SAMPLE_RATE")
    {
        // Project-wide target sample rate. Strict whitelist of accepted
        // rates so a malformed envelope can't park a project at an
        // unsupported rate that the import / cache code paths don't
        // handle. Pass 0 to clear (renderer-scope default applies on
        // next load).
        const auto rateOpt = tryGetNumber(payload, "sampleRate");
        if (rateOpt.has_value())
        {
            const int requested = static_cast<int>(*rateOpt);
            if (requested == 0 || silverdaw::isSupportedSampleRate(requested))
            {
                projectState.setTargetSampleRate(requested);
            }
            else
            {
                silverdaw::log::warn(
                    "bridge",
                    "PROJECT_SET_TARGET_SAMPLE_RATE rejected (unsupported rate "
                        + juce::String(requested) + ")");
            }
        }
    }
    else if (type == "PROJECT_SET_EXPORT_SETTINGS")
    {
        // Opaque JSON blob describing the last-used export-dialog
        // settings (format, bit depth, tail seconds, loudness preset,
        // file-level tags, …). Renderer owns the schema — we just
        // round-trip the string. Pass an empty string to clear.
        const auto json = tryGetRequiredString(payload, "json").value_or(juce::String{});
        if (json.length() > 64 * 1024)
        {
            silverdaw::log::warn(
                "bridge",
                "PROJECT_SET_EXPORT_SETTINGS rejected (json > 64 KB; got "
                    + juce::String(json.length()) + ")");
        }
        else
        {
            projectState.setExportSettingsJson(json);
        }
    }
    else if (type == "PROJECT_SET_MASTER_VOLUME")
    {
        // Master output gain in [0, 1]. Persisted on the ValueTree
        // (undoable, marks dirty) AND pushed live to the AudioEngine
        // so playback changes audibly during a slider drag. Mixdown
        // reads the same value from `snapshotProjectForMixdown`, so
        // the exported file matches what the user hears.
        const auto gainOpt = tryGetNumber(payload, "gain");
        if (gainOpt.has_value())
        {
            const float clamped = juce::jlimit(0.0F, 1.0F, static_cast<float>(*gainOpt));
            projectState.setMasterVolume(clamped);
            engine.setMasterGain(clamped);
        }
    }
    else if (type == "PROJECT_MARKER_ADD")
    {
        silverdaw::applyMarkerAdd(payload, projectState);
    }
    else if (type == "PROJECT_MARKER_MOVE")
    {
        silverdaw::applyMarkerMove(payload, projectState);
    }
    else if (type == "PROJECT_MARKER_REMOVE")
    {
        silverdaw::applyMarkerRemove(payload, projectState);
    }
    else if (type == "AUDIO_DEVICES_REQUEST")
    {
        silverdaw::log::debug("bridge", "recv AUDIO_DEVICES_REQUEST refresh=" +
                                            payload.getProperty("refresh", "false").toString());
        silverdaw::handleAudioDevicesRequest(payload, engine, bridge);
    }
    else if (type == "AUDIO_DEVICE_SELECT")
    {
        silverdaw::log::info("bridge", "recv AUDIO_DEVICE_SELECT type=" +
                                           payload.getProperty("typeName", "").toString() + " name=" +
                                           payload.getProperty("deviceName", "").toString());
        silverdaw::handleAudioDeviceSelect(payload, engine, bridge);
    }
    else if (type == "AUDIO_FILE_PROBE")
    {
        // Synchronous-ish file-rate probe used by the renderer's import
        // flow to decide whether to prompt about a sample-rate
        // mismatch. Opens the file via the existing AudioFormatManager,
        // reads the header (sample rate / channel count / total length),
        // acks via `AUDIO_FILE_PROBED`. `requestId` round-trips so
        // concurrent probes from a batched import don't collide.
        const auto requestId = tryGetRequiredString(payload, "requestId").value_or(juce::String{});
        const auto filePath = tryGetRequiredString(payload, "filePath").value_or(juce::String{});
        if (requestId.isEmpty() || filePath.isEmpty())
        {
            silverdaw::log::warn("bridge", "AUDIO_FILE_PROBE missing requestId/filePath");
        }
        else
        {
            silverdaw::log::debug("bridge", "recv AUDIO_FILE_PROBE id=" + requestId + " path=" + filePath);
            // Heavy work (reader construction; on Windows the JUCE
            // codec call can take a few ms for compressed formats) is
            // dispatched onto the existing peak-pool so the message
            // thread keeps draining 60 Hz transport ticks.
            peakPool.addJob([requestId, filePath, &engine, &bridge]() {
                const juce::File file(filePath);
                std::unique_ptr<juce::AudioFormatReader> reader(
                    engine.getFormatManager().createReaderFor(file));
                juce::MessageManager::callAsync([requestId, filePath, &bridge,
                                                 reader = std::shared_ptr<juce::AudioFormatReader>(std::move(reader))]() {
                    auto* obj = new juce::DynamicObject();
                    obj->setProperty("requestId", requestId);
                    obj->setProperty("filePath", filePath);
                    if (reader && reader->sampleRate > 0.0 && reader->lengthInSamples > 0)
                    {
                        obj->setProperty("ok", true);
                        obj->setProperty("sampleRate", static_cast<int>(reader->sampleRate));
                        obj->setProperty("channelCount", static_cast<int>(reader->numChannels));
                        obj->setProperty(
                            "durationMs",
                            (static_cast<double>(reader->lengthInSamples) / reader->sampleRate) * 1000.0);
                        silverdaw::log::info(
                            "bridge",
                            "probe ok id=" + requestId + " path=" + filePath
                                + " sampleRate=" + juce::String(static_cast<int>(reader->sampleRate))
                                + "Hz ch=" + juce::String(static_cast<int>(reader->numChannels))
                                + " lengthSamples=" + juce::String(reader->lengthInSamples));
                    }
                    else
                    {
                        obj->setProperty("ok", false);
                        obj->setProperty("error",
                                         juce::String("could not decode header for ") + filePath);
                        silverdaw::log::warn(
                            "bridge",
                            "probe fail id=" + requestId + " path=" + filePath
                                + " (reader=" + juce::String(reader ? "ok" : "null") + ")");
                    }
                    bridge.broadcast("AUDIO_FILE_PROBED", juce::var(obj));
                });
            });
        }
    }
    else if (type == "MIXDOWN_START")
    {
        // Render a project mixdown offline. Heavy work runs on the
        // peakPool; results stream back via MIXDOWN_PROGRESS /
        // MIXDOWN_DONE / MIXDOWN_FAILED. Idempotent under double-
        // click — if a render is already in flight, reject the new
        // request with an `invalid` failure rather than starting a
        // second one.
        if (g_mixdownBusy.load())
        {
            auto* obj = new juce::DynamicObject();
            obj->setProperty("code", juce::String("invalid"));
            obj->setProperty("error", juce::String("A mixdown is already in progress."));
            bridge.broadcast("MIXDOWN_FAILED", juce::var(obj));
            return;
        }
        // Stop transport (and don't fight an existing play state) so
        // the live audio device isn't producing sound during the
        // offline render. The TRANSPORT_PLAY gate above keeps it stopped.
        engine.pause();

        const auto outputPath = tryGetRequiredString(payload, "outputPath").value_or(juce::String{});
        const int outputSampleRate = static_cast<int>(payload.getProperty("sampleRate", 44100));
        const auto formatStr = tryGetRequiredString(payload, "format").value_or(juce::String("wav"));
        const auto lengthMode = tryGetRequiredString(payload, "lengthMode").value_or(juce::String("trim-to-last-clip"));
        const double lengthMsHint = static_cast<double>(payload.getProperty("lengthMs", 0.0));
        const int bitrateKbps = static_cast<int>(payload.getProperty("bitrateKbps", 192));
        // Phase A export fields. All optional with safe defaults so
        // older renderer builds keep working. Validated below before
        // we hand them to the engine.
        const int bitDepthRaw = static_cast<int>(payload.getProperty("bitDepth", 16));
        const double tailSecondsRaw = static_cast<double>(payload.getProperty("tailSeconds", 0.0));
        const bool ditherRaw = static_cast<bool>(payload.getProperty("dither", true));

        silverdaw::log::info(
            "mixdown",
            "MIXDOWN_START path=" + outputPath + " sr=" + juce::String(outputSampleRate) +
                " format=" + formatStr + " lengthMode=" + lengthMode +
                " lengthMsHint=" + juce::String(lengthMsHint, 1) +
                " bitDepth=" + juce::String(bitDepthRaw) +
                " tailSeconds=" + juce::String(tailSecondsRaw, 3) +
                " dither=" + (ditherRaw ? "true" : "false"));

        if (outputPath.isEmpty())
        {
            auto* obj = new juce::DynamicObject();
            obj->setProperty("code", juce::String("invalid"));
            obj->setProperty("error", juce::String("MIXDOWN_START requires outputPath."));
            bridge.broadcast("MIXDOWN_FAILED", juce::var(obj));
            return;
        }

        // Snapshot the project on the message thread before the
        // worker dispatches — see rubber-duck finding A.
        auto snapshot = silverdaw::snapshotProjectForMixdown(projectState);
        // Re-resolve each clip's source path through the SAME helper
        // the live engine uses for CLIP_ADD. Without this, mixdown
        // can open the original MP3/WMA for a clip whose stored
        // playbackFilePath is empty/stale while live plays the
        // decoded WAV cache — yielding selective warp failures and
        // amplitude drift when the two readers' sample rates or
        // padding/encoder-delay differ. See rubber-duck H2.
        for (auto& trackSnap : snapshot.tracks)
        {
            for (auto& clipSnap : trackSnap.clips)
            {
                const auto rawSourcePath =
                    projectState.getLibraryItemFilePath(clipSnap.libraryItemId);
                const auto resolvedPath =
                    silverdaw::resolveEnginePlaybackPath(rawSourcePath, projectState, decodedCache);
                const auto previousPath = clipSnap.filePath;
                if (resolvedPath.isNotEmpty()) clipSnap.filePath = resolvedPath;
                silverdaw::log::info(
                    "mixdown",
                    "snapshot path resolve clip=" + clipSnap.id +
                        " libraryItemId=" + clipSnap.libraryItemId +
                        " rawSource=" + rawSourcePath +
                        " storedPlayback=" + previousPath +
                        " resolved=" + clipSnap.filePath +
                        " changed=" +
                            (previousPath != clipSnap.filePath
                                 ? juce::String("true")
                                 : juce::String("false")));
            }
        }
        if (snapshot.tracks.empty())
        {
            auto* obj = new juce::DynamicObject();
            obj->setProperty("code", juce::String("invalid"));
            obj->setProperty("error", juce::String("Project has no clips to mix down."));
            bridge.broadcast("MIXDOWN_FAILED", juce::var(obj));
            return;
        }

        // Align mixdown's internal "project rate" with the live device
        // rate. The per-clip JUCE chain in MixdownEngine is identical to
        // live's (AudioFormatReaderSource → OffsetSource → AudioTransport
        // Source). The transport's internal ResamplingAudioSource uses
        // linear interpolation, so running mixdown at a different rate
        // than live changes the source→render resample ratio and can
        // perceptibly attenuate high frequencies vs live (rubber-duck
        // pair #2: top remaining cause of "export quieter than live").
        // We then do the projectRate→outputRate step through the
        // FinalResampler (libsamplerate SINC), which is higher quality
        // than the transport's linear interpolator.
        {
            const auto deviceSnap = engine.getAudioDevicesSnapshot();
            const int previousRate = snapshot.projectSampleRate;
            if (deviceSnap.currentSampleRate > 0.0)
            {
                snapshot.projectSampleRate =
                    static_cast<int>(deviceSnap.currentSampleRate);
            }
            silverdaw::log::info(
                "mixdown",
                "projectSampleRate aligned previous=" + juce::String(previousRate) +
                    " deviceRate=" + juce::String(deviceSnap.currentSampleRate, 1) +
                    " effective=" + juce::String(snapshot.projectSampleRate) +
                    " outputRate=" + juce::String(outputSampleRate));
        }

        silverdaw::MixdownOptions options;
        options.outputFile = juce::File(outputPath);
        options.outputSampleRate = outputSampleRate;
        // Map and validate format. Anything unrecognised falls back to
        // WAV so a frontend typo can't produce a binary mismatch.
        if (formatStr == "mp3")
            options.format = silverdaw::MixdownOptions::Format::Mp3;
        else if (formatStr == "flac")
            options.format = silverdaw::MixdownOptions::Format::Flac;
        else if (formatStr == "aiff")
            options.format = silverdaw::MixdownOptions::Format::Aiff;
        else
            options.format = silverdaw::MixdownOptions::Format::Wav;

        // Per-format bit-depth validation. The renderer's UI restricts
        // choices but we still validate here — never trust the
        // frontend. Reject unsupported combinations rather than
        // silently quantising.
        const auto rejectInvalid = [&](const juce::String& msg)
        {
            auto* obj = new juce::DynamicObject();
            obj->setProperty("code", juce::String("invalid"));
            obj->setProperty("error", msg);
            bridge.broadcast("MIXDOWN_FAILED", juce::var(obj));
        };
        switch (options.format)
        {
            case silverdaw::MixdownOptions::Format::Wav:
                if (bitDepthRaw != 16 && bitDepthRaw != 24 && bitDepthRaw != 32)
                {
                    rejectInvalid("WAV export supports 16, 24 or 32-bit only (got " +
                                  juce::String(bitDepthRaw) + ").");
                    return;
                }
                break;
            case silverdaw::MixdownOptions::Format::Flac:
                if (bitDepthRaw != 16 && bitDepthRaw != 24)
                {
                    rejectInvalid("FLAC export supports 16 or 24-bit only (got " +
                                  juce::String(bitDepthRaw) + ").");
                    return;
                }
                break;
            case silverdaw::MixdownOptions::Format::Aiff:
                if (bitDepthRaw != 16 && bitDepthRaw != 24)
                {
                    rejectInvalid("AIFF export supports 16 or 24-bit only (got " +
                                  juce::String(bitDepthRaw) + ").");
                    return;
                }
                break;
            case silverdaw::MixdownOptions::Format::Mp3:
                // MP3 ignores bit-depth; nothing to validate here.
                break;
        }
        options.bitDepth = bitDepthRaw;
        // Tail seconds: finite, non-negative, capped at 60s. The
        // engine also clamps but rejecting at the boundary gives a
        // clearer error than silent clamping.
        if (! std::isfinite(tailSecondsRaw) || tailSecondsRaw < 0.0 || tailSecondsRaw > 60.0)
        {
            rejectInvalid("tailSeconds must be in [0, 60] (got " +
                          juce::String(tailSecondsRaw, 3) + ").");
            return;
        }
        options.tailSeconds = tailSecondsRaw;
        options.dither = ditherRaw;
        options.bitrateKbps = bitrateKbps;

        // Loudness block: optional. Accepts `{ mode, targetLufs?,
        // ceilingDbtp? }` where mode ∈ {off, analyze, normalize}.
        // Defaults: mode=off, targetLufs=-14, ceilingDbtp=-1.
        // Normalize requires targetLufs and ceilingDbtp in the
        // valid ranges; analyze ignores those values.
        const auto loudnessVar = payload.getProperty("loudness", juce::var());
        if (loudnessVar.isObject())
        {
            const auto modeStr = loudnessVar.getProperty("mode", juce::var("off")).toString();
            silverdaw::MixdownOptions::LoudnessMode lm =
                silverdaw::MixdownOptions::LoudnessMode::Off;
            if      (modeStr == "off")       lm = silverdaw::MixdownOptions::LoudnessMode::Off;
            else if (modeStr == "analyze")   lm = silverdaw::MixdownOptions::LoudnessMode::AnalyzeOnly;
            else if (modeStr == "normalize") lm = silverdaw::MixdownOptions::LoudnessMode::Normalize;
            else
            {
                rejectInvalid("loudness.mode must be one of off, analyze, normalize (got \"" + modeStr + "\").");
                return;
            }
            options.loudnessMode = lm;

            if (lm == silverdaw::MixdownOptions::LoudnessMode::Normalize)
            {
                if (! loudnessVar.hasProperty("targetLufs"))
                {
                    rejectInvalid("loudness.targetLufs is required when loudness.mode == normalize.");
                    return;
                }
            }
            const double tgt = static_cast<double>(
                loudnessVar.getProperty("targetLufs", -14.0));
            const double ceil = static_cast<double>(
                loudnessVar.getProperty("ceilingDbtp", -1.0));
            if (! std::isfinite(tgt) || tgt < -30.0 || tgt > -6.0)
            {
                rejectInvalid("loudness.targetLufs must be in [-30, -6] (got " +
                              juce::String(tgt, 2) + ").");
                return;
            }
            if (! std::isfinite(ceil) || ceil < -9.0 || ceil > 0.0)
            {
                rejectInvalid("loudness.ceilingDbtp must be in [-9, 0] (got " +
                              juce::String(ceil, 2) + ").");
                return;
            }
            options.targetLufs = tgt;
            options.ceilingDbtp = ceil;
            if (lm != silverdaw::MixdownOptions::LoudnessMode::Off
                && options.outputSampleRate != 44100
                && options.outputSampleRate != 48000)
            {
                rejectInvalid("Loudness analysis requires 44.1 or 48 kHz output (got " +
                              juce::String(options.outputSampleRate) + ").");
                return;
            }
        }
        if (lengthMode == "trim-to-last-clip")
        {
            options.lengthMs = silverdaw::computeLastClipEndMs(snapshot);
        }
        else
        {
            options.lengthMs = lengthMsHint > 0.0
                                   ? lengthMsHint
                                   : projectState.getProjectLengthMs();
        }
        // File-level metadata (format-agnostic; mapped per-format in the engine).
        const auto md = payload.getProperty("metadata", juce::var());
        if (md.isObject())
        {
            options.metadata.title   = md.getProperty("title",   "").toString();
            options.metadata.artist  = md.getProperty("artist",  "").toString();
            options.metadata.album   = md.getProperty("album",   "").toString();
            options.metadata.year    = md.getProperty("year",    "").toString();
            options.metadata.genre   = md.getProperty("genre",   "").toString();
            options.metadata.comment = md.getProperty("comment", "").toString();
        }

        silverdaw::renderMixdownAsync(std::move(snapshot), std::move(options),
                                      peakPool, bridge,
                                      g_mixdownCancel, g_mixdownBusy);
    }
    else if (type == "MIXDOWN_CANCEL")
    {
        if (!g_mixdownBusy.load())
        {
            silverdaw::log::info("bridge", "MIXDOWN_CANCEL ignored — no render in progress");
            return;
        }
        silverdaw::log::info("bridge", "recv MIXDOWN_CANCEL");
        g_mixdownCancel.store(true);
    }
    else if (type == "EDIT_UNDO")
    {
        silverdaw::log::info("bridge", "recv EDIT_UNDO");
        handleEditUndo(engine, projectState, bridge, session, peakPool, decodedCache);
    }
    else if (type == "EDIT_REDO")
    {
        silverdaw::log::info("bridge", "recv EDIT_REDO");
        handleEditRedo(engine, projectState, bridge, session, peakPool, decodedCache);
    }
    else if (type == "TRANSITION_CREATE")
    {
        silverdaw::log::info("bridge", "recv TRANSITION_CREATE track=" +
                                           payload.getProperty("trackId", "").toString());
        silverdaw::applyTransitionCreate(payload, projectState);
        finishTransitionEdit(engine, projectState, bridge, session);
    }
    else if (type == "TRANSITION_DELETE")
    {
        silverdaw::log::info("bridge", "recv TRANSITION_DELETE id=" +
                                           payload.getProperty("transitionId", "").toString());
        silverdaw::applyTransitionDelete(payload, projectState);
        finishTransitionEdit(engine, projectState, bridge, session);
    }
    else if (type == "TRANSITION_SET_RECIPE")
    {
        silverdaw::log::info("bridge", "recv TRANSITION_SET_RECIPE id=" +
                                           payload.getProperty("transitionId", "").toString());
        silverdaw::applyTransitionSetRecipe(payload, projectState);
        finishTransitionEdit(engine, projectState, bridge, session);
    }
    else
    {
        silverdaw::log::warn("bridge", "unhandled message type: " + type);
    }

    // Mirror to `beginUndoTransactionIfNeeded`. Called AFTER the handler
    // has applied its mutation so the terminal `gestureEnd: true` event
    // folds into the open transaction, then clears the coalesce state
    // for the next gesture.
    endUndoTransactionIfNeeded(type, payload);

    // §12.1 — a geometry edit can break a transition's overlap. Re-derive
    // edge-fades and auto-delete invalidated transitions (joining this edit's
    // still-open undo step). No-op fast path when the project has no
    // transitions, so transition-free projects are unaffected.
    if (transitionGeometryMayHaveChanged(type))
    {
        reconcileTransitionsAfterGeometryEdit(engine, projectState, bridge, session);
    }

    // Undo-state epilogue. Any mutating envelope (or an undo/redo itself)
    // can change `canUndo` / `canRedo`. PROJECT_LOAD / PROJECT_NEW and
    // the recovery / autosave paths each clear the undo history via
    // `replaceTree`, so they fall under the mutating branch too.
    if (isUndoableEnvelopeType(type) || type == "EDIT_UNDO" || type == "EDIT_REDO" ||
        type == "PROJECT_NEW" || type == "PROJECT_LOAD" || type == "PROJECT_LOAD_RECOVERY")
    {
        broadcastEditUndoState(projectState, bridge);
    }
}

// See note on `resolveBridgePort`: argv must remain a C-style array.
// NOLINTNEXTLINE(modernize-avoid-c-arrays,hicpp-avoid-c-arrays,cppcoreguidelines-avoid-c-arrays)
int runBackend(int argc, char* argv[])
{
    // Initialise the cross-layer file logger only when Electron main
    // explicitly opts in via `SILVERDAW_LOG_DIR` (set when the user has
    // toggled "Enable Debugging" in Preferences). Without it the logger
    // stays uninitialised and every `silverdaw::log::*` call is a
    // silent no-op — so a normal-use packaged install never writes a
    // backend.log nor creates a `.logs/` directory.
    const auto logDirOverride = juce::SystemStats::getEnvironmentVariable("SILVERDAW_LOG_DIR", {});
    if (logDirOverride.isNotEmpty())
    {
        silverdaw::log::initialise(logDirOverride);
    }

    const juce::String banner = "Silverdaw Backend v1.0.0 - " + juce::SystemStats::getOperatingSystemName() + " (" +
                                juce::SystemStats::getCpuVendor() + ")";
    std::cout << banner.toStdString() << '\n';
    silverdaw::log::info("main", banner);

    const int bridgePort = resolveBridgePort(argc, argv);
    if (bridgePort < 0)
    {
        // `resolveBridgePort` already logged the reason. Print a one-line
        // hint to stderr too so a stand-alone manual run sees the failure
        // even when file logging is disabled.
        std::cerr << "[main] missing or invalid --port; expected: " << argv[0]
                  << " --port <" << kMinBridgePort << "-" << kMaxBridgePort << ">\n";
        return 2;
    }
    const juce::String bridgeToken = resolveBridgeToken(argc, argv);

    // Initialises MessageManager, JUCE singletons, etc. Required even for headless apps.
    const juce::ScopedJuceInitialiser_GUI juceInit;

    silverdaw::AudioEngine engine;
    const auto preferredAudioTypeName =
        juce::SystemStats::getEnvironmentVariable("SILVERDAW_OUTPUT_DEVICE_TYPE", {});
    const auto preferredAudioDeviceName =
        juce::SystemStats::getEnvironmentVariable("SILVERDAW_OUTPUT_DEVICE_NAME", {});
    if (const auto err = engine.initialise(preferredAudioTypeName, preferredAudioDeviceName);
        err.isNotEmpty())
    {
        silverdaw::log::error("engine", "audio device init failed: " + err);
    }

    silverdaw::ProjectState projectState;
    ProjectSession session;

    // Disk-backed cache for waveform peaks. Reused across renderer reloads
    // and even backend restarts so the same file never recomputes peaks
    // twice. See `PeaksCache.h` for the on-disk format.
    const silverdaw::PeaksCache peaksCache;

    // Disk-backed cache for fully-decoded audio. Every imported file is
    // decoded once on the worker pool and written out as a 16-bit PCM
    // WAV; the engine reads back from the cache for every subsequent
    // clip-add, which sidesteps the per-clip MP3 / WMA decode cost
    // entirely. See `DecodedCache.h`.
    const silverdaw::DecodedCache decodedCache;

    if (bridgeToken.isEmpty())
    {
        silverdaw::log::warn("bridge",
                             "WARNING: no AUTH token set (SILVERDAW_BRIDGE_TOKEN unset and --token not given); "
                             "accepting all loopback clients. DO NOT USE IN PRODUCTION.");
    }

    // Worker pool for off-message-thread work — currently only peaks
    // computation. Declared BEFORE `bridge` so the bridge's lambdas can
    // capture it by reference. Shutdown explicitly drains the pool
    // before any of the captured objects (bridge, peaksCache, engine)
    // destruct — see `peakPool.removeAllJobs(...)` below the dispatch
    // loop.
    juce::ThreadPool peakPool(kPeakWorkerCount);

    // Construct the bridge with the token, message handler, and the
    // post-AUTH initial-state hook frozen at construction time — the I/O
    // thread reads all three lock-free, so freezing them at construction
    // is what makes the read race-free by design. The handler receives
    // `BridgeServer&` from `onIncoming` so it can call `broadcast()` for
    // acks (e.g. CLIP_ADDED) without a chicken-and-egg capture problem.
    silverdaw::BridgeServer bridge(
        bridgeToken,
        [&engine, &projectState, &peakPool, &peaksCache, &decodedCache, &session](
            silverdaw::BridgeServer& self, const juce::String& type, const juce::var& payload)
        {
            // Crash firewall. This lambda runs on the JUCE message thread via
            // `callAsync`; without this guard any exception escaping a single
            // handler would unwind out of `runDispatchLoop()` → `main()` and
            // terminate the whole engine. Catch-and-continue keeps the process
            // alive and surfaces the failure as a non-fatal `ENGINE_ERROR`.
            //
            // Trade-off: a handler that threw part-way may leave an UndoManager
            // transaction open or a partially-applied edit. Full transactional
            // rollback is out of scope; the next mutating envelope opens a fresh
            // transaction, and the renderer can reload to a clean state. We
            // accept a possibly-imperfect edit over a dead engine.
            try
            {
                dispatchBridgeMessage(type, payload, engine, projectState, self, peakPool, peaksCache,
                                      decodedCache, session);
            }
            catch (const std::exception& e)
            {
                silverdaw::log::error("bridge", "handler threw for type=" + type + ": " +
                                                    juce::String(e.what()) + " — engine kept alive");
                auto* p = new juce::DynamicObject();
                p->setProperty("message", juce::String(e.what()));
                p->setProperty("context", type);
                self.broadcast("ENGINE_ERROR", juce::var(p));
            }
            catch (...)
            {
                silverdaw::log::error("bridge",
                                      "handler threw unknown exception for type=" + type + " — engine kept alive");
                auto* p = new juce::DynamicObject();
                p->setProperty("message", juce::String("Unknown engine error"));
                p->setProperty("context", type);
                self.broadcast("ENGINE_ERROR", juce::var(p));
            }
        },
        [&projectState, &session](const silverdaw::BridgeServer::SendToClient& sendToClient)
        {
            // PROJECT_STATE is sent only to the newly-authenticated client,
            // not broadcast — other clients (if any) already have their own
            // snapshot from when they connected. `reset` is omitted on the
            // connect path so the renderer treats it as additive.
            sendToClient("PROJECT_STATE", buildProjectStateEnvelope(session, projectState, false));
            // Seed the renderer's Undo / Redo menu state so the Edit menu
            // reflects the backend's UndoManager from the first paint.
            sendToClient("EDIT_UNDO_STATE", buildEditUndoStateEnvelope(projectState));
        });

    if (!bridge.start(bridgePort))
    {
        silverdaw::log::error("bridge", "failed to start; exiting");
        return 1;
    }

    // Bridge is up — wire ProjectState's dirty-flag transitions through
    // it as `PROJECT_DIRTY { dirty }` envelopes so the renderer can
    // surface the unsaved-changes indicator and gate New / Open / Quit.
    // The callback runs on whichever thread caused the transition;
    // because every ValueTree mutation we perform happens on the JUCE
    // message thread (via `dispatchBridgeMessage`), the broadcast also
    // runs there and `BridgeServer::broadcast` is internally locked.
    projectState.setDirtyChangedCallback(
        [&bridge](bool dirty)
        {
            auto* p = new juce::DynamicObject();
            p->setProperty("dirty", dirty);
            bridge.broadcast("PROJECT_DIRTY", juce::var(p));
        });

    // Rebroadcast AUDIO_DEVICES_LIST whenever JUCE's
    // `audioDeviceListChanged` fires (USB plug / unplug, Windows audio
    // reconfig, current-device removal). The engine has already
    // refreshed its cached snapshot + handled any forced fallback by
    // the time this callback runs, so the renderer's mirror updates
    // in one round-trip and the transport-bar selector reflects the
    // change without polling.
    engine.setDeviceListChangedCallback(
        [&bridge, &engine]()
        {
            silverdaw::broadcastAudioDevicesList(bridge,
                                      silverdaw::buildAudioDevicesListEnvelope(engine.getAudioDevicesSnapshot()),
                                      /*dedupe*/ true);
        });

    PlayheadEmitter emitter(engine, bridge);
    emitter.startTimerHz(kPlayheadUpdateHz);

    // Catch Ctrl+C so the dispatch loop can exit cleanly.
    std::signal(SIGINT, onSignal);
    std::signal(SIGTERM, onSignal);

    juce::MessageManager::getInstance()->runDispatchLoop();

    // Drain the peaks worker pool BEFORE any of `bridge` / `peaksCache` /
    // `engine` destruct, so an in-flight job that captures references to
    // them can't observe a half-destroyed object. `removeAllJobs(false)`
    // waits up to the timeout for running jobs to finish naturally — the
    // peaks loop is bounded by file size, ~hundreds of ms at worst.
    peakPool.removeAllJobs(false, 5000);

    emitter.stopTimer();
    bridge.stop();
    engine.shutdown();
    silverdaw::log::info("main", "shutdown complete");
    silverdaw::log::shutdown();
    std::cout << "[main] shutdown complete\n";
    return 0;
}
} // namespace

// The catch handler logs to std::cerr, which clang-tidy can't statically prove is
// non-throwing; in practice cerr won't throw without exceptions() being enabled.
// `argv` has to be a C-style array — only legal `main` signature.
// NOLINTNEXTLINE(bugprone-exception-escape,modernize-avoid-c-arrays,hicpp-avoid-c-arrays,cppcoreguidelines-avoid-c-arrays)
int main(int argc, char* argv[])
{
    try
    {
        return runBackend(argc, argv);
    }
    catch (const std::exception& e)
    {
        std::cerr << "[fatal] uncaught exception: " << e.what() << '\n';
        return 1;
    }
    catch (...)
    {
        std::cerr << "[fatal] uncaught non-standard exception\n";
        return 1;
    }
}
