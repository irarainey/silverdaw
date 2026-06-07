#include "MixdownCommands.h"

#include <cmath>

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "DecodedCache.h"
#include "EnginePlaybackPath.h"
#include "Log.h"
#include "MixdownEngine.h"
#include "PayloadHelpers.h"
#include "ProjectState.h"

namespace silverdaw
{

using silverdaw::bridge::tryGetRequiredString;

void handleMixdownStart(const juce::var& payload, silverdaw::AudioEngine& engine,
                        silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge,
                        juce::ThreadPool& peakPool, const silverdaw::DecodedCache& decodedCache,
                        std::atomic<bool>& mixdownBusy, std::atomic<bool>& mixdownCancel)
{
    // Render a project mixdown offline. Heavy work runs on the
    // peakPool; results stream back via MIXDOWN_PROGRESS /
    // MIXDOWN_DONE / MIXDOWN_FAILED. Idempotent under double-
    // click — if a render is already in flight, reject the new
    // request with an `invalid` failure rather than starting a
    // second one.
    if (mixdownBusy.load())
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
