#include "MixdownEngine.h"

#include "AudioEngine.h"   // for silverdaw::OffsetSource
#include "BridgeServer.h"
#include "Log.h"
#include "ProjectState.h"
#include "WarpProcessor.h" // for parseWarpMode + WarpProcessor

#include <algorithm>
#include <cmath>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>

#include <samplerate.h>

#if JUCE_WINDOWS
#include <windows.h>
#endif

// ─────────────────────────────────────────────────────────────────────────────
// MixdownEngine — offline render.
//
// Topology mirrors the live engine exactly. Each clip drives the same per-clip
// source graph the audio thread drives during playback:
//
//   AudioFormatReader
//    → AudioFormatReaderSource           (at source sample rate)
//    → OffsetSource(WarpProcessor)       (timeline window + warp at source rate)
//    → AudioTransportSource              (no read-ahead, source→projectRate via
//                                         JUCE's internal ResamplingAudioSource)
//    → [future per-clip processor chain insert — at project rate]
//    → mix bus                           (stereo at projectRate)
//    → libsamplerate (project→outputRate, only when they differ)
//    → WAV writer
//
// Sharing OffsetSource + WarpProcessor with the live engine means warped clips
// in the exported file are produced by the exact same code path that produces
// them at playback time: same priming, same start-delay discard, same mode
// flags, same ratio interpretation. Any future clip-level processor (reverb,
// EQ, compressor) gets inserted in one place and is used identically in both
// live and offline.
// ─────────────────────────────────────────────────────────────────────────────

namespace silverdaw
{

const char* mixdownFailureCodeToString(MixdownFailureCode code) noexcept
{
    switch (code)
    {
        case MixdownFailureCode::Cancelled: return "cancelled";
        case MixdownFailureCode::Io:        return "io";
        case MixdownFailureCode::Decode:    return "decode";
        case MixdownFailureCode::Encode:    return "encode";
        case MixdownFailureCode::Invalid:   return "invalid";
    }
    return "invalid";
}

namespace
{

// Bounded so WarpProcessor's internal 64-iteration safety cap is never the
// limiting factor — matches the live engine's typical block sizes and gives
// tight cancellation granularity.
constexpr int kBlockFrames = 4096;
// Min spacing between progress envelopes so the bridge isn't flooded.
constexpr int kProgressMinIntervalMs = 50;
constexpr int kOutputChannels = 2;
constexpr int kWavBitsPerSample = 16;
// Output capacity headroom for libsamplerate's final pass. Sized for the
// largest expected upsample ratio (e.g. 44.1 → 48 kHz is ~1.09×).
constexpr int kFinalResampleHeadroom = 16;

double clipTimelineEndMs(const MixdownSnapshot::ClipSnapshot& clip) noexcept
{
    const double eff = clip.warpEnabled
                           ? (clip.effectiveDurationMs > 0.0
                                  ? clip.effectiveDurationMs
                                  : clip.durationMs / juce::jmax(0.0001, clip.tempoRatio))
                           : clip.durationMs;
    return clip.offsetMs + eff;
}

void broadcastProgress(BridgeServer& bridge, double percent, const char* stage)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("percent", juce::jlimit(0.0, 100.0, percent));
    obj->setProperty("stage", juce::String(stage));
    bridge.broadcast("MIXDOWN_PROGRESS", juce::var(obj));
}

void broadcastDone(BridgeServer& bridge, const juce::File& outputFile, double durationMs)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("filePath", outputFile.getFullPathName());
    obj->setProperty("durationMs", durationMs);
    bridge.broadcast("MIXDOWN_DONE", juce::var(obj));
}

void broadcastFailed(BridgeServer& bridge, MixdownFailureCode code, const juce::String& error)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("code", juce::String(mixdownFailureCodeToString(code)));
    obj->setProperty("error", error);
    bridge.broadcast("MIXDOWN_FAILED", juce::var(obj));
}

