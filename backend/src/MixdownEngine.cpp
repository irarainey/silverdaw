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
    /** Trailing tail length (in projectRate frames) the clip's processor
     *  chain needs to be pumped AFTER `timelineEndFrames` to fully drain
     *  late-arriving output samples (reverb decay, EQ smear, etc.). 0
     *  today — the warp processor's own start-delay is pre-discarded
     *  inside `WarpProcessor::doReset`, so warp adds no trailing tail.
     *  Scaffolding for the upcoming per-clip FX layer: when reverb is
     *  added, its decay tail (e.g. 4 s at projectRate) will land here
     *  and both `totalProjectFrames` and the retirement check below
     *  will automatically respect it. */
    juce::int64 tailFrames{0};
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
    const auto readerLengthSamples = reader->lengthInSamples;
    const auto sourceExt = sourceFile.getFileExtension().toLowerCase();
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
            " openedPath=" + clip.filePath +
            " ext=" + sourceExt +
            " readerSampleRate=" + juce::String(out->sourceRate, 1) +
            " readerChannels=" + juce::String(out->sourceChannels) +
            " readerLengthSamples=" + juce::String(readerLengthSamples) +
            " libSampleRate=" + juce::String(clip.sourceSampleRate) +
            " libChannels=" + juce::String(clip.sourceChannelCount) +
            " sampleRateMismatch=" +
                ((clip.sourceSampleRate > 0
                  && std::abs(out->sourceRate - static_cast<double>(clip.sourceSampleRate)) > 0.5)
                     ? juce::String("true")
                     : juce::String("false")) +
            " offsetMs=" + juce::String(clip.offsetMs, 1) +
            " inMs=" + juce::String(clip.inMs, 1) +
            " durationMs=" + juce::String(clip.durationMs, 1) +
            " trackGain=" + juce::String(trackGain, 4) +
            " warp=" + (clip.warpEnabled ? juce::String("on") : juce::String("off")) +
            (clip.warpEnabled ? (" tempoRatio=" + juce::String(clip.tempoRatio, 4) +
                                  " effDurationMs=" + juce::String(clip.effectiveDurationMs, 1) +
                                  " mode=" + clip.warpMode +
                                  " semitones=" + juce::String(clip.semitones, 2) +
                                  " cents=" + juce::String(clip.cents, 2))
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
                  float* mixL, float* mixR, int blockFrames,
                  bool logThisBlock = false)
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

    // Optional per-clip diagnostic — caller throttles via logThisBlock.
    // Captures pre-gain peak/RMS (what the transport+warp produced) and
    // post-gain peak/RMS (what gets summed into the mix bus). Compare
    // pre-gain across live vs mixdown to isolate transport/resampler
    // differences; compare post-gain to verify trackGain is correct.
    float preLPeak = 0.0F, preRPeak = 0.0F;
    double preLSq = 0.0, preRSq = 0.0;
    if (logThisBlock)
    {
        for (int i = 0; i < blockFrames; ++i)
        {
            const float al = std::fabs(l[i]);
            const float ar = std::fabs(r[i]);
            if (al > preLPeak) preLPeak = al;
            if (ar > preRPeak) preRPeak = ar;
            preLSq += static_cast<double>(l[i]) * l[i];
            preRSq += static_cast<double>(r[i]) * r[i];
        }
    }

    for (int i = 0; i < blockFrames; ++i)
    {
        mixL[i] += l[i] * g;
        mixR[i] += r[i] * g;
    }

    if (logThisBlock)
    {
        const double invN = blockFrames > 0 ? 1.0 / blockFrames : 0.0;
        const double preLRms  = std::sqrt(preLSq * invN);
        const double preRRms  = std::sqrt(preRSq * invN);
        silverdaw::log::debug(
            "mixdown",
            "clipBlock id=" + clip.id +
                " srcCh=" + juce::String(clip.sourceChannels) +
                " gain=" + juce::String(g, 4) +
                " preGainPeakL=" + juce::String(preLPeak, 4) +
                " preGainPeakR=" + juce::String(preRPeak, 4) +
                " preGainRmsL=" + juce::String(preLRms, 6) +
                " preGainRmsR=" + juce::String(preRRms, 6) +
                " postGainPeakL=" + juce::String(preLPeak * g, 4) +
                " postGainPeakR=" + juce::String(preRPeak * g, 4));
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
        // Match live's clamp policy in AudioEngine::addClip / setClipGain
        // (juce::jlimit(0.0F, 4.0F, ...)). Without this the export
        // applies whatever raw gain ProjectState carries and diverges
        // from playback for tracks whose user gain is outside [0, 4].
        const float rawEffectiveGain = project.getEffectiveTrackGain(track.id);
        track.gain = juce::jlimit(0.0F, 4.0F, rawEffectiveGain);

        const bool trackMuted = project.getTrackMuted(track.id);
        const bool trackSoloed = project.getTrackSoloed(track.id);
        silverdaw::log::info(
            "mixdown",
            "snapshot track=" + track.id + " volume=" +
                juce::String(static_cast<double>(trackTree.getProperty(kGain, 1.0)), 4) +
                " muted=" + (trackMuted ? juce::String("true") : juce::String("false")) +
                " soloed=" + (trackSoloed ? juce::String("true") : juce::String("false")) +
                " effectiveGainRaw=" + juce::String(rawEffectiveGain, 4) +
                " effectiveGainClamped=" + juce::String(track.gain, 4) +
                (track.gain <= 0.0F ? " (silent — skipped)" : ""));
        if (track.gain <= 0.0F) continue;

        for (int c = 0; c < trackTree.getNumChildren(); ++c)
        {
            const auto clipTree = trackTree.getChild(c);
            if (!clipTree.hasType(kClip)) continue;
            MixdownSnapshot::ClipSnapshot clip;
            clip.id = clipTree.getProperty(kId).toString();
            const auto libraryItemId = clipTree.getProperty(kLibraryItemId).toString();
            clip.libraryItemId = libraryItemId;
            // Prefer the decoded-WAV cache when available so the worker
            // doesn't have to decode MP3 / WMA inside the render loop.
            // NOTE: the dispatcher (Main.cpp) will overwrite this with
            // `resolveEnginePlaybackPath(...)` so live and mixdown open
            // the exact same bytes — keeps selective warp divergence
            // off the table when the stored playback path is stale.
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

        // Modern writer factory. Switches on format + bit-depth and
        // selects the right SampleFormat (integral for PCM/FLAC, IEEE
        // float for 32-bit WAV float). Using the AudioFormatWriterOptions
        // API rather than the deprecated metadata-var overload also kills
        // the JUCE C4996 deprecation warning we used to get.
        std::unique_ptr<juce::OutputStream> outStream = std::make_unique<juce::FileOutputStream>(tmpFile);
        if (! static_cast<juce::FileOutputStream*>(outStream.get())->openedOk())
        {
            failWith(MixdownFailureCode::Io,
                     "Cannot open output file for writing: " + tmpFile.getFullPathName());
            return;
        }

        const int chosenBitDepth = options.bitDepth;
        const bool wantFloatWav =
            options.format == MixdownOptions::Format::Wav && chosenBitDepth == 32;

        auto writerOptions = juce::AudioFormatWriterOptions{}
                                 .withSampleRate(static_cast<double>(options.outputSampleRate))
                                 .withNumChannels(kOutputChannels)
                                 .withBitsPerSample(chosenBitDepth)
                                 .withSampleFormat(wantFloatWav
                                                       ? juce::AudioFormatWriterOptions::SampleFormat::floatingPoint
                                                       : juce::AudioFormatWriterOptions::SampleFormat::integral);

        std::unique_ptr<juce::AudioFormatWriter> writer;
        if (options.format == MixdownOptions::Format::Wav)
        {
            juce::WavAudioFormat wav;
            writer = wav.createWriterFor(outStream, writerOptions);
        }
        else if (options.format == MixdownOptions::Format::Flac)
        {
            juce::FlacAudioFormat flac;
            writer = flac.createWriterFor(outStream, writerOptions);
        }

        if (writer == nullptr)
        {
            // Clean up the partial stream — createWriterFor only consumes
            // the unique_ptr on success.
            outStream.reset();
            tmpFile.deleteFile();
            const auto fmtName = options.format == MixdownOptions::Format::Flac
                                     ? juce::String("FLAC")
                                     : juce::String("WAV");
            failWith(MixdownFailureCode::Io,
                     "Failed to create " + fmtName + " writer (bitDepth=" +
                         juce::String(chosenBitDepth) + ", sr=" + juce::String(options.outputSampleRate) + ").");
            return;
        }
        // Belt-and-braces self-check: when float WAV was requested,
        // verify the writer actually opened in float mode (catches a
        // silent format-string regression should JUCE change the
        // semantics of withSampleFormat).
        if (wantFloatWav && ! writer->isFloatingPoint())
        {
            writer.reset();
            tmpFile.deleteFile();
            failWith(MixdownFailureCode::Io,
                     "WAV writer opened in PCM mode when 32-float was requested.");
            return;
        }
        silverdaw::log::info(
            "mixdown",
            juce::String("writer opened format=") +
                (options.format == MixdownOptions::Format::Flac ? "flac" : "wav") +
                " bitDepth=" + juce::String(chosenBitDepth) +
                " float=" + (writer->isFloatingPoint() ? "true" : "false") +
                " dither=" + (options.dither && chosenBitDepth == 16 && ! writer->isFloatingPoint()
                                  ? "true"
                                  : "false"));

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
        int64_t totalProjectFrames =
            static_cast<int64_t>(std::round(options.lengthMs * projectFramesPerMs));
        // Extend the render window by the worst-case clip tail so any
        // per-clip processor that adds trailing decay (reverb today =
        // 0; reverb later = e.g. 4 s) gets fully drained into the
        // mix. Without this the export would truncate the tail at
        // the timeline length even though we have data still in the
        // processor's internal buffers waiting to come out.
        int64_t maxTailFrames = 0;
        for (const auto& cp : clips)
        {
            maxTailFrames = std::max(maxTailFrames, cp->tailFrames);
        }
        // Additive user-controlled silence tail, clamped sensibly by
        // the dispatch handler (0..60 s). Lets reverb/delay clips
        // ring out past the timeline end even when no processor-
        // declared tail exists yet. We add it on top of the per-
        // clip processor tail because the user is asking for that
        // many extra seconds AFTER all processors have decayed.
        const double clampedTailSeconds = juce::jlimit(0.0, 60.0, options.tailSeconds);
        const int64_t userTailFrames = static_cast<int64_t>(
            std::round(clampedTailSeconds * static_cast<double>(snapshot.projectSampleRate)));
        totalProjectFrames += maxTailFrames + userTailFrames;
        // Effective rendered length (ms) seen by the user. Used for
        // expected-output-frame computation, progress denominator
        // and `MIXDOWN_DONE.durationMs`. Keep this single source of
        // truth so the file on disk, the dialog, and the log all
        // agree.
        const double effectiveRenderLengthMs =
            (static_cast<double>(totalProjectFrames) / projectFramesPerMs);
        int64_t projectFramesRendered = 0;
        int64_t outputFramesWritten = 0;
        double peakAmplitude = 0.0;
        double preClampPeakAmplitude = 0.0;
        int64_t clippedSampleCount = 0;
        int blockIndex = 0;
        int64_t lastProgressMs = juce::Time::getMillisecondCounter();
        juce::String writerError;

        // Pre-allocated buffers. Reused every block to avoid per-block
        // allocation; sized for kOutputChannels stereo at kBlockFrames.
        juce::AudioBuffer<float> mixBus(kOutputChannels, kBlockFrames);
        juce::AudioBuffer<float> clipScratch(kOutputChannels, kBlockFrames);
        std::vector<float> mixInterleaved(static_cast<size_t>(kBlockFrames) * 2);

        // TPDF dither state. Active only when the target file is a
        // 16-bit integer container (WAV-16 or FLAC-16). For 24-bit
        // the noise floor is well below audibility and dither is
        // skipped by default; for 32-float there's no quantisation
        // step at all so dither would be pure added noise.
        //
        // Implementation: per-channel xorshift32 PRNG, two
        // independent uniform draws per sample summed to form a
        // triangular PDF of peak amplitude ±1 LSB at 16-bit
        // (= ±1/32768 in normalised float). Seeded from juce::Random
        // so successive renders aren't bit-identical. Cheap enough
        // (~6 ns/sample) to leave on by default.
        const bool ditherActive = options.dither
                                  && options.bitDepth == 16
                                  && ! writer->isFloatingPoint();
        constexpr float kLsb16f = 1.0f / 32768.0f;
        struct Xorshift32 { uint32_t state; };
        const auto nextUniform = [](Xorshift32& s) -> float
        {
            uint32_t x = s.state;
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            s.state = x ? x : 1u;
            return static_cast<float>(s.state) * (1.0f / 4294967296.0f);
        };
        juce::Random seedGen;
        Xorshift32 rngL { static_cast<uint32_t>(seedGen.nextInt(juce::Range<int>(1, INT_MAX))) };
        Xorshift32 rngR { static_cast<uint32_t>(seedGen.nextInt(juce::Range<int>(1, INT_MAX))) };

        // Writer-callback used by FinalResampler. Captures `writer`, the
        // total written counter, peakAmplitude, and writerError so we can
        // unwind cleanly on IO failure mid-stream.
        const auto writeStereo = [&](const float* interleaved, int frames) -> bool
        {
            if (frames <= 0) return true;
            // Deinterleave for AudioFormatWriter::writeFromFloatArrays.
            std::vector<float> outL(static_cast<size_t>(frames));
            std::vector<float> outR(static_cast<size_t>(frames));
            if (ditherActive)
            {
                for (int i = 0; i < frames; ++i)
                {
                    // TPDF = (U1 + U2 - 1) * LSB, U1,U2 ∈ [0,1).
                    // Sum of two uniforms gives a triangular PDF.
                    // Independent draws per channel decorrelate the
                    // dither noise between L and R, avoiding a
                    // mid-summed mono image of the dither.
                    const float dL = (nextUniform(rngL) + nextUniform(rngL) - 1.0f) * kLsb16f;
                    const float dR = (nextUniform(rngR) + nextUniform(rngR) - 1.0f) * kLsb16f;
                    outL[static_cast<size_t>(i)] = interleaved[static_cast<size_t>(i) * 2 + 0] + dL;
                    outR[static_cast<size_t>(i)] = interleaved[static_cast<size_t>(i) * 2 + 1] + dR;
                }
            }
            else
            {
                for (int i = 0; i < frames; ++i)
                {
                    outL[static_cast<size_t>(i)] = interleaved[static_cast<size_t>(i) * 2 + 0];
                    outR[static_cast<size_t>(i)] = interleaved[static_cast<size_t>(i) * 2 + 1];
                }
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
            // Suppress denormal-float CPU stalls inside this block.
            // Once per-clip reverbs/EQs land downstream they will
            // routinely produce subnormals as they ring down; on
            // x86 those can be 20–100× slower than normal floats
            // and would dominate the offline render time.
            const juce::ScopedNoDenormals scopedNoDenormals;
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

            // Per-clip pre/post-gain logging stride: tie to the same
            // ~5 s cadence used for the mix-bus peak telemetry below
            // so the diagnostic lines line up in the log timeline.
            const int clipLogStride = juce::jmax(1,
                static_cast<int>(static_cast<double>(snapshot.projectSampleRate) * 5.0
                                 / static_cast<double>(kBlockFrames)));
            const bool logClipsThisBlock = (blockIndex % clipLogStride) == 0;

            for (auto& cp : clips)
            {
                if (cp->retired) continue;
                // Retire clips whose timeline window has fully closed. We
                // still need to pump them up to their end so the warp tail
                // and the resampler tail drain through the transport's
                // internal buffers; once projectFramesRendered passes
                // timelineEndFrames we can safely stop pulling.
                if (projectFramesRendered >= cp->timelineEndFrames + cp->tailFrames)
                {
                    cp->retired = true;
                    continue;
                }
                mixClipBlock(*cp, clipScratch, mixL, mixR, blockFrames,
                             logClipsThisBlock);
            }

            // Peak-meter without clipping. The live engine has NO
            // master limiter / hard clipper before the device, so
            // applying one here would systematically attenuate
            // exports of dense mixes vs what the user hears live.
            // We still count samples that would have clipped so the
            // diagnostic logs can flag inter-sample / over-0 dB
            // material in the render.
            double blockPeakL = 0.0;
            double blockPeakR = 0.0;
            for (int i = 0; i < blockFrames; ++i)
            {
                const double absL = std::abs(static_cast<double>(mixL[i]));
                const double absR = std::abs(static_cast<double>(mixR[i]));
                blockPeakL = juce::jmax(blockPeakL, absL);
                blockPeakR = juce::jmax(blockPeakR, absR);
                if (absL > 1.0 || absR > 1.0) ++clippedSampleCount;
                mixInterleaved[static_cast<size_t>(i) * 2 + 0] = mixL[i];
                mixInterleaved[static_cast<size_t>(i) * 2 + 1] = mixR[i];
            }
            const double blockPeak = juce::jmax(blockPeakL, blockPeakR);
            preClampPeakAmplitude = juce::jmax(preClampPeakAmplitude, blockPeak);
            peakAmplitude = preClampPeakAmplitude; // same now that we don't clip
            // Sparse per-block peak telemetry: every ~5 s of project
            // time at projectSampleRate. Cheap and gives a good
            // amplitude trace across the render.
            const int peakLogStride = juce::jmax(1,
                static_cast<int>(static_cast<double>(snapshot.projectSampleRate) * 5.0
                                 / static_cast<double>(kBlockFrames)));
            if ((blockIndex % peakLogStride) == 0)
            {
                silverdaw::log::debug(
                    "mixdown",
                    "block=" + juce::String(blockIndex) +
                        " projectFrame=" + juce::String(projectFramesRendered) +
                        " peakL=" + juce::String(blockPeakL, 4) +
                        " peakR=" + juce::String(blockPeakR, 4));
            }
            ++blockIndex;

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
                // Render owns 0–90% of the bar. The remaining 10% is
                // reserved for finalize — over-allocated relative to
                // wall-clock so the (potentially slow on Windows /
                // network drives) WAV flush + clip-chain teardown can
                // each have their own visible band on the bar instead
                // of all collapsing to a single "99%".
                const double pct = (static_cast<double>(projectFramesRendered)
                                    / static_cast<double>(juce::jmax<int64_t>(1, totalProjectFrames)))
                                   * 90.0;
                broadcastProgress(bridge, pct, "render");
                lastProgressMs = now;
            }
        }

        // Force a final render-stage broadcast so the bar reaches the
        // top of the render band even if the last in-loop update was
        // throttled out — otherwise we'd visibly jump up at the start
        // of finalize.
        broadcastProgress(bridge, 90.0, "render");

        // Pad if the resampler under-delivered. With the streaming-correct
        // FinalResampler this should be rare and at most a handful of
        // samples — but we keep the safety net so the WAV duration matches
        // what the dialog said it would.
        const auto finalizeStartMs = juce::Time::getMillisecondCounter();
        const int64_t totalOutputFrames =
            static_cast<int64_t>(std::round(effectiveRenderLengthMs * options.outputSampleRate / 1000.0));
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
        const auto padEndMs = juce::Time::getMillisecondCounter();
        broadcastProgress(bridge, 92.0, "finalize");

        // writer.reset() rewrites the WAV RIFF/data-size headers and
        // closes the underlying FileOutputStream. After this returns
        // the bytes are on disk; the only thing left before the user's
        // file is "the user's file" is the atomic rename.
        //
        // NOTE: we deliberately do NOT tear down the per-clip JUCE
        // chains before this. They are pure readers with
        // `readAhead=0` (no background buffering threads), so leaving
        // them alive cannot affect the writer's output. Destroying
        // them is, however, surprisingly expensive — closing each
        // AudioFormatReader's underlying FileInputStream on Windows
        // is ~1 s per handle (likely the OS / antivirus flushing the
        // read cache for the decoded-WAV files). With N clips that's
        // an N-second wait the user sees as "progress sat at 99% for
        // ages". We defer it past the DONE broadcast below.
        broadcastProgress(bridge, 95.0, "encode");
        writer.reset();
        const auto writerEndMs = juce::Time::getMillisecondCounter();

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
        const auto replaceEndMs = juce::Time::getMillisecondCounter();

        // From the user's point of view the export is now complete:
        // the file at `targetFile` is the final WAV. Push 100% + DONE
        // immediately so the dialog dismisses without waiting on the
        // slow clip teardown that follows.
        broadcastProgress(bridge, 100.0, "finalize");
        // Actual duration of the file on disk, computed from frames
        // written * output sample period. Includes the user tail and
        // any per-clip processor tail, so the dialog/IPC see the
        // real exported length rather than the nominal timeline ms.
        const double actualDurationMs =
            static_cast<double>(outputFramesWritten) * 1000.0
            / static_cast<double>(options.outputSampleRate);
        silverdaw::log::info("mixdown",
                             "done filePath=" + targetFile.getFullPathName() +
                                 " durationMs=" + juce::String(actualDurationMs, 1) +
                                 " timelineMs=" + juce::String(options.lengthMs, 1) +
                                 " tailSeconds=" + juce::String(clampedTailSeconds, 3) +
                                 " sampleRate=" + juce::String(options.outputSampleRate) +
                                 " bitDepth=" + juce::String(options.bitDepth) +
                                 " peakAmp=" + juce::String(preClampPeakAmplitude, 4) +
                                 " clippedSamples=" + juce::String(clippedSampleCount) +
                                 " outputFrames=" + juce::String(outputFramesWritten));
        broadcastDone(bridge, targetFile, actualDurationMs);

        // The file is final and the user-facing dialog is dismissed.
        // Release the busy gate NOW so TRANSPORT_PLAY and the next
        // MIXDOWN_START aren't silently rejected while we tear down
        // the (slow-to-close) per-clip reader chains below. The
        // remaining work is internal bookkeeping with no shared state;
        // BusyGuard's destructor will be a harmless no-op on the
        // already-cleared flag.
        busyFlag.store(false);

        // Now (and only now) drain the per-clip chains. Anything below
        // is invisible to the user — the dialog has already dismissed.
        // Ordered reverse-iteration so each transport stops before its
        // source is destroyed (matches the live engine's teardown
        // ordering for safety even though no readers are background-
        // buffered here).
        const int totalClips = static_cast<int>(clips.size());
        for (auto it = clips.rbegin(); it != clips.rend(); ++it)
        {
            if (auto& cp = *it; cp != nullptr)
            {
                if (cp->transport) cp->transport->stop();
                if (cp->transport) cp->transport->setSource(nullptr);
                if (cp->offsetSource) cp->offsetSource->setWarpProcessor(nullptr);
                cp.reset();
            }
        }
        clips.clear();
        const auto teardownEndMs = juce::Time::getMillisecondCounter();

        silverdaw::log::info(
            "mixdown",
            juce::String("finalize timings padMs=") +
                juce::String(padEndMs       - finalizeStartMs) +
                " writerFlushMs=" + juce::String(writerEndMs   - padEndMs) +
                " atomicReplaceMs=" + juce::String(replaceEndMs - writerEndMs) +
                " visibleFinalizeMs=" + juce::String(replaceEndMs - finalizeStartMs) +
                " backgroundTeardownMs=" + juce::String(teardownEndMs - replaceEndMs) +
                " (clips=" + juce::String(totalClips) + ")");
    });
}

} // namespace silverdaw
