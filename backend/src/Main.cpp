#include "AudioEngine.h"
#include "BpmDetector.h"
#include "BridgeServer.h"
#include "DecodedCache.h"
#include "Log.h"
#include "PeaksCache.h"
#include "ProjectFile.h"
#include "ProjectState.h"
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
constexpr int kDefaultBridgePort = 8765;
constexpr int kMinBridgePort = 1024;
constexpr int kMaxBridgePort = 65535;
std::mutex bpmJobsMutex;
std::set<juce::String> bpmJobsInFlight;
constexpr int kPlayheadUpdateHz = 60;
constexpr int kPreviewReadyDelayMs = 200;
// 4 workers keeps peak computation responsive without burning every core
// on a giant project import. Each job is disk-bound + a tight scan loop,
// so 4 is plenty even on a 16-core machine.
constexpr int kPeakWorkerCount = 4;

std::atomic<bool> g_shouldQuit{false};

void broadcastEditUndoState(silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge);

void broadcastPreviewStateIfCurrent(silverdaw::AudioEngine& engine, silverdaw::BridgeServer& bridge,
                                    const juce::String& libraryItemId, juce::int64 generation)
{
    if (engine.getPreviewGeneration() != generation) return;
    auto* stateObj = new juce::DynamicObject();
    if (libraryItemId.isNotEmpty()) stateObj->setProperty("libraryItemId", libraryItemId);
    stateObj->setProperty("isPlaying", engine.isPreviewPlaying());
    stateObj->setProperty("isLoaded", engine.isPreviewLoaded());
    stateObj->setProperty("durationMs", engine.getPreviewDurationMs());
    stateObj->setProperty("generation", generation);
    bridge.broadcast("PREVIEW_STATE", juce::var(stateObj));
}

std::unique_ptr<juce::DynamicObject> buildClipWarpAppliedPayload(
    silverdaw::ProjectState& projectState, const juce::String& clipId)
{
    auto obj = std::make_unique<juce::DynamicObject>();
    obj->setProperty("clipId", clipId);
    projectState.forEachWarpClip(
        [&](const silverdaw::ProjectState::WarpClipInfo& info)
        {
            if (info.clipId != clipId) return;
            obj->setProperty("warpEnabled", info.warpEnabled);
            obj->setProperty("warpMode", info.warpMode);
            obj->setProperty("tempoRatio", info.tempoRatioPinned ? juce::var(info.tempoRatio) : juce::var());
            obj->setProperty("semitones", info.semitones);
            obj->setProperty("cents", info.cents);
            obj->setProperty("pendingAutoWarp", info.pendingAutoWarp);
        });
    const auto timing = projectState.getClipEffectiveTiming(clipId);
    obj->setProperty("effectiveDurationMs", timing.durationMs);
    obj->setProperty("effectiveTempoRatio", timing.tempoRatio);
    obj->setProperty("effectiveWarpActive", timing.warpActive);
    return obj;
}

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
    using O = RubberBand::RubberBandStretcher;
    if (mode == "complex") return O::OptionEngineFiner;
    if (mode == "tonal") return O::OptionEngineFaster | O::OptionTransientsSmooth | O::OptionWindowLong;
    return O::OptionEngineFaster | O::OptionTransientsCrisp;
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
 * Parse an integer port from a string. Returns the parsed value on success,
 * or `kDefaultBridgePort` on any failure (out of range / non-numeric /
 * trailing garbage). A warning is emitted on stderr in the failure path so
 * silent fallbacks remain debuggable.
 */
int parsePort(std::string_view value, std::string_view source)
{
    if (value.empty())
    {
        return kDefaultBridgePort;
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
                                 juce::String(std::string(value)) + "): " + juce::String(e.what()) +
                                 "; using default " + juce::String(kDefaultBridgePort));
        return kDefaultBridgePort;
    }

    if (port < kMinBridgePort || port > kMaxBridgePort)
    {
        silverdaw::log::warn("main",
                             juce::String("port ") + juce::String(port) + " from " +
                                 juce::String(std::string(source)) + " outside [" +
                                 juce::String(kMinBridgePort) + ", " + juce::String(kMaxBridgePort) +
                                 "]; using default " + juce::String(kDefaultBridgePort));
        return kDefaultBridgePort;
    }

    return port;
}

/**
 * Resolve the bridge listen port. Precedence (highest first):
 *   1. `--port <N>` or `--port=N` command-line argument
 *   2. `SILVERDAW_BRIDGE_PORT` environment variable
 *   3. compiled-in default (`kDefaultBridgePort`)
 *
 * The Electron main process picks an unused loopback port and passes it
 * via `--port` so multiple Silverdaw instances can run side-by-side without
 * colliding on 8765.
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

    // JUCE's wrapper is portable AND silences the MSVC "getenv is unsafe"
    // deprecation noise without a per-translation-unit pragma.
    const juce::String envValue = juce::SystemStats::getEnvironmentVariable("SILVERDAW_BRIDGE_PORT", {});
    if (envValue.isNotEmpty())
    {
        return parsePort(envValue.toStdString(), "SILVERDAW_BRIDGE_PORT");
    }

    return kDefaultBridgePort;
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
};

/**
 * Extract a numeric field from a bridge payload without the silent
 * coercion that `juce::var::getProperty(key, default)` performs. Returns
 * `std::nullopt` (and logs once) when the field is missing or wrong-typed
 * so dispatch handlers can reject the envelope instead of silently
 * applying a default value (e.g. seek-to-0, zero-gain).
 */
std::optional<double> tryGetNumber(const juce::var& payload, const char* key)
{
    const juce::var v = payload.getProperty(key, juce::var());
    if (v.isDouble() || v.isInt() || v.isInt64())
    {
        return static_cast<double>(v);
    }
    silverdaw::log::warn("bridge", juce::String("field '") + key + "' missing or non-numeric; envelope ignored");
    return std::nullopt;
}

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
    // pairs — the renderer reads `peakCount * 2 * sizeof(float)` bytes
    // from the file after the 24-byte header. Same layout the cache
    // itself uses (see `PeaksCache.cpp::CacheHeader`).
    const auto cacheFile = cache.getCacheFilePath(filePath, kPeaksPerSecond);
    auto* obj = new juce::DynamicObject();
    obj->setProperty("clipId", clipId);
    obj->setProperty("cachePath", cacheFile.getFullPathName());
    obj->setProperty("peakCount", static_cast<int>(result.peaks.size() / 2U));
    obj->setProperty("peaksPerSecond", effectivePeaksPerSecond(result));
    obj->setProperty("sampleRate", result.sampleRate);
    bridge.broadcast("WAVEFORM_READY", juce::var(obj));

    silverdaw::log::info("peaksjob", "done clipId=" + clipId + " peaks=" +
                                          juce::String(static_cast<int>(result.peaks.size() / 2U)) +
                                          (fromCache ? " (cache hit)" : " (computed)"));
}

/**
 * Estimate BPM for `filePath` on a worker thread and, on success,
 * persist it onto the matching library item + broadcast a
 * `LIBRARY_ITEM_BPM` envelope. Also seeds the project BPM when this is
 * the first detection on an otherwise-empty project.
 *
 * Safe to invoke from a `juce::ThreadPool` job: the actual BPM
 * computation runs on the worker thread; the ProjectState write and
 * broadcast are marshalled back onto the JUCE message thread via
 * `MessageManager::callAsync` so the ValueTree mutation stays
 * single-threaded.
 */
void maybeSeedProjectBpmFor(const juce::String& itemId, silverdaw::ProjectState& projectState,
                            silverdaw::BridgeServer& bridge);