// Atomic "<file>.tmp" → "<file>" finalize. Same code as before.
bool atomicReplace(const juce::File& tmp, const juce::File& target)
{
#if JUCE_WINDOWS
    const auto tmpStr = tmp.getFullPathName().toWideCharPointer();
    const auto targetStr = target.getFullPathName().toWideCharPointer();
    return ::MoveFileExW(tmpStr, targetStr,
                         MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
#else
    target.deleteFile();
    return tmp.moveFileTo(target);
#endif
}

/**
 * Per-clip offline source chain. Owns the exact same JUCE graph nodes the
 * live engine uses, just driven from this worker thread instead of the audio
 * thread. `pull()` fills a stereo buffer at projectRate; the resampling +
 * warp + timeline-windowing all happen inside the wrapped JUCE chain.
 *
 * The chain holds a non-owning pointer to WarpProcessor (mirroring live —
 * OffsetSource doesn't own it), so the unique_ptr for the warp processor
 * must outlive the offsetSource. Destruction order in the struct (members
 * are destroyed in reverse declaration order) is chosen so the transport
 * tears down first, then the offsetSource, then the warp processor, then
 * the reader source — matching the live engine's teardown order.
 */
struct OfflineClip
{
    juce::String id;
    float trackGain{1.0F};
    double sourceRate{0.0};
    int sourceChannels{1};
    /** Timeline frames at projectRate at which this clip is finished — once
     *  the master cursor passes this we stop pulling from this clip. */
    juce::int64 timelineEndFrames{0};
    /** Set true once the timeline cursor has cleared timelineEndFrames AND
     *  any internal tail has been drained. Retired clips are skipped in the
     *  pump loop and their chain is left in place until the engine tears
     *  down — keeping it alive is cheap (handles, no audio work). */
    bool retired{false};

    // Declared in chain order; destroyed in reverse — see comment above.
    std::unique_ptr<juce::AudioFormatReaderSource> readerSource;
    std::unique_ptr<WarpProcessor> warp;
    std::unique_ptr<OffsetSource> offsetSource;
    std::unique_ptr<juce::AudioTransportSource> transport;
};

/**
 * Build one OfflineClip from the snapshot entry. Returns nullptr on failure
 * (the caller decides how to surface that). `formatManager` must outlive the
 * returned clip.
 */
std::unique_ptr<OfflineClip> buildOfflineClip(const MixdownSnapshot::ClipSnapshot& clip,
                                              float trackGain,
                                              int projectSampleRate,
                                              juce::AudioFormatManager& formatManager,
                                              juce::String& outError)
{
    auto out = std::make_unique<OfflineClip>();
    out->id = clip.id;
    out->trackGain = trackGain;

    const juce::File sourceFile(clip.filePath);
    auto* reader = formatManager.createReaderFor(sourceFile);
    if (reader == nullptr)
    {
        outError = "createReaderFor failed for clip " + clip.id + " path=" + clip.filePath;
        return nullptr;
    }
    out->sourceRate = reader->sampleRate;
    out->sourceChannels = juce::jmax(1, static_cast<int>(reader->numChannels));
    if (out->sourceRate <= 0.0)
    {
        outError = "Source sample rate is zero for clip " + clip.id;
        delete reader;
        return nullptr;
    }

    // ReaderSource takes ownership of the reader (deleteWhenRemoved=true).
    out->readerSource = std::make_unique<juce::AudioFormatReaderSource>(reader, true);

    // OffsetSource positions are SOURCE-rate frames — identical convention
    // to AudioEngine::addClip. AudioTransportSource's internal resampler
    // maps render-rate (projectRate) cursors back to source-rate cursors,
    // so the offset/in/duration we set here are observed correctly when
    // the transport advances.
    out->offsetSource = std::make_unique<OffsetSource>(out->readerSource.get());
    out->offsetSource->setOffsetSamples(
        static_cast<juce::int64>(clip.offsetMs * out->sourceRate / 1000.0));
    out->offsetSource->setInSourceSamples(
        static_cast<juce::int64>(clip.inMs * out->sourceRate / 1000.0));
    out->offsetSource->setClipDurationSamples(
        static_cast<juce::int64>(clip.durationMs * out->sourceRate / 1000.0));

    if (clip.warpEnabled)
    {
        // Same constructor invocation pattern as AudioEngine::makeWarpProcessor.
        // WarpProcessor is at SOURCE rate so its priming, start-delay and
        // transient analysis windows are identical to live.
        out->warp = std::make_unique<WarpProcessor>(out->sourceChannels,
                                                    out->sourceRate,
                                                    parseWarpMode(clip.warpMode));
        out->warp->prepareToPlay(kBlockFrames);
        if (clip.tempoRatio > 0.0) out->warp->setTempoRatio(clip.tempoRatio);
        const double pitchScale =
            std::pow(2.0, (clip.semitones + (clip.cents / 100.0)) / 12.0);
        out->warp->setPitchScale(pitchScale);
        out->offsetSource->setWarpProcessor(out->warp.get());
        out->offsetSource->requestWarpReseek();
    }

    out->transport = std::make_unique<juce::AudioTransportSource>();
    // readAhead=0, no background thread — offline rendering wants
    // deterministic synchronous reads. The transport still gets the
    // sourceSampleRateToCorrectFor argument so JUCE inserts its
    // internal ResamplingAudioSource between OffsetSource (source rate)
    // and us (project rate).
    out->transport->setSource(out->offsetSource.get(),
                              0, nullptr,
                              out->sourceRate, out->sourceChannels);
    out->transport->prepareToPlay(kBlockFrames, static_cast<double>(projectSampleRate));
    out->transport->setPosition(0.0);
    out->transport->start();

    // Compute timeline end in projectRate frames so the pump loop can
    // retire the clip when its window closes.
    const double endMs = clipTimelineEndMs(clip);
    out->timelineEndFrames =
        static_cast<juce::int64>(std::ceil(endMs * static_cast<double>(projectSampleRate) / 1000.0));

    silverdaw::log::info(
        "mixdown",
        "offline clip built id=" + clip.id +
            " sourceRate=" + juce::String(out->sourceRate, 1) +
            " channels=" + juce::String(out->sourceChannels) +
            " offsetMs=" + juce::String(clip.offsetMs, 1) +
            " inMs=" + juce::String(clip.inMs, 1) +
            " durationMs=" + juce::String(clip.durationMs, 1) +
            " warp=" + (clip.warpEnabled ? juce::String("on") : juce::String("off")) +
            (clip.warpEnabled ? (" tempoRatio=" + juce::String(clip.tempoRatio, 4) +
                                  " effDurationMs=" + juce::String(clip.effectiveDurationMs, 1) +
                                  " mode=" + clip.warpMode)
                              : juce::String()));
    return out;
}

/**
 * Pull one block of stereo audio at projectRate from `clip`, sum into mixL/mixR
 * with `clip.trackGain` applied. Mono sources are duplicated L→R; sources with
 * more than 2 channels use the first two. The transport's read-position
 * advances by exactly `blockFrames` whether we sum its output or not, so the
 * clip stays sample-aligned with the master timeline even when retired.
 */
void mixClipBlock(OfflineClip& clip,
                  juce::AudioBuffer<float>& clipScratch,
                  float* mixL, float* mixR, int blockFrames)
{
    if (clip.retired) return;
    clipScratch.clear();
    juce::AudioSourceChannelInfo info(&clipScratch, 0, blockFrames);
    clip.transport->getNextAudioBlock(info);

    // The transport fills as many channels as the source has (up to the
    // buffer's channel count). For mono, channel 1 is left zero by us —
    // duplicate ch0 → ch1 so the mix bus gets balanced stereo.
    const float* l = clipScratch.getReadPointer(0);
    const float* r = clip.sourceChannels >= 2 ? clipScratch.getReadPointer(1)
                                              : clipScratch.getReadPointer(0);
    const float g = clip.trackGain;
    for (int i = 0; i < blockFrames; ++i)
    {
        mixL[i] += l[i] * g;
        mixR[i] += r[i] * g;
    }
}

/**
 * Streaming libsamplerate sink used for the final projectRate→outputRate pass.
 * Maintains the input cursor across calls and properly handles the case where
 * `src_process` consumes fewer input frames than supplied (a real streaming
 * bug in the old implementation — leftover frames were silently dropped,
 * causing compounding drift in long renders).
 *
 * Use:
 *   FinalResampler r(srcRate, dstRate);
 *   for each block: r.push(mixInterleaved, frames, isLast, writeCallback);
 *   r.flush(writeCallback); // after last push with isLast=true
 *
 * `writeCallback(const float* interleaved, int frames)` is invoked for every
 * batch of output frames produced. Throws nothing; returns false if the
 * resampler had a hard error (callers should treat as fatal).
 */
class FinalResampler
{
public:
    FinalResampler(int srcRate, int dstRate) : srcRate_(srcRate), dstRate_(dstRate)
    {
        if (srcRate_ != dstRate_)
        {
            int err = 0;
            state_ = src_new(SRC_SINC_MEDIUM_QUALITY, kOutputChannels, &err);
            if (state_ == nullptr)
            {
                lastError_ = src_strerror(err);
            }
        }
    }
    ~FinalResampler() { if (state_) src_delete(state_); }

    bool ok() const { return srcRate_ == dstRate_ || state_ != nullptr; }
    const char* error() const { return lastError_; }
    bool active() const { return state_ != nullptr; }

    template <typename WriteFn>
    bool push(const float* interleaved, int inputFrames, bool endOfInput, WriteFn&& write)
    {
        if (state_ == nullptr)
        {
            // Pass-through — no resampling needed.
            return write(interleaved, inputFrames);
        }
        const double ratio = static_cast<double>(dstRate_) / static_cast<double>(srcRate_);
        int consumed = 0;
        // Loop until libsamplerate has consumed every input frame. Without
        // this loop, output-buffer pressure can leave input_frames_used <
        // input_frames and the leftover would be silently dropped — that
        // was a confirmed source of timeline drift in the previous
        // implementation.
        while (consumed < inputFrames || endOfInput)
        {
            const int remainingInput = inputFrames - consumed;
            const int outputCap =
                static_cast<int>(std::ceil(juce::jmax(remainingInput, 1) * ratio))
                + kFinalResampleHeadroom;
            scratch_.resize(static_cast<size_t>(outputCap) * 2);

            SRC_DATA d{};
            d.data_in = (remainingInput > 0)
                            ? interleaved + static_cast<std::ptrdiff_t>(consumed) * 2
                            : nullptr;
            d.input_frames = remainingInput;
            d.data_out = scratch_.data();
            d.output_frames = outputCap;
            d.end_of_input = endOfInput ? 1 : 0;
            d.src_ratio = ratio;

            const int err = src_process(state_, &d);
            if (err != 0)
            {
                lastError_ = src_strerror(err);
                return false;
            }
            consumed += static_cast<int>(d.input_frames_used);

            if (d.output_frames_gen > 0)
            {
                if (!write(scratch_.data(), static_cast<int>(d.output_frames_gen)))
                {
                    return false;
                }
            }

            // Termination: if we've consumed everything and either we're
            // not flushing, or we are flushing but libsamplerate produced
            // no further output, we're done with this call.
            if (consumed >= inputFrames
                && (!endOfInput || d.output_frames_gen == 0))
            {
                break;
            }
            // Guard against pathological loops: if no progress at all, bail
            // out rather than spin forever. Shouldn't happen with a
            // well-sized output buffer but worth keeping honest.
            if (d.input_frames_used == 0 && d.output_frames_gen == 0)
            {
                break;
            }
        }
        return true;
    }

private:
    int srcRate_{0};
    int dstRate_{0};
    SRC_STATE* state_{nullptr};
    std::vector<float> scratch_;
    const char* lastError_{nullptr};
};

} // anonymous namespace

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot (unchanged from previous implementation)
// ─────────────────────────────────────────────────────────────────────────────

