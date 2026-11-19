#include "MixdownCommands.h"

#include <cmath>

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "DecodedCache.h"
#include "EnginePlaybackPath.h"
#include "Log.h"
#include "MixdownEngine.h"
#include "MixdownBroadcast.h"
#include "PluginChain.h"
#include "ProjectSession.h"
#include "TrackExport.h"
#include "PayloadHelpers.h"
#include "ProjectState.h"

namespace silverdaw
{

using silverdaw::bridge::readOptionalString;
using silverdaw::bridge::tryGetRequiredString;

static MixdownSnapshot prepareRenderSnapshot(AudioEngine& engine, ProjectState& project,
                                            const DecodedCache& cache, SnapshotScope scope,
                                            bool capturePlugins = false)
{
    auto snapshot = snapshotProjectForMixdown(project, engine.getBrakeDefaultSeconds(),
        engine.getBrakeDefaultCurve(), engine.getBackspinDefaultSeconds(),
        engine.getBackspinDefaultSpeed(), engine.getBackspinDefaultCurve(), scope);
    for (auto& track : snapshot.tracks)
    {
        if (capturePlugins)
            for (auto& slot : track.plugins)
            {
                const auto chunk = engine.getTrackPluginState(track.id, slot.slotId);
                if (!chunk.isEmpty()) slot.state = plugins::encodeStateChunk(chunk);
            }
        for (auto& clip : track.clips)
        {
            const auto raw = project.getLibraryItemFilePath(clip.libraryItemId);
            const auto resolved = resolveEnginePlaybackPath(raw, project, cache);
            if (resolved.isNotEmpty()) clip.filePath = resolved;
            log::debug("mixdown", "snapshot clip=" + clip.id + " source=" + raw + " playback=" + clip.filePath);
        }
    }
    const auto deviceRate = engine.getAudioDevicesSnapshot().currentSampleRate;
    if (deviceRate > 0.0) snapshot.projectSampleRate = static_cast<int>(deviceRate);
    return snapshot;
}

void handleTrackExportStart(const juce::var& payload, AudioEngine& engine, ProjectState& project,
                            BridgeServer& bridge, juce::ThreadPool& pool, const DecodedCache& cache,
                            const juce::String& projectPath, std::atomic<bool>& busy, std::atomic<bool>& cancel)
{
    const auto reject = [&](const juce::String& message) {
        mixdown_bridge::broadcastFailed(bridge, MixdownFailureCode::Invalid, message);
    };
    if (busy.load())
    {
        reject("An export is already in progress.");
        return;
    }
    if (projectPath.isEmpty())
    {
        reject("Save the project before exporting tracks.");
        return;
    }
    const auto rate = bridge::tryGetNumber(payload, "sampleRate");
    const auto depth = bridge::tryGetNumber(payload, "bitDepth");
    const auto tail = bridge::tryGetNumber(payload, "tailSeconds");
    const auto effects = payload.getProperty("includeEffects", {});
    const auto labels = payload.getProperty("trackLabels", {});
    if ((!rate || (*rate != 44100 && *rate != 48000)) ||
        (!depth || (*depth != 16 && *depth != 24 && *depth != 32)) ||
        (!tail || !std::isfinite(*tail) || *tail < 0 || *tail > 60) || !effects.isBool() || !labels.isObject())
    {
        reject("Invalid WAV settings for track export.");
        return;
    }

    engine.pause();
    const bool wet = static_cast<bool>(effects);
    auto snapshot = prepareRenderSnapshot(engine, project, cache, SnapshotScope::IndividualTracks, wet);
    for (auto& track : snapshot.tracks)
    {
        const auto label = labels.getProperty(juce::Identifier(track.id), {});
        if (label.isString() && label.toString().isNotEmpty()) track.name = label.toString();
    }
    const auto folder = projectArtifactsBaseDir(projectPath, "export");
    MixdownOptions options;
    options.outputSampleRate = static_cast<int>(*rate);
    options.bitDepth = static_cast<int>(*depth);
    options.tailSeconds = *tail;
    busy.store(true);
    cancel.store(false);
    pool.addJob([snapshot = std::move(snapshot), options, wet, folder, &bridge, &busy, &cancel]() mutable {
        juce::ErasedScopeGuard releaseSlot{[&busy] { busy.store(false); }};
        const auto count = static_cast<int>(snapshot.tracks.size());
        const auto result = renderTrackBatch(std::move(snapshot), folder, options, wet,
            [&](double pct, const char* stage, int index, int total, const juce::String& name) {
                auto* track = new juce::DynamicObject();
                track->setProperty("index", index);
                track->setProperty("count", total);
                track->setProperty("name", name);
                mixdown_bridge::broadcastProgress(bridge, pct, stage, juce::var(track));
            }, cancel);
        releaseSlot.reset();
        if (result.failure)
            mixdown_bridge::broadcastFailed(bridge, *result.failure, result.message);
        else
        {
            auto* ready = new juce::DynamicObject();
            ready->setProperty("folder", result.folder.getFullPathName());
            ready->setProperty("trackCount", count);
            bridge.broadcast("TRACK_EXPORT_READY", juce::var(ready));
        }
    });
}

void handleMixdownStart(const juce::var& payload, silverdaw::AudioEngine& engine,
                        silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                        juce::ThreadPool& peakPool, const silverdaw::DecodedCache& decodedCache,
                        std::atomic<bool>& mixdownBusy, std::atomic<bool>& mixdownCancel)
{
    // Double-clicks must not start a second offline render.
    if (mixdownBusy.load())
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("code", juce::String("invalid"));
        obj->setProperty("error", juce::String("A mixdown is already in progress."));
        bridge.broadcast("MIXDOWN_FAILED", juce::var(obj));
        return;
    }
    // Keep the live audio device silent during offline render.
    engine.pause();