void runBpmDetection(const juce::String& itemId, const juce::File& filePath,
                     silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                     silverdaw::BridgeServer& bridge, const silverdaw::DecodedCache& decodedCache,
                     bool recreateDecodedCache = false)
{
    silverdaw::log::info("bpmjob", "start itemId=" + itemId + " file=" + filePath.getFileName());

    // Step 1: decode the whole source file into a 16-bit PCM WAV
    // cache. No-op if a cache entry already exists for this file
    // (same (path, mtime, size) hash). The cache is what the audio
    // engine will use for all subsequent CLIP_ADDs of this file, so
    // the read-ahead thread reads cheap PCM instead of decoding the
    // original on every block.
    const auto cachedFile = recreateDecodedCache
                                ? decodedCache.recreateDecoded(filePath, engine.getFormatManager())
                                : decodedCache.ensureDecoded(filePath, engine.getFormatManager());
    const juce::String cachedPath = cachedFile.existsAsFile() ? cachedFile.getFullPathName() : juce::String();

    // Step 2: analyse the audio. Prefer the cached WAV (it's faster
    // to decode AND identical to what the engine will play, so the
    // beat times we report will line up perfectly with the audible
    // beats during playback). Fall back to the original on cache
    // failure.
    const juce::File analysisFile = cachedFile.existsAsFile() ? cachedFile : filePath;
    silverdaw::BpmDetector detector;
    const silverdaw::BpmAnalysis analysis = detector.analyse(analysisFile, engine.getFormatManager());
    if (analysis.bpm <= 0.0)
    {
        silverdaw::log::info("bpmjob", "no plausible BPM for itemId=" + itemId);
        // Even if BPM detection didn't produce a usable result, we
        // still want to surface the decoded-cache path so future
        // CLIP_ADDs use the cheap WAV. Broadcast a minimal
        // LIBRARY_ITEM_ANALYSIS with zero BPM and empty beats so the
        // renderer knows to update playbackFilePath.
        if (cachedPath.isNotEmpty() || recreateDecodedCache)
        {
            juce::MessageManager::callAsync(
                [itemId, cachedPath, &projectState, &bridge]
                {
                    projectState.clearLibraryItemAnalysis(itemId);
                    projectState.setLibraryItemPlaybackPath(itemId, cachedPath);
                    auto* p = new juce::DynamicObject();
                    p->setProperty("itemId", itemId);
                    p->setProperty("bpm", 0.0);
                    p->setProperty("beatAnchorSec", 0.0);
                    p->setProperty("beats", juce::var(juce::Array<juce::var>{}));
                    p->setProperty("variableTempo", false);
                    p->setProperty("playbackFilePath", cachedPath);
                    bridge.broadcast("LIBRARY_ITEM_ANALYSIS", juce::var(p));
                });
        }
        {
            std::lock_guard<std::mutex> lock(bpmJobsMutex);
            bpmJobsInFlight.erase(itemId);
        }
        return;
    }
    juce::MessageManager::callAsync(
        [itemId, analysis, cachedPath, &projectState, &bridge, &engine]
        {
            // Item may have been removed while we were busy.
            if (!projectState.setLibraryItemBpm(itemId, analysis.bpm))
            {
                silverdaw::log::warn("bpmjob",
                                     "library item " + itemId + " gone before BPM applied");
                {
                    std::lock_guard<std::mutex> lock(bpmJobsMutex);
                    bpmJobsInFlight.erase(itemId);
                }
                return;
            }
            projectState.setLibraryItemBeats(itemId, analysis.beatTimesSec);
            projectState.setLibraryItemBeatAnchor(itemId, analysis.beatAnchorSec);
            projectState.setLibraryItemVariableTempo(itemId, analysis.variableTempo);
            if (cachedPath.isNotEmpty())
            {
                projectState.setLibraryItemPlaybackPath(itemId, cachedPath);
            }

            // Build the analysis envelope. The beats array can run to
            // a few hundred floats for a long clip (no big deal for
            // localhost JSON, but worth keeping in mind).
            auto* p = new juce::DynamicObject();
            p->setProperty("itemId", itemId);
            p->setProperty("bpm", analysis.bpm);
            p->setProperty("beatAnchorSec", analysis.beatAnchorSec);
            juce::Array<juce::var> beatArr;
            beatArr.ensureStorageAllocated(static_cast<int>(analysis.beatTimesSec.size()));
            for (double t : analysis.beatTimesSec) beatArr.add(juce::var(t));
            p->setProperty("beats", juce::var(beatArr));
            p->setProperty("variableTempo", analysis.variableTempo);
            if (cachedPath.isNotEmpty())
            {
                p->setProperty("playbackFilePath", cachedPath);
            }
            bridge.broadcast("LIBRARY_ITEM_ANALYSIS", juce::var(p));

            // Late auto-warp: any clip that was dropped before this
            // library item's BPM was known carries a `pendingAutoWarp`
            // flag. Now that we have a stable source BPM (skip the
            // variable-tempo case — median BPM aligns globally but
            // drifts locally), flip warp on for those clips so the
            // user gets the intent they signalled at drop time without
            // any further action.
            DBG("[warp/late-flip] LIBRARY_ITEM_ANALYSIS itemId=" + itemId
                + " bpm=" + juce::String(analysis.bpm)
                + " variableTempo=" + (analysis.variableTempo ? "true" : "false")
                + " projectBpm=" + juce::String(projectState.getBpm()));
            if (!analysis.variableTempo && analysis.bpm > 0.0)
            {
                const double projectBpm = projectState.getBpm();
                int scanned = 0;
                int flipped = 0;
                projectState.forEachWarpClip(
                    [&](const silverdaw::ProjectState::WarpClipInfo& info)
                    {
                        if (info.libraryItemId != itemId) return;
                        ++scanned;
                        DBG("[warp/late-flip]   candidate clip=" + info.clipId
                            + " pendingAutoWarp=" + (info.pendingAutoWarp ? "true" : "false")
                            + " warpEnabled=" + (info.warpEnabled ? "true" : "false"));
                        if (info.pendingAutoWarp && projectBpm > 0.0)
                        {
                            // User opted into auto-warp at drop time
                            // but BPM wasn't ready yet. Flip warp on
                            // with the freshly-derived ratio.
                            const double ratio = projectBpm / analysis.bpm;
                            projectState.setClipWarp(info.clipId,
                                /*enabled=*/true,
                                juce::String("rhythmic"),
                                /*tempoRatio=*/std::nullopt,
                                /*tempoRatioClear=*/false,
                                std::nullopt, std::nullopt,
                                /*pendingAutoWarp=*/false);
                            engine.setClipWarp(info.clipId, true,
                                juce::String("rhythmic"), ratio, std::nullopt, std::nullopt);
                            auto wp = buildClipWarpAppliedPayload(projectState, info.clipId);
                            bridge.broadcast("CLIP_WARP_APPLIED", juce::var(wp.release()));
                            ++flipped;
                            DBG("[warp/late-flip]   → ENGAGED clip=" + info.clipId
                                + " ratio=" + juce::String(ratio));
                        }
                    });
                DBG("[warp/late-flip] itemId=" + itemId + " scanned=" + juce::String(scanned)
                    + " flipped=" + juce::String(flipped));
            }

            // Try to seed the project BPM. The helper checks the
            // gates (must have at least one clip on a track, etc.).
            maybeSeedProjectBpmFor(itemId, projectState, bridge);
            {
                std::lock_guard<std::mutex> lock(bpmJobsMutex);
                bpmJobsInFlight.erase(itemId);
            }
        });
}

/**
 * Try to seed the project BPM from a library item that already has a
 * detected BPM. Idempotent — safe to call from multiple paths. The
 * rule:
 *   - need at least one clip on a track (we don't seed for
 *     library-only imports; the user might be browsing samples and
 *     hasn't committed to a tempo yet);
 *   - skip when there's already at least one OTHER library item
 *     whose BPM is known (the seed has effectively run on a
 *     previous import already — don't keep moving the grid);
 *   - skip when the project BPM has already been seeded from this
 *     library item (current BPM matches the item's stored BPM).
 *
 * Runs unconditionally for variable-tempo items: an approximate
 * tempo is still better than the default for users dragging their
 * first reference loop, and the library tile already shows the
 * `~ BPM` badge to warn them.
 */