MixdownSnapshot snapshotProjectForMixdown(const ProjectState& project)
{
    MixdownSnapshot snapshot;
    const int explicitRate = project.getTargetSampleRate();
    snapshot.projectSampleRate = (explicitRate == 44100 || explicitRate == 48000)
                                     ? explicitRate
                                     : 44100;

    static const juce::Identifier kTrack{"TRACK"};
    static const juce::Identifier kClip{"CLIP"};
    static const juce::Identifier kLibrary{"LIBRARY"};
    static const juce::Identifier kId{"id"};
    static const juce::Identifier kGain{"gain"};
    static const juce::Identifier kLibraryItemId{"libraryItemId"};
    static const juce::Identifier kOffsetMs{"offsetMs"};
    static const juce::Identifier kInMs{"inMs"};
    static const juce::Identifier kDurationMs{"durationMs"};
    static const juce::Identifier kWarpEnabled{"warpEnabled"};
    static const juce::Identifier kWarpMode{"warpMode"};
    static const juce::Identifier kSemitones{"semitones"};
    static const juce::Identifier kCents{"cents"};
    static const juce::Identifier kSampleRate{"sampleRate"};
    static const juce::Identifier kChannelCount{"channelCount"};

    const auto root = project.getTree();
    if (!root.isValid()) return snapshot;

    for (int t = 0; t < root.getNumChildren(); ++t)
    {
        const auto trackTree = root.getChild(t);
        if (!trackTree.hasType(kTrack)) continue;
        MixdownSnapshot::TrackSnapshot track;
        track.id = trackTree.getProperty(kId).toString();
        track.gain = project.getEffectiveTrackGain(track.id);

        const bool trackMuted = project.getTrackMuted(track.id);
        const bool trackSoloed = project.getTrackSoloed(track.id);
        silverdaw::log::info(
            "mixdown",
            "snapshot track=" + track.id + " volume=" +
                juce::String(static_cast<double>(trackTree.getProperty(kGain, 1.0)), 4) +
                " muted=" + (trackMuted ? juce::String("true") : juce::String("false")) +
                " soloed=" + (trackSoloed ? juce::String("true") : juce::String("false")) +
                " effectiveGain=" + juce::String(track.gain, 4) +
                (track.gain <= 0.0F ? " (silent — skipped)" : ""));
        if (track.gain <= 0.0F) continue;

        for (int c = 0; c < trackTree.getNumChildren(); ++c)
        {
            const auto clipTree = trackTree.getChild(c);
            if (!clipTree.hasType(kClip)) continue;
            MixdownSnapshot::ClipSnapshot clip;
            clip.id = clipTree.getProperty(kId).toString();
            const auto libraryItemId = clipTree.getProperty(kLibraryItemId).toString();
            // Prefer the decoded-WAV cache when available so the worker
            // doesn't have to decode MP3 / WMA inside the render loop.
            clip.filePath = project.getLibraryItemPlaybackPath(libraryItemId);
            if (clip.filePath.isEmpty()) clip.filePath = project.getLibraryItemFilePath(libraryItemId);
            clip.offsetMs = static_cast<double>(clipTree.getProperty(kOffsetMs, 0.0));
            clip.inMs = static_cast<double>(clipTree.getProperty(kInMs, 0.0));
            clip.durationMs = static_cast<double>(clipTree.getProperty(kDurationMs, 0.0));
            clip.warpEnabled = static_cast<bool>(clipTree.getProperty(kWarpEnabled, false));
            clip.warpMode = clipTree.getProperty(kWarpMode, "rhythmic").toString();
            // tempoRatio and effectiveDurationMs come from the authoritative
            // `getClipEffectiveTiming` helper. Reading kTempoRatio directly
            // from the ValueTree with a default of 1.0 was a previous bug —
            // it ignored the "follow project BPM" case where the property
            // is absent and the live engine derives the ratio as
            // projectBpm/sourceBpm on the fly.
            const auto timing = project.getClipEffectiveTiming(clip.id);
            clip.tempoRatio = timing.tempoRatio > 0.0 ? timing.tempoRatio : 1.0;
            clip.semitones = static_cast<double>(clipTree.getProperty(kSemitones, 0.0));
            clip.cents = static_cast<double>(clipTree.getProperty(kCents, 0.0));
            clip.effectiveDurationMs = timing.durationMs > 0.0 ? timing.durationMs : clip.durationMs;

            // Pull the source's native rate from the library item — useful
            // for diagnostics; the renderer reads the authoritative rate
            // off the reader at build time.
            const auto library = root.getChildWithName(kLibrary);
            if (library.isValid())
            {
                for (int li = 0; li < library.getNumChildren(); ++li)
                {
                    const auto item = library.getChild(li);
                    if (item.getProperty(kId).toString() == libraryItemId)
                    {
                        clip.sourceSampleRate =
                            static_cast<int>(item.getProperty(kSampleRate, 0));
                        clip.sourceChannelCount =
                            static_cast<int>(item.getProperty(kChannelCount, 0));
                        break;
                    }
                }
            }

            if (clip.filePath.isNotEmpty() && clip.durationMs > 0.0)
            {
                silverdaw::log::info(
                    "mixdown",
                    "snapshot clip=" + clip.id +
                        " offsetMs=" + juce::String(clip.offsetMs, 1) +
                        " inMs=" + juce::String(clip.inMs, 1) +
                        " durationMs=" + juce::String(clip.durationMs, 1) +
                        " warpEnabled=" + (clip.warpEnabled ? juce::String("true") : juce::String("false")) +
                        " tempoRatio=" + juce::String(clip.tempoRatio, 4) +
                        " effectiveDurationMs=" + juce::String(clip.effectiveDurationMs, 1) +
                        " semitones=" + juce::String(clip.semitones, 2) +
                        " cents=" + juce::String(clip.cents, 2) +
                        " warpMode=" + clip.warpMode);
                track.clips.push_back(std::move(clip));
            }
        }
        if (!track.clips.empty()) snapshot.tracks.push_back(std::move(track));
    }
    return snapshot;
}