    const auto outputPath = tryGetRequiredString(payload, "outputPath").value_or(juce::String{});
    const int outputSampleRate = static_cast<int>(payload.getProperty("sampleRate", 44100));
    const auto formatStr = tryGetRequiredString(payload, "format").value_or(juce::String("wav"));
    const auto lengthMode = tryGetRequiredString(payload, "lengthMode").value_or(juce::String("trim-to-last-clip"));
    const double startMsHint = static_cast<double>(payload.getProperty("startMs", 0.0));
    const double lengthMsHint = static_cast<double>(payload.getProperty("lengthMs", 0.0));
    const int bitrateKbps = static_cast<int>(payload.getProperty("bitrateKbps", 192));
    // Optional for older renderer builds; validated before rendering.
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

    // Snapshot on the message thread before worker dispatch.
    auto snapshot = prepareRenderSnapshot(engine, projectState, decodedCache, SnapshotScope::AudibleMix);
    if (snapshot.tracks.empty())
    {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("code", juce::String("invalid"));
        obj->setProperty("error", juce::String("Project has no clips to mix down."));
        bridge.broadcast("MIXDOWN_FAILED", juce::var(obj));
        return;
    }

    silverdaw::MixdownOptions options;
    options.outputFile = juce::File(outputPath);
    options.outputSampleRate = outputSampleRate;
    // Unknown format falls back to WAV to avoid binary mismatch.
    if (formatStr == "mp3")
        options.format = silverdaw::MixdownOptions::Format::Mp3;
    else if (formatStr == "flac")
        options.format = silverdaw::MixdownOptions::Format::Flac;
    else if (formatStr == "aiff")
        options.format = silverdaw::MixdownOptions::Format::Aiff;
    else
        options.format = silverdaw::MixdownOptions::Format::Wav;

    // Reject unsupported bit depths instead of silently quantising.
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
            break;
    }
    options.bitDepth = bitDepthRaw;
    // Reject tail outside the engine clamp range so the user gets a clear error.
    if (! std::isfinite(tailSecondsRaw) || tailSecondsRaw < 0.0 || tailSecondsRaw > 60.0)
    {
        rejectInvalid("tailSeconds must be in [0, 60] (got " +
                      juce::String(tailSecondsRaw, 3) + ").");
        return;
    }
    options.tailSeconds = tailSecondsRaw;
    options.dither = ditherRaw;
    options.bitrateKbps = bitrateKbps;

    // Normalize requires explicit loudness targets; analyze only validates ranges.
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
    // Clamp non-negative; the renderer further clamps to the project length.
    options.startMs = startMsHint > 0.0 ? startMsHint : 0.0;
    const auto md = payload.getProperty("metadata", juce::var());
    if (md.isObject())
    {
        options.metadata.title   = readOptionalString(md, "title").value_or(juce::String{});
        options.metadata.artist  = readOptionalString(md, "artist").value_or(juce::String{});
        options.metadata.album   = readOptionalString(md, "album").value_or(juce::String{});
        options.metadata.year    = readOptionalString(md, "year").value_or(juce::String{});
        options.metadata.genre   = readOptionalString(md, "genre").value_or(juce::String{});
        options.metadata.comment = readOptionalString(md, "comment").value_or(juce::String{});
    }

    silverdaw::renderMixdownAsync(std::move(snapshot), std::move(options),
                                  peakPool, bridge,
                                  mixdownCancel, mixdownBusy);
}

void handleMixdownCancel(std::atomic<bool>& mixdownBusy, std::atomic<bool>& mixdownCancel)
{
    if (!mixdownBusy.load())
    {
        silverdaw::log::info("bridge", "MIXDOWN_CANCEL ignored — no render in progress");
        return;
    }
    silverdaw::log::info("bridge", "recv MIXDOWN_CANCEL");
    mixdownCancel.store(true);
}

} // namespace silverdaw