void maybeSeedProjectBpmFor(const juce::String& itemId, silverdaw::ProjectState& projectState,
                            silverdaw::BridgeServer& bridge)
{
    silverdaw::log::info("bpmjob", "seed check for itemId=" + itemId);
    const auto& tree = projectState.getTree();
    // Find the library item + its stored BPM. Bail if either is
    // missing — only useful when the analysis has actually landed.
    const auto library = tree.getChildWithName(juce::Identifier{"LIBRARY"});
    if (!library.isValid())
    {
        silverdaw::log::info("bpmjob", "seed skipped (no library tree)");
        return;
    }
    double itemBpm = 0.0;
    bool itemFound = false;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(juce::Identifier{"id"}).toString() == itemId)
        {
            itemFound = true;
            if (!item.hasProperty(juce::Identifier{"bpm"}))
            {
                silverdaw::log::info("bpmjob",
                                     "seed skipped for itemId=" + itemId + " (item has no BPM yet)");
                return;
            }
            itemBpm = static_cast<double>(item.getProperty(juce::Identifier{"bpm"}, 0.0));
            break;
        }
    }
    if (!itemFound)
    {
        silverdaw::log::info("bpmjob", "seed skipped — itemId=" + itemId + " not in library tree");
        return;
    }
    if (itemBpm <= 0.0)
    {
        silverdaw::log::info("bpmjob",
                             "seed skipped for itemId=" + itemId + " (itemBpm=0)");
        return;
    }

    // Gate 1: at least one clip must be on a track. Library-only
    // imports don't seed.
    int totalClips = 0;
    for (int t = 0; t < tree.getNumChildren(); ++t)
    {
        const auto track = tree.getChild(t);
        if (!track.hasType(juce::Identifier{"TRACK"})) continue;
        for (int c = 0; c < track.getNumChildren(); ++c)
        {
            if (track.getChild(c).hasType(juce::Identifier{"CLIP"}))
            {
                ++totalClips;
            }
        }
    }
    if (totalClips < 1)
    {
        silverdaw::log::info("bpmjob",
                             "seed skipped for itemId=" + itemId + " (no clips on tracks yet)");
        return;
    }

    // Gate 2: no other library item should already have a BPM (the
    // seed has effectively run on an earlier import).
    int otherItemsWithBpm = 0;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(juce::Identifier{"id"}).toString() == itemId) continue;
        if (item.hasProperty(juce::Identifier{"bpm"}))
        {
            ++otherItemsWithBpm;
        }
    }
    if (otherItemsWithBpm > 0)
    {
        silverdaw::log::info("bpmjob",
                             "seed skipped for itemId=" + itemId +
                                 " (other library items already have BPM: " +
                                 juce::String(otherItemsWithBpm) + ")");
        return;
    }

    // Gate 3: don't re-broadcast if the project BPM is already in sync.
    if (std::abs(projectState.getBpm() - itemBpm) < 1e-6)
    {
        return;
    }

    projectState.setBpm(itemBpm);
    auto* bpmObj = new juce::DynamicObject();
    bpmObj->setProperty("bpm", itemBpm);
    bridge.broadcast("PROJECT_BPM_APPLIED", juce::var(bpmObj));
    silverdaw::log::info("bpmjob", "seeded project BPM from " + itemId + ": " + juce::String(itemBpm, 4));
}

/**
 * Look up the library item id (if any) whose filePath matches
 * `filePath`, returning empty string if no item exists. Used by both
 * the LIBRARY_ADD and CLIP_ADD paths to find the right item to attach
 * a BPM to. (CLIP_ADD's payload doesn't carry the library itemId, so
 * we re-derive it from the filePath here.)
 */
juce::String findLibraryItemIdForPath(const silverdaw::ProjectState& projectState, const juce::String& filePath)
{
    const auto& root = projectState.getTree();
    const auto library = root.getChildWithName(juce::Identifier{"LIBRARY"});
    if (!library.isValid()) return {};
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(juce::Identifier{"kind"}, "audio-file").toString() == "audio-file"
            && item.getProperty(juce::Identifier{"filePath"}).toString() == filePath)
        {
            return item.getProperty(juce::Identifier{"id"}).toString();
        }
    }
    return {};
}

/**
 * Idempotent BPM-detection scheduler. If the library item for
 * `filePath` already has a non-zero BPM (or no library item exists),
 * this is a no-op; otherwise it queues a worker-pool job to run
 * BTrack on the file and attach the result to the matching item.
 *
 * Used by both LIBRARY_ADD (fresh import) and CLIP_ADD (e.g. when a
 * clip ends up on the timeline without going through a library
 * round-trip, or when the renderer's library dedupe sidesteps a
 * LIBRARY_ADD). Belt-and-braces: every imported audio file gets BPM
 * detected exactly once per (run, file).
 */
void ensureBpmDetection(const juce::String& filePath, silverdaw::AudioEngine& engine,
                        silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                        juce::ThreadPool& peakPool, const silverdaw::DecodedCache& decodedCache)
{
    if (filePath.isEmpty()) return;
    const juce::String itemId = findLibraryItemIdForPath(projectState, filePath);
    if (itemId.isEmpty()) return; // No library item to attach BPM to.
    if (projectState.getLibraryItemBpmForPath(filePath) > 0.0) return; // Already known.
    {
        std::lock_guard<std::mutex> lock(bpmJobsMutex);
        if (bpmJobsInFlight.find(itemId) != bpmJobsInFlight.end())
        {
            silverdaw::log::debug("bpmjob", "skip duplicate in-flight itemId=" + itemId);
            return;
        }
        bpmJobsInFlight.insert(itemId);
    }
    peakPool.addJob(
        [itemId, file = juce::File(filePath), &engine, &projectState, &bridge, &decodedCache]
        { runBpmDetection(itemId, file, engine, projectState, bridge, decodedCache); });
}

void forceLibraryItemAnalysis(const juce::String& itemId, const juce::String& filePath, silverdaw::AudioEngine& engine,
                              silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                              juce::ThreadPool& peakPool, const silverdaw::DecodedCache& decodedCache)
{
    if (itemId.isEmpty() || filePath.isEmpty()) return;
    {
        std::lock_guard<std::mutex> lock(bpmJobsMutex);
        if (bpmJobsInFlight.find(itemId) != bpmJobsInFlight.end())
        {
            silverdaw::log::debug("bpmjob", "skip duplicate in-flight reanalysis itemId=" + itemId);
            return;
        }
        bpmJobsInFlight.insert(itemId);
    }
    projectState.clearLibraryItemAnalysis(itemId);
    peakPool.addJob(
        [itemId, file = juce::File(filePath), &engine, &projectState, &bridge, &decodedCache]
        { runBpmDetection(itemId, file, engine, projectState, bridge, decodedCache, true); });
}

/**
 * Resolve the on-disk path the audio engine should read for `sourceFilePath`.
 * Always prefers the decoded-WAV cache so the audio thread reads cheap
 * 16-bit PCM instead of decoding the original (which is painfully slow
 * for compressed formats like MP3 and breaks the read-ahead-buffer's
 * latency-hiding contract at clip boundaries).
 *
 * Resolution order:
 *   1. The DecodedCache's expected path for this source — if the file
 *      exists on disk, use it. This wins even when ProjectState's
 *      stored `playbackFilePath` is stale (e.g. an upsert wrote the
 *      original source path back onto a previously-cached entry).
 *   2. The ProjectState-stored `playbackFilePath`, but ONLY if it
 *      already points at a `.wav`. Anything else is treated as a
 *      missing cache to avoid loading the original compressed file
 *      via this back door.
 *   3. The original source path as a last-resort fallback. The caller
 *      should ALSO schedule a decode job so the cache is ready for
 *      subsequent clips of the same source.
 *
 * Also keeps `ProjectState` in sync: if we found a cache on disk that
 * the stored `playbackFilePath` doesn't reflect, we overwrite it so the
 * persisted project picks the right path on the next save and so
 * libraryAsJson reports the correct path to the renderer.
 */
juce::String resolveEnginePlaybackPath(const juce::String& sourceFilePath,
                                       silverdaw::ProjectState& projectState,
                                       const silverdaw::DecodedCache& decodedCache)
{
    if (sourceFilePath.isEmpty()) return sourceFilePath;
    const juce::File source(sourceFilePath);
    if (!source.existsAsFile()) return sourceFilePath;

    const auto cacheFile = decodedCache.getCacheFilePath(source);
    if (cacheFile.existsAsFile())
    {
        const auto cachePath = cacheFile.getFullPathName();
        const auto stored = projectState.getLibraryItemPlaybackPathForSource(sourceFilePath);
        if (stored != cachePath)
        {
            const auto itemId = findLibraryItemIdForPath(projectState, sourceFilePath);
            if (itemId.isNotEmpty())
            {
                projectState.setLibraryItemPlaybackPath(itemId, cachePath);
            }
        }
        return cachePath;
    }

    const auto stored = projectState.getLibraryItemPlaybackPathForSource(sourceFilePath);
    if (stored.isNotEmpty() && stored.endsWithIgnoreCase(".wav") && juce::File(stored).existsAsFile())
    {
        return stored;
    }
    return sourceFilePath;
}

/**
 * Make sure a decoded-WAV cache exists for `sourceFilePath`. If the
 * cache file already exists on disk this is a no-op; otherwise a
 * worker-pool job decodes the source in the background and updates
 * the library item's `playbackFilePath` when done. Future CLIP_ADDs
 * for the same source will then pick up the cache via
 * `resolveEnginePlaybackPath`.
 */