double computeLastClipEndMs(const MixdownSnapshot& snapshot)
{
    double maxEnd = 0.0;
    for (const auto& track : snapshot.tracks)
    {
        for (const auto& clip : track.clips)
        {
            maxEnd = juce::jmax(maxEnd, clipTimelineEndMs(clip));
        }
    }
    return maxEnd;
}

// ─────────────────────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────────────────────

void renderMixdownAsync(MixdownSnapshot snapshot,
                        MixdownOptions options,
                        juce::ThreadPool& pool,
                        BridgeServer& bridge,
                        std::atomic<bool>& cancelFlag,
                        std::atomic<bool>& busyFlag)
{
    busyFlag.store(true);
    cancelFlag.store(false);

    pool.addJob([snapshot = std::move(snapshot),
                 options = std::move(options),
                 &bridge,
                 &cancelFlag,
                 &busyFlag]() mutable
    {
        struct BusyGuard
        {
            std::atomic<bool>& flag;
            ~BusyGuard() { flag.store(false); }
        } busyGuard{busyFlag};

        const auto failWith = [&](MixdownFailureCode code, const juce::String& message)
        {
            silverdaw::log::warn("mixdown", "fail code=" + juce::String(mixdownFailureCodeToString(code)) +
                                                 " msg=" + message);
            broadcastFailed(bridge, code, message);
        };

        if (options.format == MixdownOptions::Format::Mp3)
        {
            failWith(MixdownFailureCode::Invalid,
                     "MP3 export is not yet available — please select WAV.");
            return;
        }

        if (snapshot.tracks.empty())
        {
            failWith(MixdownFailureCode::Invalid, "No clips to render.");
            return;
        }
        if (options.lengthMs <= 0.0)
        {
            failWith(MixdownFailureCode::Invalid, "Mixdown length must be positive.");
            return;
        }
        if (options.outputSampleRate != 44100 && options.outputSampleRate != 48000)
        {
            failWith(MixdownFailureCode::Invalid,
                     "Unsupported output sample rate " + juce::String(options.outputSampleRate));
            return;
        }

        broadcastProgress(bridge, 0.0, "prepare");

        // Open writer on `<file>.tmp` so the rename is atomic and
        // same-volume on Windows.
        const auto targetFile = options.outputFile;
        const auto parentDir = targetFile.getParentDirectory();
        if (!parentDir.exists() && !parentDir.createDirectory())
        {
            failWith(MixdownFailureCode::Io,
                     "Cannot create output folder: " + parentDir.getFullPathName());
            return;
        }
        const auto tmpFile = parentDir.getChildFile(targetFile.getFileName() + ".tmp");
        tmpFile.deleteFile();

        juce::AudioFormatManager formatManager;
        formatManager.registerBasicFormats();

        auto outStream = std::make_unique<juce::FileOutputStream>(tmpFile);
        if (!outStream->openedOk())
        {
            failWith(MixdownFailureCode::Io,
                     "Cannot open output file for writing: " + tmpFile.getFullPathName());
            return;
        }
        juce::WavAudioFormat wav;
        std::unique_ptr<juce::AudioFormatWriter> writer(
            wav.createWriterFor(outStream.release(),
                                static_cast<double>(options.outputSampleRate),
                                static_cast<unsigned int>(kOutputChannels),
                                kWavBitsPerSample,
                                {},
                                0));
        if (writer == nullptr)
        {
            failWith(MixdownFailureCode::Io, "Failed to create WAV writer.");
            return;
        }

        // Build the per-clip offline chains. We pre-build every clip because
        // even large projects have tens of clips, not thousands — keeping
        // their readers open for the duration of the render is well within
        // OS handle limits and avoids stop-the-world reader construction
        // mid-render.
        std::vector<std::unique_ptr<OfflineClip>> clips;
        clips.reserve(snapshot.tracks.size() * 8);
        for (const auto& track : snapshot.tracks)
        {
            for (const auto& clip : track.clips)
            {
                if (cancelFlag.load())
                {
                    failWith(MixdownFailureCode::Cancelled, "Cancelled.");
                    return;
                }
                juce::String err;
                auto built = buildOfflineClip(clip, track.gain,
                                              snapshot.projectSampleRate,
                                              formatManager, err);
                if (built == nullptr)
                {
                    failWith(MixdownFailureCode::Decode,
                             "Could not open source for clip " + clip.id +
                                 (err.isNotEmpty() ? juce::String(": ") + err : juce::String("")));
                    return;
                }
                clips.push_back(std::move(built));
            }
        }

        FinalResampler finalResampler(snapshot.projectSampleRate, options.outputSampleRate);
        if (!finalResampler.ok())
        {
            failWith(MixdownFailureCode::Invalid,
                     juce::String("Cannot init output resampler: ") + finalResampler.error());
            return;
        }

        const double projectFramesPerMs = snapshot.projectSampleRate / 1000.0;
        const int64_t totalProjectFrames =
            static_cast<int64_t>(std::round(options.lengthMs * projectFramesPerMs));
        int64_t projectFramesRendered = 0;
        int64_t outputFramesWritten = 0;
        double peakAmplitude = 0.0;
        int64_t lastProgressMs = juce::Time::getMillisecondCounter();
        juce::String writerError;

        // Pre-allocated buffers. Reused every block to avoid per-block
        // allocation; sized for kOutputChannels stereo at kBlockFrames.
        juce::AudioBuffer<float> mixBus(kOutputChannels, kBlockFrames);
        juce::AudioBuffer<float> clipScratch(kOutputChannels, kBlockFrames);
        std::vector<float> mixInterleaved(static_cast<size_t>(kBlockFrames) * 2);

        // Writer-callback used by FinalResampler. Captures `writer`, the
        // total written counter, peakAmplitude, and writerError so we can
        // unwind cleanly on IO failure mid-stream.
        const auto writeStereo = [&](const float* interleaved, int frames) -> bool
        {
            if (frames <= 0) return true;
            // Deinterleave for AudioFormatWriter::writeFromFloatArrays.
            std::vector<float> outL(static_cast<size_t>(frames));
            std::vector<float> outR(static_cast<size_t>(frames));
            for (int i = 0; i < frames; ++i)
            {
                outL[static_cast<size_t>(i)] = interleaved[static_cast<size_t>(i) * 2 + 0];
                outR[static_cast<size_t>(i)] = interleaved[static_cast<size_t>(i) * 2 + 1];
            }
            const float* writePtrs[kOutputChannels] = {outL.data(), outR.data()};
            if (!writer->writeFromFloatArrays(writePtrs, kOutputChannels, frames))
            {
                writerError = "Writer failed mid-stream.";
                return false;
            }
            outputFramesWritten += frames;
            return true;
        };

        // Main pump loop. Each iteration: pull a block from every active
        // clip's transport, sum into the mix bus, clip/peak-meter, then
        // hand off to FinalResampler → writer.
        while (projectFramesRendered < totalProjectFrames)
        {
            if (cancelFlag.load())
            {
                tmpFile.deleteFile();
                failWith(MixdownFailureCode::Cancelled, "Cancelled.");
                return;
            }
            const int blockFrames = static_cast<int>(
                std::min<int64_t>(kBlockFrames, totalProjectFrames - projectFramesRendered));
            const bool isLastBlock =
                projectFramesRendered + blockFrames >= totalProjectFrames;

            mixBus.clear(0, blockFrames);
            float* mixL = mixBus.getWritePointer(0);
            float* mixR = mixBus.getWritePointer(1);

            for (auto& cp : clips)
            {
                if (cp->retired) continue;
                // Retire clips whose timeline window has fully closed. We
                // still need to pump them up to their end so the warp tail
                // and the resampler tail drain through the transport's
                // internal buffers; once projectFramesRendered passes
                // timelineEndFrames we can safely stop pulling.
                if (projectFramesRendered >= cp->timelineEndFrames)
                {
                    cp->retired = true;
                    continue;
                }
                mixClipBlock(*cp, clipScratch, mixL, mixR, blockFrames);
            }

            // Hard-clip and peak meter. Soft-saturation / proper master
            // limiting is a future job; we match the previous behaviour.
            for (int i = 0; i < blockFrames; ++i)
            {
                mixL[i] = juce::jlimit(-1.0F, 1.0F, mixL[i]);
                mixR[i] = juce::jlimit(-1.0F, 1.0F, mixR[i]);
                peakAmplitude = juce::jmax(peakAmplitude,
                                           static_cast<double>(std::abs(mixL[i])),
                                           static_cast<double>(std::abs(mixR[i])));
                mixInterleaved[static_cast<size_t>(i) * 2 + 0] = mixL[i];
                mixInterleaved[static_cast<size_t>(i) * 2 + 1] = mixR[i];
            }

            if (!finalResampler.push(mixInterleaved.data(), blockFrames,
                                     isLastBlock, writeStereo))
            {
                tmpFile.deleteFile();
                if (writerError.isNotEmpty())
                {
                    failWith(MixdownFailureCode::Io, writerError);
                }
                else
                {
                    failWith(MixdownFailureCode::Invalid,
                             juce::String("Final resample failed: ") +
                                 (finalResampler.error() ? finalResampler.error() : "unknown"));
                }
                return;
            }

            projectFramesRendered += blockFrames;

            const auto now = juce::Time::getMillisecondCounter();
            if (now - lastProgressMs >= kProgressMinIntervalMs)
            {
                const double pct = (static_cast<double>(projectFramesRendered)
                                    / static_cast<double>(juce::jmax<int64_t>(1, totalProjectFrames)))
                                   * 95.0;
                broadcastProgress(bridge, pct, "render");
                lastProgressMs = now;
            }
        }

        broadcastProgress(bridge, 96.0, "finalize");

        // Pad if the resampler under-delivered. With the streaming-correct
        // FinalResampler this should be rare and at most a handful of
        // samples — but we keep the safety net so the WAV duration matches
        // what the dialog said it would.
        const int64_t totalOutputFrames =
            static_cast<int64_t>(std::round(options.lengthMs * options.outputSampleRate / 1000.0));
        if (outputFramesWritten < totalOutputFrames)
        {
            const int64_t pad = totalOutputFrames - outputFramesWritten;
            std::vector<float> zeros(static_cast<size_t>(juce::jmin<int64_t>(pad, kBlockFrames)));
            const float* writePtrs[kOutputChannels] = {zeros.data(), zeros.data()};
            int64_t remaining = pad;
            while (remaining > 0)
            {
                const int chunk = static_cast<int>(juce::jmin<int64_t>(remaining, kBlockFrames));
                if (!writer->writeFromFloatArrays(writePtrs, kOutputChannels, chunk)) break;
                remaining -= chunk;
            }
        }

        // Tear down clip chains BEFORE writer flush so any background-thread
        // readers (none here — readAhead=0) are guaranteed closed. Ordered
        // explicitly via reverse-iteration because each clip's transport
        // must stop before its source is destroyed.
        for (auto it = clips.rbegin(); it != clips.rend(); ++it)
        {
            if (auto& cp = *it; cp != nullptr)
            {
                if (cp->transport) cp->transport->stop();
                if (cp->transport) cp->transport->setSource(nullptr);
                if (cp->offsetSource) cp->offsetSource->setWarpProcessor(nullptr);
            }
        }
        clips.clear();

        writer.reset(); // flushes and closes the underlying stream

        if (cancelFlag.load())
        {
            tmpFile.deleteFile();
            failWith(MixdownFailureCode::Cancelled, "Cancelled.");
            return;
        }

        if (!atomicReplace(tmpFile, targetFile))
        {
            tmpFile.deleteFile();
            failWith(MixdownFailureCode::Io,
                     "Could not finalise output file (rename failed). Path may be open in another app.");
            return;
        }

        broadcastProgress(bridge, 100.0, "finalize");
        silverdaw::log::info("mixdown",
                             "done filePath=" + targetFile.getFullPathName() +
                                 " durationMs=" + juce::String(options.lengthMs, 1) +
                                 " sampleRate=" + juce::String(options.outputSampleRate) +
                                 " peakAmp=" + juce::String(peakAmplitude, 4));
        broadcastDone(bridge, targetFile, options.lengthMs);
    });
}

} // namespace silverdaw