void ensureDecodedCache(const juce::String& sourceFilePath, silverdaw::AudioEngine& engine,
                        silverdaw::ProjectState& projectState, juce::ThreadPool& peakPool,
                        const silverdaw::DecodedCache& decodedCache)
{
    if (sourceFilePath.isEmpty()) return;
    const juce::File source(sourceFilePath);
    if (!source.existsAsFile()) return;
    if (decodedCache.getCacheFilePath(source).existsAsFile()) return;

    peakPool.addJob(
        [src = source, &engine, &projectState, &decodedCache]
        {
            const auto built = decodedCache.ensureDecoded(src, engine.getFormatManager());
            if (!built.existsAsFile()) return;
            const auto cachePath = built.getFullPathName();
            const auto sourcePath = src.getFullPathName();
            juce::MessageManager::callAsync(
                [&projectState, sourcePath, cachePath]
                {
                    const auto itemId = findLibraryItemIdForPath(projectState, sourcePath);
                    if (itemId.isNotEmpty())
                    {
                        projectState.setLibraryItemPlaybackPath(itemId, cachePath);
                    }
                });
        });
}

void handleClipAdd(const juce::var& payload, silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                   silverdaw::BridgeServer& bridge, juce::ThreadPool& peakPool, const silverdaw::PeaksCache& cache,
                   const silverdaw::DecodedCache& decodedCache)
{
    const juce::String trackId = payload.getProperty("trackId", juce::var()).toString();
    const juce::String clipId = payload.getProperty("clipId", juce::var()).toString();
    const juce::String libraryItemId = payload.getProperty("libraryItemId", juce::var()).toString();
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
        resolveEnginePlaybackPath(filePath, projectState, decodedCache);
    // Kick off a background decode if the cache is missing. The first
    // play of a freshly-imported file still uses the original (the only
    // option until decoding completes), but every subsequent CLIP_ADD
    // of the same source picks up the cache.
    if (engineFilePath == filePath)
    {
        ensureDecodedCache(filePath, engine, projectState, peakPool, decodedCache);
    }

    juce::String errorMsg;
    bool ok = engine.addClip(clipId, juce::File(engineFilePath), initialOffsetMs, inMs, payloadDurationMs,
                             projectState.getTrackGain(trackId), &errorMsg);
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
            engine.setClipGain(clipId, projectState.getTrackGain(trackId));
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
        ensureBpmDetection(filePath, engine, projectState, bridge, peakPool, decodedCache);
        // If the matching library item already has a known BPM (e.g.
        // the user imported the file to the library earlier and is
        // only now placing it on a track), re-evaluate the seed
        // gates now that the project has a clip.
        maybeSeedProjectBpmFor(libraryItemId, projectState, bridge);
    }
}

void handleWaveformRequest(const juce::var& payload, silverdaw::AudioEngine& engine,
                           silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                           juce::ThreadPool& peakPool, const silverdaw::PeaksCache& cache)
{
    const juce::String clipId = payload.getProperty("clipId", juce::var()).toString();
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
    obj->setProperty("peakCount", static_cast<int>(result.peaks.size() / 2U));
    obj->setProperty("peaksPerSecond", effectivePeaksPerSecond(result));
    obj->setProperty("sampleRate", result.sampleRate);
    bridge.broadcast("CLIP_EDITOR_PEAKS_READY", juce::var(obj));
    silverdaw::log::info("peaksjob", "editor done libId=" + libraryItemId + " peaks=" +
                                          juce::String(static_cast<int>(result.peaks.size() / 2U)) +
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
                    obj->setProperty("peakCount", static_cast<int>(peaks.peaks.size() / 2U));
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
    const juce::String libraryItemId = payload.getProperty("libraryItemId", juce::var()).toString();
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

void handleClipMove(const juce::var& payload, silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState)
{
    const juce::String clipId = payload.getProperty("clipId", juce::var()).toString();
    if (clipId.isEmpty())
    {
        return;
    }
    const auto positionMs = tryGetNumber(payload, "positionMs");
    if (positionMs.has_value())
    {
        engine.setClipOffsetMs(clipId, *positionMs);
        projectState.setClipOffsetMs(clipId, *positionMs);
    }
    if (static_cast<bool>(payload.getProperty("commit", false)))
    {
        engine.commitClipOffset(clipId);
    }
    // Optional cross-track re-parent. Each clip is its own playable source,
    // so the move updates ProjectState and reapplies the destination track's
    // effective gain to keep mute / solo audibility correct.
    const juce::String newTrackId = payload.getProperty("trackId", juce::var()).toString();
    if (newTrackId.isNotEmpty())
    {
        if (projectState.setClipTrack(clipId, newTrackId))
        {
            engine.setClipGain(clipId, projectState.getTrackGain(newTrackId));
        }
    }
}

void handleClipTrim(const juce::var& payload, silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState)
{
    const juce::String clipId = payload.getProperty("clipId", juce::var()).toString();
    if (clipId.isEmpty())
    {
        return;
    }
    const auto startMs = tryGetNumber(payload, "startMs");
    const auto inMs = tryGetNumber(payload, "inMs");
    const auto durationMs = tryGetNumber(payload, "durationMs");
    if (!startMs.has_value() || !inMs.has_value() || !durationMs.has_value())
    {
        return;
    }
    engine.setClipTrim(clipId, *startMs, *inMs, *durationMs);
    projectState.setClipTrim(clipId, *startMs, *inMs, *durationMs);
}

void handleClipColor(const juce::var& payload, silverdaw::ProjectState& projectState)
{
    const juce::String clipId = payload.getProperty("clipId", juce::var()).toString();
    if (clipId.isEmpty())
    {
        return;
    }
    // colorIndex omitted or negative = clear the per-clip override.
    const juce::var idxVar = payload.getProperty("colorIndex", juce::var());
    const int colorIndex =
        (idxVar.isInt() || idxVar.isInt64()) ? static_cast<int>(idxVar) : -1;
    projectState.setClipColorIndex(clipId, colorIndex);
}

void handleTrackAdd(const juce::var& payload, silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge)
{
    const juce::String trackId = payload.getProperty("trackId", juce::var()).toString();
    if (trackId.isEmpty())
    {
        return;
    }
    const bool existed = projectState.hasTrack(trackId);
    const bool ok = projectState.addTrack(trackId);
    const juce::String name = payload.getProperty("name", juce::var()).toString();
    if (ok && !existed && name.trim().isNotEmpty())
    {
        projectState.setTrackName(trackId, name);
    }
    auto* p = new juce::DynamicObject();
    p->setProperty("trackId", trackId);
    p->setProperty("ok", ok);
    bridge.broadcast("TRACK_ADDED", juce::var(p));
}

void handleTrackRemove(const juce::var& payload, silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                       silverdaw::BridgeServer& bridge)
{
    const juce::String trackId = payload.getProperty("trackId", juce::var()).toString();
    if (trackId.isEmpty())
    {
        return;
    }
    const bool existed = projectState.hasTrack(trackId);
    // Tear down every audio source on this track BEFORE dropping the
    // track from ProjectState — otherwise the lookup loses the clip ids.
    const auto clipIds = projectState.getTrackClipIds(trackId);
    for (const auto& clipId : clipIds)
    {
        engine.removeClip(clipId);
    }
    projectState.removeTrack(trackId);
    auto* p = new juce::DynamicObject();
    p->setProperty("trackId", trackId);
    p->setProperty("ok", existed);
    bridge.broadcast("TRACK_REMOVED", juce::var(p));
}

void handleTrackRename(const juce::var& payload, silverdaw::ProjectState& projectState)
{
    const juce::String trackId = payload.getProperty("trackId", juce::var()).toString();
    const juce::String name = payload.getProperty("name", juce::var()).toString();
    if (trackId.isEmpty() || name.trim().isEmpty())
    {
        return;
    }
    projectState.setTrackName(trackId, name);
}

void handleClipRemove(const juce::var& payload, silverdaw::AudioEngine& engine,
                      silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge)
{
    const juce::String clipId = payload.getProperty("clipId", juce::var()).toString();
    if (clipId.isEmpty())
    {
        return;
    }
    // Drop the engine's audio source first so the next audio callback
    // doesn't try to pull from a source that's about to leave the
    // project tree. `removeClip` is idempotent so calling it for a
    // clip the engine never had is harmless.
    engine.removeClip(clipId);
    const bool existed = projectState.removeClip(clipId);
    auto* p = new juce::DynamicObject();
    p->setProperty("clipId", clipId);
    p->setProperty("ok", existed);
    bridge.broadcast("CLIP_REMOVED", juce::var(p));
}

void handleTrackGain(const juce::var& payload, silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                     silverdaw::BridgeServer& bridge)
{
    const juce::String trackId = payload.getProperty("trackId", juce::var()).toString();
    if (trackId.isEmpty())
    {
        return;
    }
    const auto gain = tryGetNumber(payload, "gain");
    if (!gain.has_value())
    {
        return;
    }
    const auto gainF = static_cast<float>(*gain);
    const bool stored = projectState.setTrackGain(trackId, gainF);
    // Fan the gain out to every clip on this logical track so multi-clip
    // tracks all hear the same volume. With one-clip-per-track today the
    // loop body runs at most once; the structure is ready for Phase 5.
    const auto clipIds = projectState.getTrackClipIds(trackId);
    for (const auto& clipId : clipIds)
    {
        engine.setClipGain(clipId, gainF);
    }
    auto* p = new juce::DynamicObject();
    p->setProperty("trackId", trackId);
    p->setProperty("gain", gainF);
    p->setProperty("ok", stored);
    bridge.broadcast("TRACK_GAIN_APPLIED", juce::var(p));
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
    obj->setProperty("playheadMs", projectState.getPlayheadMs());
    obj->setProperty("bpm", projectState.getBpm());
    obj->setProperty("projectLengthMs", projectState.getProjectLengthMs());
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
    const juce::String itemId = payload.getProperty("itemId", juce::var()).toString();
    const juce::String filePath = payload.getProperty("filePath", juce::var()).toString();
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
            const auto trackGain = static_cast<float>(static_cast<double>(track.getProperty("gain", 1.0)));

            engine.removeClip(clipId);
            const juce::String engineFilePath =
                resolveEnginePlaybackPath(filePath, projectState, decodedCache);
            if (engineFilePath == filePath)
            {
                ensureDecodedCache(filePath, engine, projectState, peakPool, decodedCache);
            }
            juce::String err;
            if (engine.addClip(clipId, juce::File(engineFilePath), offsetMs, inMs, durationMs, trackGain, &err))
            {
                engine.setClipGain(clipId, trackGain);
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
                resolveEnginePlaybackPath(filePath, projectState, decodedCache);
            if (engineFilePath == filePath)
            {
                ensureDecodedCache(filePath, engine, projectState, peakPool, decodedCache);
            }
            juce::String err;
            const auto trackGain = static_cast<float>(static_cast<double>(track.getProperty("gain", 1.0)));
            if (engine.addClip(clipId, juce::File(engineFilePath), offsetMs, inMs, durationMs, trackGain, &err))
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
    const juce::String filePath = payload.getProperty("filePath", juce::var()).toString();
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
    session.currentPath = filePath;

    bridge.broadcast("PROJECT_STATE", buildProjectStateEnvelope(session, projectState, true));
    silverdaw::log::info("project", "PROJECT_LOAD ok path=" + filePath);
}

void handleProjectSave(const juce::var& payload, silverdaw::AudioEngine& engine,
                       silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                       ProjectSession& session, bool isSaveAs)
{
    juce::String filePath = payload.getProperty("filePath", juce::var()).toString();
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
    juce::String filePath = payload.getProperty("filePath", juce::var()).toString();
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

    const auto result = silverdaw::ProjectFile::saveViewState(juce::File(filePath), scrollX, playheadMs);
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
    const juce::String name = payload.getProperty("name", juce::var()).toString();
    projectState.setName(name);
    auto* p = new juce::DynamicObject();
    p->setProperty("name", projectState.getName());
    p->setProperty("ok", true);
    bridge.broadcast("PROJECT_RENAMED", juce::var(p));
}

// ─── Audio output device control ──────────────────────────────────────
//
// Renderer-facing envelopes:
//   AUDIO_DEVICES_REQUEST { refresh? }     → AUDIO_DEVICES_LIST
//   AUDIO_DEVICE_SELECT   { typeName, deviceName }
//                                          → AUDIO_DEVICE_CHANGED
//                                          + AUDIO_DEVICES_LIST (on ok)
//
// The list payload is also broadcast spontaneously when JUCE's
// `audioDeviceListChanged` fires (USB plug / unplug, Windows audio
// reconfig) so the renderer never has to poll.

juce::var buildAudioDevicesListEnvelope(const silverdaw::AudioEngine::AudioDevicesSnapshot& snap,
                                        bool scanInProgress = false)
{
    auto* obj = new juce::DynamicObject();
    juce::Array<juce::var> types;
    for (const auto& t : snap.types)
    {
        auto* typeObj = new juce::DynamicObject();
        typeObj->setProperty("name", t.typeName);
        juce::Array<juce::var> devices;
        for (const auto& d : t.deviceNames)
        {
            devices.add(d);
        }
        typeObj->setProperty("devices", juce::var(devices));
        types.add(juce::var(typeObj));
    }
    obj->setProperty("types", juce::var(types));
    obj->setProperty("currentTypeName", snap.currentTypeName.isEmpty() ? juce::var() : juce::var(snap.currentTypeName));
    obj->setProperty("currentDeviceName",
                     snap.currentDeviceName.isEmpty() ? juce::var() : juce::var(snap.currentDeviceName));
    if (snap.currentSampleRate > 0.0)
    {
        obj->setProperty("currentSampleRate", snap.currentSampleRate);
    }
    if (snap.currentBufferSize > 0)
    {
        obj->setProperty("currentBufferSize", snap.currentBufferSize);
    }
    if (snap.outputLatencyMs > 0.0)
    {
        obj->setProperty("outputLatencyMs", snap.outputLatencyMs);
    }
    if (snap.heuristicExtraLatencyMs > 0.0)
    {
        obj->setProperty("heuristicExtraLatencyMs", snap.heuristicExtraLatencyMs);
    }
    if (snap.fellBackToDefault)
    {
        obj->setProperty("fellBackToDefault", true);
    }
    if (scanInProgress)
    {
        obj->setProperty("scanInProgress", true);
    }
    return juce::var(obj);
}

void handleAudioDevicesRequest(const juce::var& payload, silverdaw::AudioEngine& engine,
                               silverdaw::BridgeServer& bridge)
{
    const bool refresh = static_cast<bool>(payload.getProperty("refresh", false));
    // The first scan after boot is the slow step (100–400 ms, dominated
    // by ASIO/Bluetooth driver probing). Audio devices rarely change
    // between launches, so we don't want to block the message thread
    // for it during the renderer's startup window.
    //
    //   - Explicit "Rescan devices" (`refresh: true`): synchronous —
    //     the user is waiting and expects the freshest list.
    //   - Already scanned: just broadcast the cached snapshot.
    //   - First request after boot, no explicit refresh: broadcast
    //     whatever the engine already has (current device + its type,
    //     populated by `initialise()`), then defer the full scan via
    //     `MessageManager::callAsync`. The bridge ships the initial
    //     response before the slow scan runs, and the UI updates a
    //     beat later when the deferred scan broadcasts the full list.
    if (refresh)
    {
        engine.refreshAudioDevices();
        bridge.broadcast("AUDIO_DEVICES_LIST", buildAudioDevicesListEnvelope(engine.getAudioDevicesSnapshot()));
        return;
    }

    const bool needsFirstScan = !engine.hasScannedAllDevices();
    bridge.broadcast("AUDIO_DEVICES_LIST",
                     buildAudioDevicesListEnvelope(engine.getAudioDevicesSnapshot(),
                                                   /*scanInProgress*/ needsFirstScan));

    if (needsFirstScan)
    {
        juce::MessageManager::callAsync(
            [enginePtr = &engine, bridgePtr = &bridge]()
            {
                enginePtr->refreshAudioDevices();
                bridgePtr->broadcast(
                    "AUDIO_DEVICES_LIST",
                    buildAudioDevicesListEnvelope(enginePtr->getAudioDevicesSnapshot()));
            });
    }
}

void handleAudioDeviceSelect(const juce::var& payload, silverdaw::AudioEngine& engine,
                             silverdaw::BridgeServer& bridge)
{
    // Nullable fields: both null = revert to system default.
    const auto typeVar = payload.getProperty("typeName", juce::var());
    const auto deviceVar = payload.getProperty("deviceName", juce::var());
    const juce::String typeName = typeVar.isString() ? typeVar.toString() : juce::String();
    const juce::String deviceName = deviceVar.isString() ? deviceVar.toString() : juce::String();

    const auto err = engine.selectOutputDevice(typeName, deviceName);

    auto* p = new juce::DynamicObject();
    p->setProperty("typeName", typeName.isEmpty() ? juce::var() : juce::var(typeName));
    p->setProperty("deviceName", deviceName.isEmpty() ? juce::var() : juce::var(deviceName));
    p->setProperty("ok", err.isEmpty());
    if (err.isNotEmpty()) p->setProperty("error", err);
    bridge.broadcast("AUDIO_DEVICE_CHANGED", juce::var(p));

    // No explicit `AUDIO_DEVICES_LIST` broadcast here: a successful
    // `setAudioDeviceSetup` fires JUCE's `audioDeviceListChanged`
    // callback, which the engine forwards to the renderer via
    // `setDeviceListChangedCallback` (wired up in `runBackend`).
    // Avoiding the duplicate keeps the round-trip lean on a switch.

    silverdaw::log::info("audio",
                         juce::String("device select type=") + typeName + " name=" + deviceName +
                             (err.isEmpty() ? " ok" : " fail: " + err));
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
    const juce::String filePath = payload.getProperty("filePath", juce::var()).toString();
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
    const juce::String autosavePath = payload.getProperty("autosavePath", juce::var()).toString();
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
           type == "CLIP_REMOVE" || type == "CLIP_RENAME" || type == "CLIP_REBIND" ||
           type == "CLIP_SET_WARP" ||
           type == "CLIP_RELINK" ||
           type == "TRACK_ADD" || type == "TRACK_REMOVE" || type == "TRACK_RENAME" ||
           type == "TRACK_GAIN" || type == "TRACK_SET_HEIGHT" || type == "TRACK_REORDER" ||
           type == "LIBRARY_ADD" || type == "LIBRARY_REMOVE" ||
           type == "LIBRARY_REANALYSE" || type == "LIBRARY_ITEM_RELINK" ||
           type == "PROJECT_RENAME" || type == "PROJECT_SET_BPM" || type == "PROJECT_SET_LENGTH" ||
           type == "PROJECT_MARKER_ADD" || type == "PROJECT_MARKER_MOVE" ||
           type == "PROJECT_MARKER_REMOVE";
}

juce::String prettyTransactionName(const juce::String& type)
{
    if (type == "CLIP_ADD") return "Add clip";
    if (type == "CLIP_MOVE") return "Move clip";
    if (type == "CLIP_TRIM") return "Trim clip";
    if (type == "CLIP_COLOR") return "Recolour clip";
    if (type == "CLIP_REMOVE") return "Delete clip";
    if (type == "CLIP_RENAME") return "Rename clip";
    if (type == "CLIP_REBIND") return "Save clip to library";
    if (type == "CLIP_SET_WARP") return "Change warp";
    if (type == "CLIP_RELINK") return "Relink clip";
    if (type == "TRACK_ADD") return "Add track";
    if (type == "TRACK_REMOVE") return "Remove track";
    if (type == "TRACK_RENAME") return "Rename track";
    if (type == "TRACK_GAIN") return "Change track gain";
    if (type == "TRACK_SET_HEIGHT") return "Resize track";
    if (type == "TRACK_REORDER") return "Reorder track";
    if (type == "LIBRARY_ADD") return "Update library item";
    if (type == "LIBRARY_REMOVE") return "Remove library item";
    if (type == "LIBRARY_REANALYSE") return "Reanalyse library item";
    if (type == "LIBRARY_ITEM_RELINK") return "Relink library item";
    if (type == "PROJECT_RENAME") return "Rename project";
    if (type == "PROJECT_SET_BPM") return "Change tempo";
    if (type == "PROJECT_SET_LENGTH") return "Change project length";
    if (type == "PROJECT_MARKER_ADD") return "Add marker";
    if (type == "PROJECT_MARKER_MOVE") return "Move marker";
    if (type == "PROJECT_MARKER_REMOVE") return "Remove marker";
    return type;
}

// File-scope coalescing state. Dispatch always runs on the JUCE message
// thread so no synchronisation is needed.
struct UndoCoalesceState
{
    juce::String lastKey;
    juce::int64 lastTimeMs = 0;
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
    if (type == "CLIP_MOVE" || type == "CLIP_TRIM" || type == "CLIP_SET_WARP")
    {
        idPart = payload.getProperty("clipId", "").toString();
    }
    else if (type == "TRACK_GAIN")
    {
        idPart = payload.getProperty("trackId", "").toString();
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

    juce::String key = type;
    if (idPart.isNotEmpty()) key << ":" << idPart;

    const auto now = juce::Time::currentTimeMillis();
    auto& s = undoCoalesceState();
    const bool coalesce = idPart.isNotEmpty() && key == s.lastKey &&
                          (now - s.lastTimeMs) < kUndoCoalesceWindowMs;
    if (!coalesce)
    {
        projectState.getUndoManager().beginNewTransaction(prettyTransactionName(type));
    }
    s.lastKey = key;
    s.lastTimeMs = now;
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

// Same wire-protocol convention as BridgeServer::broadcast: (type, payload) order is
// fixed by design, so the easily-swappable-parameters check is intentionally silenced.
// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
void dispatchBridgeMessage(const juce::String& type, const juce::var& payload, silverdaw::AudioEngine& engine,
                           silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                           juce::ThreadPool& peakPool, const silverdaw::PeaksCache& cache,
                           const silverdaw::DecodedCache& decodedCache, ProjectSession& session)
{
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
        handleClipMove(payload, engine, projectState);
    }
    else if (type == "CLIP_TRIM")
    {
        silverdaw::log::debug("bridge", "recv CLIP_TRIM clipId=" + payload.getProperty("clipId", "").toString() +
                                            " start=" + payload.getProperty("startMs", "").toString() +
                                            " in=" + payload.getProperty("inMs", "").toString() +
                                            " dur=" + payload.getProperty("durationMs", "").toString());
        handleClipTrim(payload, engine, projectState);
    }
    else if (type == "CLIP_COLOR")
    {
        silverdaw::log::debug("bridge", "recv CLIP_COLOR clipId=" + payload.getProperty("clipId", "").toString() +
                                            " idx=" + payload.getProperty("colorIndex", "").toString());
        handleClipColor(payload, projectState);
    }
    else if (type == "CLIP_REMOVE")
    {
        silverdaw::log::info("bridge", "recv CLIP_REMOVE clipId=" + payload.getProperty("clipId", "").toString());
        handleClipRemove(payload, engine, projectState, bridge);
    }
    else if (type == "LIBRARY_ITEM_RELINK")
    {
        silverdaw::log::info("bridge", "recv LIBRARY_ITEM_RELINK itemId=" + payload.getProperty("itemId", "").toString() +
                                            " path=" + payload.getProperty("filePath", "").toString());
        handleLibraryItemRelink(payload, engine, projectState, bridge, session, peakPool, decodedCache);
    }
    else if (type == "CLIP_RENAME")
    {
        const juce::String clipId = payload.getProperty("clipId", juce::var()).toString();
        const juce::String name = payload.getProperty("name", juce::var()).toString();
        silverdaw::log::info("bridge", "recv CLIP_RENAME clipId=" + clipId + " name=" + name);
        projectState.setClipName(clipId, name);
    }
    else if (type == "CLIP_REBIND")
    {
        const juce::String clipId = payload.getProperty("clipId", juce::var()).toString();
        const juce::String libraryItemId = payload.getProperty("libraryItemId", juce::var()).toString();
        silverdaw::log::info("bridge", "recv CLIP_REBIND clipId=" + clipId + " libraryItemId=" +
                                           libraryItemId);
        if (clipId.isNotEmpty() && libraryItemId.isNotEmpty())
        {
            projectState.setClipLibraryItemId(clipId, libraryItemId);
        }
    }
    else if (type == "CLIP_SET_WARP")
    {
        const juce::String clipId = payload.getProperty("clipId", juce::var()).toString();
        silverdaw::log::info("bridge", "recv CLIP_SET_WARP clipId=" + clipId);
        if (clipId.isNotEmpty())
        {
            std::optional<bool> warpEnabled;
            if (payload.hasProperty("warpEnabled"))
                warpEnabled = static_cast<bool>(payload.getProperty("warpEnabled", false));
            std::optional<juce::String> warpMode;
            if (payload.hasProperty("warpMode"))
                warpMode = payload.getProperty("warpMode", juce::var()).toString();
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
            auto appliedPayload = buildClipWarpAppliedPayload(projectState, clipId);
            bridge.broadcast("CLIP_WARP_APPLIED", juce::var(appliedPayload.release()));
        }
    }
    else if (type == "CLIP_SAVE_AS_SAMPLE")
    {
        const juce::String clipId = payload.getProperty("clipId", juce::var()).toString();
        const juce::String itemId = payload.getProperty("itemId", juce::var()).toString();
        const juce::String sampleName = payload.getProperty("sampleName", juce::var()).toString();
        const juce::String outputDir = payload.getProperty("outputDir", juce::var()).toString();
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
        const juce::String libraryItemId = payload.getProperty("libraryItemId", juce::var()).toString();
        const juce::String itemId = payload.getProperty("itemId", juce::var()).toString();
        const juce::String sampleName = payload.getProperty("sampleName", juce::var()).toString();
        const juce::String outputDir = payload.getProperty("outputDir", juce::var()).toString();
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
        const juce::String itemId = payload.getProperty("itemId", juce::var()).toString();
        const juce::String filePath = payload.getProperty("filePath", juce::var()).toString();
        const juce::String fileName = payload.getProperty("fileName", juce::var()).toString();
        const double durationMs = static_cast<double>(payload.getProperty("durationMs", 0.0));
        const int sampleRate = static_cast<int>(payload.getProperty("sampleRate", 0));
        const int channelCount = static_cast<int>(payload.getProperty("channelCount", 0));
        const juce::String playbackPath = payload.getProperty("playbackFilePath", juce::var()).toString();
        const juce::String key = payload.getProperty("key", juce::var()).toString();
        const juce::String kind = payload.getProperty("kind", juce::var()).toString();
        const juce::String displayName = payload.getProperty("name", juce::var()).toString();
        const juce::String sourceItemId = payload.getProperty("sourceItemId", juce::var()).toString();
        const juce::String sourceClipId = payload.getProperty("sourceClipId", juce::var()).toString();
        const double sourceInMs = payload.hasProperty("sourceInMs")
                                      ? static_cast<double>(payload.getProperty("sourceInMs", 0.0))
                                      : -1.0;
        const double sourceDurationMs = payload.hasProperty("sourceDurationMs")
                                            ? static_cast<double>(payload.getProperty("sourceDurationMs", 0.0))
                                            : -1.0;
        const int collapsedFlag = payload.hasProperty("collapsed")
                                      ? (bool(payload.getProperty("collapsed", false)) ? 1 : 0)
                                      : -1;
        silverdaw::log::info("bridge", "recv LIBRARY_ADD itemId=" + itemId);
        projectState.addLibraryItem(itemId, filePath, fileName, durationMs, sampleRate, channelCount, playbackPath, key,
                                    kind, displayName, sourceItemId, sourceClipId, sourceInMs, sourceDurationMs,
                                    collapsedFlag);
        if (kind == "saved-clip")
        {
            // Warp defaults — only meaningful on saved clips. Each
            // field is partial; missing fields stay at whatever
            // `addLibraryItem` left them as (i.e. unset → identity).
            std::optional<bool> warpEnabled;
            if (payload.hasProperty("warpEnabled"))
                warpEnabled = static_cast<bool>(payload.getProperty("warpEnabled", false));
            std::optional<juce::String> warpMode;
            if (payload.hasProperty("warpMode"))
                warpMode = payload.getProperty("warpMode", juce::var()).toString();
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
            if (warpEnabled.has_value() || warpMode.has_value() || tempoRatio.has_value() ||
                tempoRatioClear || semitones.has_value() || cents.has_value())
            {
                projectState.setLibraryItemWarp(itemId, warpEnabled, warpMode, tempoRatio,
                                                tempoRatioClear, semitones, cents);
            }
        }
        else
        {
            ensureBpmDetection(filePath, engine, projectState, bridge, peakPool, decodedCache);
        }
    }
    else if (type == "LIBRARY_REMOVE")
    {
        const juce::String itemId = payload.getProperty("itemId", juce::var()).toString();
        silverdaw::log::info("bridge", "recv LIBRARY_REMOVE itemId=" + itemId);
        projectState.removeLibraryItem(itemId);
    }
    else if (type == "LIBRARY_REANALYSE")
    {
        const juce::String itemId = payload.getProperty("itemId", juce::var()).toString();
        const juce::String filePath = payload.getProperty("filePath", juce::var()).toString();
        const juce::String fileName = payload.getProperty("fileName", juce::var()).toString();
        const double durationMs = static_cast<double>(payload.getProperty("durationMs", 0.0));
        const int sampleRate = static_cast<int>(payload.getProperty("sampleRate", 0));
        const int channelCount = static_cast<int>(payload.getProperty("channelCount", 0));
        const juce::String playbackPath = payload.getProperty("playbackFilePath", juce::var()).toString();
        silverdaw::log::info("bridge", "recv LIBRARY_REANALYSE itemId=" + itemId);
        projectState.addLibraryItem(itemId, filePath, fileName, durationMs, sampleRate, channelCount, playbackPath);
        if (payload.hasProperty("key"))
        {
            projectState.setLibraryItemKey(itemId, payload.getProperty("key", juce::var()).toString());
        }
        const juce::String analysisPath = playbackPath.isNotEmpty() ? playbackPath : filePath;
        forceLibraryItemAnalysis(itemId, analysisPath, engine, projectState, bridge, peakPool, decodedCache);
    }
    else if (type == "TRANSPORT_PLAY")
    {
        silverdaw::log::info("bridge", "recv TRANSPORT_PLAY");
        engine.play();
    }
    else if (type == "TRANSPORT_PAUSE")
    {
        silverdaw::log::info("bridge", "recv TRANSPORT_PAUSE");
        engine.pause();
    }
    else if (type == "TRANSPORT_STOP")
    {
        silverdaw::log::info("bridge", "recv TRANSPORT_STOP");
        engine.stop();
        projectState.setPlayheadMs(0.0);
    }
    else if (type == "TRANSPORT_SEEK")
    {
        const auto positionMs = tryGetNumber(payload, "positionMs");
        silverdaw::log::info("bridge", "recv TRANSPORT_SEEK pos=" + juce::String(positionMs.value_or(-1.0)));
        if (positionMs.has_value())
        {
            engine.setPositionMs(*positionMs);
            projectState.setPlayheadMs(juce::jmax(0.0, *positionMs));
        }
    }
    else if (type == "PREVIEW_LOAD")
    {
        const juce::String libraryItemId = payload.getProperty("libraryItemId", juce::var()).toString();
        const double inMs = static_cast<double>(payload.getProperty("inMs", 0.0));
        const double durationMs = static_cast<double>(payload.getProperty("durationMs", 0.0));
        silverdaw::log::info("bridge", "recv PREVIEW_LOAD libraryItemId=" + libraryItemId +
                                            " inMs=" + juce::String(inMs) +
                                            " durationMs=" + juce::String(durationMs));
        const juce::String sourcePath = projectState.getLibraryItemFilePath(libraryItemId);
        if (sourcePath.isEmpty())
        {
            silverdaw::log::warn("preview", "PREVIEW_LOAD unknown libraryItemId=" + libraryItemId);
        }
        else
        {
            // Prefer the decoded WAV cache (same resolver as timeline) so a
            // compressed source still previews promptly. Falls back to the
            // source path when no cache is available yet.
            const juce::String playbackPath = resolveEnginePlaybackPath(sourcePath, projectState, decodedCache);
            juce::String err;
            std::optional<bool> warpEnabled;
            std::optional<juce::String> warpMode;
            std::optional<double> tempoRatio;
            std::optional<double> semitones;
            std::optional<double> cents;
            if (payload.hasProperty("warpEnabled"))
            {
                warpEnabled = static_cast<bool>(payload.getProperty("warpEnabled", false));
                if (payload.hasProperty("warpMode"))
                    warpMode = payload.getProperty("warpMode", juce::var()).toString();
                if (payload.hasProperty("tempoRatio"))
                {
                    const auto& v = payload["tempoRatio"];
                    if (!v.isVoid() && !v.isUndefined()) tempoRatio = static_cast<double>(v);
                }
                if (payload.hasProperty("semitones"))
                    semitones = static_cast<double>(payload.getProperty("semitones", 0.0));
                if (payload.hasProperty("cents"))
                    cents = static_cast<double>(payload.getProperty("cents", 0.0));
            }
            if (!engine.loadPreview(juce::File(playbackPath), inMs, durationMs, &err,
                                    warpEnabled, warpMode, tempoRatio, semitones, cents))
            {
                silverdaw::log::warn("preview", "PREVIEW_LOAD failed: " + err.toStdString());
            }
            const auto generation = static_cast<juce::int64>(engine.getPreviewGeneration());
            juce::Timer::callAfterDelay(
                kPreviewReadyDelayMs,
                [&engine, &bridge, libraryItemId, generation]
                {
                    broadcastPreviewStateIfCurrent(engine, bridge, libraryItemId, generation);
                });
        }
    }
    else if (type == "PREVIEW_UNLOAD")
    {
        silverdaw::log::info("bridge", "recv PREVIEW_UNLOAD");
        engine.unloadPreview();
        auto* stateObj = new juce::DynamicObject();
        stateObj->setProperty("isPlaying", false);
        stateObj->setProperty("isLoaded", false);
        stateObj->setProperty("durationMs", 0.0);
        stateObj->setProperty("generation", static_cast<juce::int64>(engine.getPreviewGeneration()));
        bridge.broadcast("PREVIEW_STATE", juce::var(stateObj));
    }
    else if (type == "PREVIEW_PLAY")
    {
        silverdaw::log::info("bridge", "recv PREVIEW_PLAY");
        // The Clip Editor owns playback exclusively while open — pause the
        // project transport so the user doesn't hear both at once.
        if (engine.isPlaying()) engine.pause();
        engine.playPreview();
        auto* stateObj = new juce::DynamicObject();
        stateObj->setProperty("isPlaying", engine.isPreviewPlaying());
        stateObj->setProperty("isLoaded", engine.isPreviewLoaded());
        stateObj->setProperty("durationMs", engine.getPreviewDurationMs());
        stateObj->setProperty("generation", static_cast<juce::int64>(engine.getPreviewGeneration()));
        bridge.broadcast("PREVIEW_STATE", juce::var(stateObj));
    }
    else if (type == "PREVIEW_PAUSE")
    {
        silverdaw::log::info("bridge", "recv PREVIEW_PAUSE");
        engine.pausePreview();
        auto* stateObj = new juce::DynamicObject();
        stateObj->setProperty("isPlaying", false);
        stateObj->setProperty("isLoaded", engine.isPreviewLoaded());
        stateObj->setProperty("durationMs", engine.getPreviewDurationMs());
        stateObj->setProperty("generation", static_cast<juce::int64>(engine.getPreviewGeneration()));
        bridge.broadcast("PREVIEW_STATE", juce::var(stateObj));
    }
    else if (type == "PREVIEW_STOP")
    {
        silverdaw::log::info("bridge", "recv PREVIEW_STOP");
        engine.stopPreview();
        auto* stateObj = new juce::DynamicObject();
        stateObj->setProperty("isPlaying", false);
        stateObj->setProperty("isLoaded", engine.isPreviewLoaded());
        stateObj->setProperty("durationMs", engine.getPreviewDurationMs());
        stateObj->setProperty("generation", static_cast<juce::int64>(engine.getPreviewGeneration()));
        bridge.broadcast("PREVIEW_STATE", juce::var(stateObj));
    }
    else if (type == "PREVIEW_SEEK")
    {
        const auto positionMs = tryGetNumber(payload, "positionMs");
        if (positionMs.has_value())
        {
            engine.setPreviewPositionMs(*positionMs);
        }
    }
    else if (type == "PREVIEW_SET_WARP")
    {
        silverdaw::log::info("bridge", "recv PREVIEW_SET_WARP");
        std::optional<bool> warpEnabled;
        if (payload.hasProperty("warpEnabled"))
            warpEnabled = static_cast<bool>(payload.getProperty("warpEnabled", false));
        std::optional<juce::String> warpMode;
        if (payload.hasProperty("warpMode"))
            warpMode = payload.getProperty("warpMode", juce::var()).toString();
        std::optional<double> tempoRatio;
        if (payload.hasProperty("tempoRatio"))
        {
            const auto& v = payload["tempoRatio"];
            if (!v.isVoid() && !v.isUndefined()) tempoRatio = static_cast<double>(v);
        }
        std::optional<double> semitones;
        if (payload.hasProperty("semitones"))
            semitones = static_cast<double>(payload.getProperty("semitones", 0.0));
        std::optional<double> cents;
        if (payload.hasProperty("cents"))
            cents = static_cast<double>(payload.getProperty("cents", 0.0));
        engine.setPreviewWarp(warpEnabled, warpMode, tempoRatio, semitones, cents);
    }
    else if (type == "TRACK_ADD")
    {
        silverdaw::log::info("bridge", "recv TRACK_ADD trackId=" + payload.getProperty("trackId", "").toString());
        handleTrackAdd(payload, projectState, bridge);
    }
    else if (type == "TRACK_REMOVE")
    {
        silverdaw::log::info("bridge", "recv TRACK_REMOVE trackId=" + payload.getProperty("trackId", "").toString());
        handleTrackRemove(payload, engine, projectState, bridge);
    }
    else if (type == "TRACK_RENAME")
    {
        silverdaw::log::info("bridge", "recv TRACK_RENAME trackId=" + payload.getProperty("trackId", "").toString());
        handleTrackRename(payload, projectState);
    }
    else if (type == "TRACK_GAIN")
    {
        silverdaw::log::debug("bridge", "recv TRACK_GAIN trackId=" + payload.getProperty("trackId", "").toString() +
                                            " gain=" + payload.getProperty("gain", "").toString());
        handleTrackGain(payload, engine, projectState, bridge);
    }
    else if (type == "TRACK_SET_HEIGHT")
    {
        const auto trackId = payload.getProperty("trackId", juce::var()).toString();
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
        const auto trackId = payload.getProperty("trackId", juce::var()).toString();
        const auto idxVar = tryGetNumber(payload, "newIndex");
        silverdaw::log::info("bridge", "recv TRACK_REORDER trackId=" + trackId +
                                           " newIndex=" + payload.getProperty("newIndex", "").toString());
        if (trackId.isNotEmpty() && idxVar.has_value())
        {
            projectState.moveTrack(trackId, static_cast<int>(*idxVar));
        }
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
                        auto appliedPayload = buildClipWarpAppliedPayload(projectState, info.clipId);
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
    else if (type == "PROJECT_MARKER_ADD")
    {
        const auto markerId = payload.getProperty("markerId", juce::var()).toString();
        const auto posVar = payload.getProperty("positionMs", juce::var());
        if (!markerId.isEmpty() && (posVar.isDouble() || posVar.isInt() || posVar.isInt64()))
        {
            const double positionMs = static_cast<double>(posVar);
            if (positionMs >= 0.0)
            {
                projectState.addMarker(markerId, positionMs);
            }
        }
    }
    else if (type == "PROJECT_MARKER_MOVE")
    {
        const auto markerId = payload.getProperty("markerId", juce::var()).toString();
        const auto posVar = payload.getProperty("positionMs", juce::var());
        if (!markerId.isEmpty() && (posVar.isDouble() || posVar.isInt() || posVar.isInt64()))
        {
            const double positionMs = static_cast<double>(posVar);
            if (positionMs >= 0.0)
            {
                projectState.moveMarker(markerId, positionMs);
            }
        }
    }
    else if (type == "PROJECT_MARKER_REMOVE")
    {
        const auto markerId = payload.getProperty("markerId", juce::var()).toString();
        if (markerId.isNotEmpty())
        {
            projectState.removeMarker(markerId);
        }
    }
    else if (type == "AUDIO_DEVICES_REQUEST")
    {
        silverdaw::log::debug("bridge", "recv AUDIO_DEVICES_REQUEST refresh=" +
                                            payload.getProperty("refresh", "false").toString());
        handleAudioDevicesRequest(payload, engine, bridge);
    }
    else if (type == "AUDIO_DEVICE_SELECT")
    {
        silverdaw::log::info("bridge", "recv AUDIO_DEVICE_SELECT type=" +
                                           payload.getProperty("typeName", "").toString() + " name=" +
                                           payload.getProperty("deviceName", "").toString());
        handleAudioDeviceSelect(payload, engine, bridge);
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
    else
    {
        silverdaw::log::warn("bridge", "unhandled message type: " + type);
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
        { dispatchBridgeMessage(type, payload, engine, projectState, self, peakPool, peaksCache, decodedCache,
                                session); },
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
            bridge.broadcast("AUDIO_DEVICES_LIST",
                             buildAudioDevicesListEnvelope(engine.getAudioDevicesSnapshot()));
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
