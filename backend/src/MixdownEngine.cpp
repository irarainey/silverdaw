#include "MixdownEngine.h"

#include "BridgeServer.h"
#include "Log.h"
#include "ProjectState.h"

#include <algorithm>
#include <cmath>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>

#include <rubberband/RubberBandStretcher.h>
#include <samplerate.h>

#if JUCE_WINDOWS
#include <windows.h>
#endif

namespace silverdaw
{

// ───────────────────────────────────────────────────────────────────────────
// Public helpers
// ───────────────────────────────────────────────────────────────────────────

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

// Match the live engine's render block. Anything from 256–8192 works
// fine offline; 4096 keeps the per-clip warp/resampler overhead amortised
// while still giving us tight cancellation granularity.
constexpr int kBlockFrames = 4096;
// Max samples passed to RB in a single `process()` call. Mirrors
// `WarpProcessor`'s 1024-sample chunk so we never exceed the
// `setMaxProcessSize` budget regardless of how many frames libsamplerate
// emits after source→project upsampling. Rubber Band asserts/corrupts
// when called with more than its declared max.
constexpr int kRbProcessChunk = 1024;
// Min spacing between progress envelopes so the bridge doesn't drown
// in JSON frames on small projects.
constexpr int kProgressMinIntervalMs = 50;
constexpr int kOutputChannels = 2;
constexpr int kWavBitsPerSample = 16;

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

/**
 * Per-clip render state. Owns the file reader, the (optional) Rubber
 * Band stretcher, and the (optional) source→project libsamplerate
 * state. Pull-API: `pullProjectRateBlock(dst, n)` fills `n` frames of
 * project-rate stereo audio at `dst[ch][0..n-1]`, returning the number
 * of frames actually delivered (less than `n` once the clip ends).
 *
 * Channels are normalised to stereo at the libsamplerate stage — mono
 * sources are duplicated to L/R; >2-channel sources downmix to the
 * first two channels (we don't surround-mix).
 */
class MixdownClipRenderer
{
public:
    MixdownClipRenderer(const MixdownSnapshot::ClipSnapshot& clip,
                        int projectSampleRate,
                        juce::AudioFormatManager& formatManager)
        : clipSnapshot(clip), projectRate(projectSampleRate)
    {
        const juce::File sourceFile(clip.filePath);
        reader.reset(formatManager.createReaderFor(sourceFile));
        if (reader == nullptr)
        {
            silverdaw::log::warn("mixdown",
                                 "createReaderFor failed for clip " + clip.id + " path=" + clip.filePath);
            return;
        }
        sourceRate = static_cast<int>(reader->sampleRate);
        sourceChannels = static_cast<int>(reader->numChannels);
        if (sourceRate <= 0 || sourceChannels <= 0)
        {
            reader.reset();
            return;
        }

        // Seek the source reader to the clip's `inMs`. We read from
        // there; the read cursor advances as the worker pulls samples.
        const juce::int64 startSample =
            static_cast<juce::int64>(clip.inMs * 0.001 * static_cast<double>(sourceRate));
        readCursorSourceSamples = juce::jmax<juce::int64>(0, startSample);
        endCursorSourceSamples = juce::jmin(
            reader->lengthInSamples,
            startSample + static_cast<juce::int64>(clip.durationMs * 0.001 * static_cast<double>(sourceRate)));

        // libsamplerate state: source rate → project rate.
        if (sourceRate != projectRate)
        {
            int srErr = 0;
            srcState = src_new(SRC_SINC_MEDIUM_QUALITY, kOutputChannels, &srErr);
            if (srcState == nullptr)
            {
                silverdaw::log::warn("mixdown",
                                     "src_new failed err=" + juce::String(src_strerror(srErr))
                                         + " for clip " + clip.id);
            }
        }

        // Rubber Band realtime stretcher (only when warp is on).
        // We mirror the live `WarpProcessor` exactly so the exported
        // audio matches what the user heard during preview/playback:
        //   - Realtime + PitchHighConsistency options.
        //   - Mode mapping from AudioEngine.cpp (Faster + transient
        //     flags for rhythmic/tonal, Finer for complex).
        //   - Prime with `getPreferredStartPad()` zero frames, then
        //     discard `getStartDelay()` output frames before returning
        //     real audio.
        // Driving the realtime engine offline is the documented
        // approach when you can't pre-`study()` the input; offline
        // mode with a pumped pull-API is NOT supported (verified by
        // two independent rubber-duck audits) and was responsible for
        // the "warped clips sound wrong" report this fix addresses.
        if (clip.warpEnabled)
        {
            using RB = RubberBand::RubberBandStretcher;
            int modeOptions = 0;
            if (clip.warpMode == "complex")
                modeOptions = RB::OptionEngineFiner;
            else if (clip.warpMode == "tonal")
                modeOptions = RB::OptionEngineFaster | RB::OptionTransientsSmooth | RB::OptionWindowLong;
            else
                modeOptions = RB::OptionEngineFaster | RB::OptionTransientsCrisp;
            const int options = modeOptions
                              | RB::OptionProcessRealTime
                              | RB::OptionPitchHighConsistency;
            stretcher = std::make_unique<RB>(static_cast<size_t>(projectRate),
                                             static_cast<size_t>(kOutputChannels),
                                             options,
                                             1.0, // ratios set below via setters (matches live engine)
                                             1.0);
            const double timeRatio = juce::jmax(0.01, 1.0 / juce::jmax(0.0001, clip.tempoRatio));
            const double pitchScale =
                std::pow(2.0, (clip.semitones + (clip.cents / 100.0)) / 12.0);
            stretcher->setTimeRatio(timeRatio);
            stretcher->setPitchScale(pitchScale);

            // Pre-feed `getPreferredStartPad()` zero frames and arm
            // the `outputDelayToDiscard` budget. Identical to
            // WarpProcessor::doReset(). Without this priming, the
            // start of every warped clip would be unprimed garbage.
            const int pad = static_cast<int>(stretcher->getPreferredStartPad());
            outputDelayToDiscard = static_cast<int>(stretcher->getStartDelay());
            if (pad > 0)
            {
                std::vector<float> zeros(static_cast<size_t>(pad), 0.0F);
                const float* zeroPtrs[kOutputChannels] = {zeros.data(), zeros.data()};
                int remaining = pad;
                while (remaining > 0)
                {
                    const int chunk = juce::jmin(remaining, kRbProcessChunk);
                    const float* chunkPtrs[kOutputChannels] = {zeroPtrs[0], zeroPtrs[1]};
                    stretcher->process(chunkPtrs, static_cast<size_t>(chunk), false);
                    remaining -= chunk;
                }
            }
            silverdaw::log::info("mixdown",
                                 "warp init clip=" + clip.id +
                                     " mode=" + clip.warpMode +
                                     " timeRatio=" + juce::String(timeRatio, 4) +
                                     " pitchScale=" + juce::String(pitchScale, 4) +
                                     " startPad=" + juce::String(pad) +
                                     " startDelay=" + juce::String(outputDelayToDiscard));
        }
        ready = true;
    }

    ~MixdownClipRenderer()
    {
        if (srcState != nullptr) src_delete(srcState);
    }

    bool isReady() const noexcept { return ready; }

    /**
     * Fill `dst` with up to `framesWanted` frames of project-rate
     * stereo audio. Returns the number of frames actually written.
     * Returns 0 once the clip has been fully consumed (including the
     * Rubber Band drain tail).
     */
    int pullProjectRateBlock(float* leftDst, float* rightDst, int framesWanted)
    {
        if (!ready || framesWanted <= 0) return 0;
        int produced = 0;
        while (produced < framesWanted)
        {
            // Drain the resampler's output buffer first if it has any.
            if (!projectRateBuffer.empty())
            {
                const int avail = static_cast<int>(projectRateBuffer.size() / 2);
                const int toCopy = juce::jmin(avail, framesWanted - produced);
                for (int i = 0; i < toCopy; ++i)
                {
                    leftDst[produced + i] = projectRateBuffer[static_cast<size_t>(i) * 2 + 0];
                    rightDst[produced + i] = projectRateBuffer[static_cast<size_t>(i) * 2 + 1];
                }
                projectRateBuffer.erase(projectRateBuffer.begin(),
                                        projectRateBuffer.begin() + static_cast<long>(toCopy) * 2);
                produced += toCopy;
                if (produced >= framesWanted) return produced;
            }

            // Try to drain a Rubber Band tail before pulling more source.
            if (stretcher != nullptr && sourceDrained)
            {
                const int rbAvailable = stretcher->available();
                if (rbAvailable > 0)
                {
                    drainRubberBandIntoProjectRateBuffer(juce::jmin(rbAvailable, kBlockFrames));
                    continue;
                }
                if (rbAvailable < 0)
                {
                    // -1 means RB is finished. No more output.
                    return produced;
                }
            }

            if (sourceDrained && stretcher == nullptr) return produced;

            // Pull a chunk from the source reader, push through RB
            // (or straight through), then resample to project rate.
            const int sourceChunk = pullSourceAndForward();
            if (sourceChunk == 0 && projectRateBuffer.empty())
            {
                // No source left and nothing in flight — done.
                return produced;
            }
        }
        return produced;
    }

private:
    /**
     * Read up to `kBlockFrames` source frames, downmix to stereo, run
     * through Rubber Band (if warp on) and libsamplerate (if rates
     * differ), and append the resulting project-rate frames to
     * `projectRateBuffer`. Returns the number of *source* frames read
     * this call (0 once the source window is exhausted).
     */
    int pullSourceAndForward()
    {
        if (reader == nullptr) return 0;

        const juce::int64 remaining = endCursorSourceSamples - readCursorSourceSamples;
        const int toRead = static_cast<int>(juce::jmin<juce::int64>(remaining, kBlockFrames));

        std::array<float, kBlockFrames * 2> stereoBuf{};
        int sourceFramesRead = 0;
        if (toRead > 0)
        {
            // Decode straight into a stereo float buffer. Reader's
            // `read()` writes interleaved per-channel — we down/up-mix
            // ourselves so we get exactly L/R regardless of source ch.
            juce::AudioBuffer<float> tmp(juce::jmax(2, sourceChannels), toRead);
            tmp.clear();
            float* writePtrs[16] = {};
            for (int ch = 0; ch < tmp.getNumChannels(); ++ch)
                writePtrs[ch] = tmp.getWritePointer(ch);

            if (reader->read(writePtrs, tmp.getNumChannels(), readCursorSourceSamples, toRead))
            {
                const float* leftSrc = tmp.getReadPointer(0);
                const float* rightSrc = (sourceChannels >= 2) ? tmp.getReadPointer(1) : leftSrc;
                for (int i = 0; i < toRead; ++i)
                {
                    stereoBuf[static_cast<size_t>(i) * 2 + 0] = leftSrc[i];
                    stereoBuf[static_cast<size_t>(i) * 2 + 1] = rightSrc[i];
                }
                sourceFramesRead = toRead;
                readCursorSourceSamples += toRead;
            }
        }

        if (sourceFramesRead <= 0)
        {
            // Source exhausted. The fix-up order matters: flush the
            // libsamplerate tail FIRST, push any leftover frames
            // through Rubber Band, THEN signal RB final=true. Doing
            // them in the wrong order discards the SRC tail and
            // ends RB early — the symptom was warped clips ending a
            // few ms before their effective duration with the tail
            // missing.
            if (srcState != nullptr && !srcEndPushed)
            {
                std::array<float, 2> dummyIn{};
                std::array<float, kBlockFrames * 2> dummyOut{};
                SRC_DATA srcData{};
                srcData.data_in = dummyIn.data();
                srcData.data_out = dummyOut.data();
                srcData.input_frames = 0;
                srcData.output_frames = kBlockFrames;
                srcData.end_of_input = 1;
                srcData.src_ratio = static_cast<double>(projectRate) / juce::jmax(1, sourceRate);
                const int err = src_process(srcState, &srcData);
                srcEndPushed = true;
                if (err == 0 && srcData.output_frames_gen > 0)
                {
                    const int tailFrames = static_cast<int>(srcData.output_frames_gen);
                    if (stretcher != nullptr)
                    {
                        // Feed the SRC tail through RB so it gets the
                        // same warp/pitch treatment as the rest of
                        // the clip. Chunked to respect maxProcessSize.
                        std::vector<float> tailL(static_cast<size_t>(tailFrames));
                        std::vector<float> tailR(static_cast<size_t>(tailFrames));
                        for (int i = 0; i < tailFrames; ++i)
                        {
                            tailL[static_cast<size_t>(i)] = dummyOut[static_cast<size_t>(i) * 2 + 0];
                            tailR[static_cast<size_t>(i)] = dummyOut[static_cast<size_t>(i) * 2 + 1];
                        }
                        int cursor = 0;
                        while (cursor < tailFrames)
                        {
                            const int chunk = juce::jmin(tailFrames - cursor, kRbProcessChunk);
                            const float* p[kOutputChannels] = {
                                tailL.data() + cursor, tailR.data() + cursor};
                            stretcher->process(p, static_cast<size_t>(chunk), false);
                            cursor += chunk;
                            const int rbAvail = stretcher->available();
                            if (rbAvail > 0)
                            {
                                drainRubberBandIntoProjectRateBuffer(juce::jmin(rbAvail, kBlockFrames));
                            }
                        }
                    }
                    else
                    {
                        projectRateBuffer.insert(projectRateBuffer.end(), dummyOut.begin(),
                                                 dummyOut.begin() + tailFrames * 2);
                    }
                }
            }
            if (stretcher != nullptr && !sourceDrained)
            {
                // Final RB push with `final=true` so internal latency
                // flushes. Passing an empty buffer with samples=0 is
                // explicitly valid in RB R3.
                std::array<const float*, kOutputChannels> emptyPtrs{stereoBuf.data(), stereoBuf.data()};
                stretcher->process(emptyPtrs.data(), 0, true);
                sourceDrained = true;
            }
            else
            {
                sourceDrained = true;
            }
            return 0;
        }

        // Forward path: stereoBuf has `sourceFramesRead` source-rate
        // stereo frames. Push through Rubber Band if active, then to
        // libsamplerate if active.
        if (stretcher != nullptr)
        {
            // Rubber Band's `process` is at project rate. If the
            // source rate differs from the project rate, we first
            // resample source→project, then push to RB. Otherwise
            // skip the resample and go straight to RB.
            std::vector<float> rbInputInterleaved;
            int rbInputFrames = sourceFramesRead;
            if (sourceRate != projectRate && srcState != nullptr)
            {
                const double ratio = static_cast<double>(projectRate) / static_cast<double>(sourceRate);
                const int worst = static_cast<int>(std::ceil(sourceFramesRead * ratio)) + 8;
                std::vector<float> resampled(static_cast<size_t>(worst) * 2);
                SRC_DATA srcData{};
                srcData.data_in = stereoBuf.data();
                srcData.input_frames = sourceFramesRead;
                srcData.data_out = resampled.data();
                srcData.output_frames = worst;
                srcData.end_of_input = 0;
                srcData.src_ratio = ratio;
                const int err = src_process(srcState, &srcData);
                if (err != 0)
                {
                    silverdaw::log::warn("mixdown",
                                         juce::String("src_process(warp) err=") + src_strerror(err));
                    return sourceFramesRead;
                }
                rbInputInterleaved.assign(resampled.begin(),
                                          resampled.begin() + srcData.output_frames_gen * 2);
                rbInputFrames = static_cast<int>(srcData.output_frames_gen);
            }
            else
            {
                rbInputInterleaved.assign(stereoBuf.begin(), stereoBuf.begin() + sourceFramesRead * 2);
                rbInputFrames = sourceFramesRead;
            }
            // De-interleave for RB and feed in `kRbProcessChunk`-sized
            // sub-blocks. Rubber Band's `setMaxProcessSize` budget
            // (1024 to match WarpProcessor) is enforced per call —
            // exceeding it asserts or corrupts internal buffers,
            // which was a confirmed cause of "warp sounds wrong"
            // when source rate > project rate (e.g. 22.05k→48k yields
            // ~8916 frames from a 4096-frame source chunk).
            std::vector<float> rbInL(static_cast<size_t>(rbInputFrames));
            std::vector<float> rbInR(static_cast<size_t>(rbInputFrames));
            for (int i = 0; i < rbInputFrames; ++i)
            {
                rbInL[static_cast<size_t>(i)] = rbInputInterleaved[static_cast<size_t>(i) * 2 + 0];
                rbInR[static_cast<size_t>(i)] = rbInputInterleaved[static_cast<size_t>(i) * 2 + 1];
            }
            int cursor = 0;
            while (cursor < rbInputFrames)
            {
                const int chunk = juce::jmin(rbInputFrames - cursor, kRbProcessChunk);
                const float* rbInPtrs[kOutputChannels] = {
                    rbInL.data() + cursor, rbInR.data() + cursor};
                stretcher->process(rbInPtrs, static_cast<size_t>(chunk), false);
                cursor += chunk;
                // Drain any output ready after each sub-block so RB's
                // internal output buffer doesn't grow unboundedly on
                // tempoRatio < 1.0 (long output per input).
                const int rbAvail = stretcher->available();
                if (rbAvail > 0)
                {
                    drainRubberBandIntoProjectRateBuffer(juce::jmin(rbAvail, kBlockFrames));
                }
            }
        }
        else if (sourceRate != projectRate && srcState != nullptr)
        {
            // No warp, but resample source→project.
            const double ratio = static_cast<double>(projectRate) / static_cast<double>(sourceRate);
            const int worst = static_cast<int>(std::ceil(sourceFramesRead * ratio)) + 8;
            std::vector<float> resampled(static_cast<size_t>(worst) * 2);
            SRC_DATA srcData{};
            srcData.data_in = stereoBuf.data();
            srcData.input_frames = sourceFramesRead;
            srcData.data_out = resampled.data();
            srcData.output_frames = worst;
            srcData.end_of_input = 0;
            srcData.src_ratio = ratio;
            const int err = src_process(srcState, &srcData);
            if (err != 0)
            {
                silverdaw::log::warn("mixdown", juce::String("src_process err=") + src_strerror(err));
                return sourceFramesRead;
            }
            projectRateBuffer.insert(projectRateBuffer.end(),
                                     resampled.begin(),
                                     resampled.begin() + srcData.output_frames_gen * 2);
        }
        else
        {
            // No warp, no resample — interleaved stereo straight in.
            projectRateBuffer.insert(projectRateBuffer.end(),
                                     stereoBuf.begin(),
                                     stereoBuf.begin() + sourceFramesRead * 2);
        }
        return sourceFramesRead;
    }

    void drainRubberBandIntoProjectRateBuffer(int frames)
    {
        if (stretcher == nullptr || frames <= 0) return;
        std::vector<float> outL(static_cast<size_t>(frames));
        std::vector<float> outR(static_cast<size_t>(frames));
        float* outPtrs[kOutputChannels] = {outL.data(), outR.data()};
        const int got = static_cast<int>(stretcher->retrieve(outPtrs, static_cast<size_t>(frames)));
        // Discard initial latency frames before publishing real audio.
        // Mirrors WarpProcessor's discardScratch path. Without this,
        // the first `getStartDelay()` output frames are unprimed
        // RB internal state and shift every clip's audio later on
        // the timeline by that amount — confirmed by both rubber-
        // duck audits as a contributing cause of "warp/pitch sound
        // wrong" reports.
        int writeOffset = 0;
        if (outputDelayToDiscard > 0 && got > 0)
        {
            const int drop = juce::jmin(got, outputDelayToDiscard);
            outputDelayToDiscard -= drop;
            writeOffset = drop;
        }
        for (int i = writeOffset; i < got; ++i)
        {
            projectRateBuffer.push_back(outL[static_cast<size_t>(i)]);
            projectRateBuffer.push_back(outR[static_cast<size_t>(i)]);
        }
    }

    MixdownSnapshot::ClipSnapshot clipSnapshot;
    int projectRate{0};
    int sourceRate{0};
    int sourceChannels{0};
    std::unique_ptr<juce::AudioFormatReader> reader;
    std::unique_ptr<RubberBand::RubberBandStretcher> stretcher;
    SRC_STATE* srcState{nullptr};
    juce::int64 readCursorSourceSamples{0};
    juce::int64 endCursorSourceSamples{0};
    bool sourceDrained{false};
    bool srcEndPushed{false};
    bool ready{false};
    /** Number of RB output frames still to discard (initial latency).
     *  Mirrors WarpProcessor::outputDelayToDiscard. Until this hits
     *  zero, every retrieved frame goes to /dev/null instead of into
     *  the mix. */
    int outputDelayToDiscard{0};
    /** Output buffer at project rate, interleaved stereo. Pull-API
     *  drains from the front. */
    std::vector<float> projectRateBuffer;
};

/**
 * Walk every clip on every track and feed `framesWanted` frames into
 * `mixL`/`mixR` (project rate). `timelineCursorMs` is the start of the
 * block in project time. Returns the maximum absolute sample seen so
 * we can log peak level after the render.
 */
struct ActiveClip
{
    std::unique_ptr<MixdownClipRenderer> renderer;
    double clipStartMs{0.0};
    double clipEndMs{0.0};
    float trackGain{1.0F};
    bool started{false}; // true once we've started pulling frames
    /** Number of project-rate frames already pulled — used to figure
     *  out where in the timeline window the next pull goes. */
    int64_t framesPulled{0};
};

/**
 * Lightweight wrapper around `MoveFileExW` (Windows) / `std::rename`
 * (fallback) that overwrites the destination if it exists. Used to
 * commit the `<file>.tmp` → `<file>` finalize atomically.
 */
bool atomicReplace(const juce::File& tmp, const juce::File& target)
{
#if JUCE_WINDOWS
    const auto tmpStr = tmp.getFullPathName().toWideCharPointer();
    const auto targetStr = target.getFullPathName().toWideCharPointer();
    // MOVEFILE_REPLACE_EXISTING + MOVEFILE_WRITE_THROUGH = atomic
    // replace semantics on the same volume. If target doesn't exist
    // yet this still succeeds (the flag is "replace if present").
    return ::MoveFileExW(tmpStr, targetStr,
                         MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
#else
    target.deleteFile();
    return tmp.moveFileTo(target);
#endif
}

} // anonymous namespace

// ───────────────────────────────────────────────────────────────────────────
// Snapshot
// ───────────────────────────────────────────────────────────────────────────

MixdownSnapshot snapshotProjectForMixdown(const ProjectState& project)
{
    MixdownSnapshot snapshot;
    const int explicitRate = project.getTargetSampleRate();
    snapshot.projectSampleRate = (explicitRate == 44100 || explicitRate == 48000)
                                     ? explicitRate
                                     : 44100;

    // Identifiers are private members of ProjectState — match its
    // wire / JSON property names by string. These mirror the
    // identifiers in ProjectState.cpp (kept lower-case to match the
    // existing ValueTree node properties).
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
        // Mute and solo round-trip through the project file now (as
        // separate persisted `kMuted` / `kSoloed` properties on the
        // track ValueTree), and the backend's
        // `getEffectiveTrackGain` folds them into a single audible
        // value. So a muted track has gain=0 here, and when a solo
        // is active every non-soloed track has gain=0 too. Skipping
        // zero-gain tracks at snapshot time avoids opening their
        // source readers, running Rubber Band on them, and wasting
        // time on audio that would just be multiplied by zero. The
        // per-track log line below is an unambiguous record of which
        // tracks contributed to the export and at what gain.
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
            // Prefer the decoded-WAV cache when available so the
            // worker doesn't have to decode MP3 / WMA inside the
            // render loop. Falls back to the original source path
            // if the cache hasn't been built yet.
            clip.filePath = project.getLibraryItemPlaybackPath(libraryItemId);
            if (clip.filePath.isEmpty()) clip.filePath = project.getLibraryItemFilePath(libraryItemId);
            clip.offsetMs = static_cast<double>(clipTree.getProperty(kOffsetMs, 0.0));
            clip.inMs = static_cast<double>(clipTree.getProperty(kInMs, 0.0));
            clip.durationMs = static_cast<double>(clipTree.getProperty(kDurationMs, 0.0));
            clip.warpEnabled = static_cast<bool>(clipTree.getProperty(kWarpEnabled, false));
            clip.warpMode = clipTree.getProperty(kWarpMode, "rhythmic").toString();
            // tempoRatio and effectiveDurationMs come from the
            // authoritative `getClipEffectiveTiming` helper rather
            // than direct ValueTree property reads. The persisted
            // `tempoRatio` field is ONLY set when the user has
            // explicitly pinned a ratio via the Warp dialog; in the
            // common "follow project BPM" case the property is
            // absent and the live engine computes the ratio as
            // `projectBpm / sourceBpm` on the fly. Reading the
            // ValueTree directly with a default of 1.0 (the previous
            // bug) gave warped clips a no-op stretch, so the
            // exported audio played at native source speed while the
            // timeline expected the warped speed — clips drifted
            // progressively off beat. This was confirmed as the
            // dominant cause of "warp not in time" via dual rubber-
            // duck audits.
            const auto timing = project.getClipEffectiveTiming(clip.id);
            clip.tempoRatio = timing.tempoRatio > 0.0 ? timing.tempoRatio : 1.0;
            clip.semitones = static_cast<double>(clipTree.getProperty(kSemitones, 0.0));
            clip.cents = static_cast<double>(clipTree.getProperty(kCents, 0.0));

            // Effective timeline duration also comes from
            // `getClipEffectiveTiming` — the previous "read
            // kEffectiveDurationMs from the ValueTree" path was a
            // no-op because that field is only emitted into the
            // PROJECT_STATE JSON, never written back to the tree.
            clip.effectiveDurationMs = timing.durationMs > 0.0 ? timing.durationMs : clip.durationMs;

            // Pull the source's native rate from the library item
            // so the worker can stick the right libsamplerate ratio
            // on the per-clip resampler.
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

// ───────────────────────────────────────────────────────────────────────────
// Render
// ───────────────────────────────────────────────────────────────────────────

void renderMixdownAsync(MixdownSnapshot snapshot,
                        MixdownOptions options,
                        juce::ThreadPool& pool,
                        BridgeServer& bridge,
                        std::atomic<bool>& cancelFlag,
                        std::atomic<bool>& busyFlag)
{
    busyFlag.store(true);
    cancelFlag.store(false);

    // Capture by value into the worker lambda. `bridge` is a long-
    // lived singleton; cancelFlag / busyFlag are atomic refs in Main.
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
            // Placeholder until LAME integration lands as a focused
            // follow-up. The dialog disables this radio so this branch
            // should be unreachable from a properly-wired UI, but we
            // surface a clear, code-tagged error if a stray envelope
            // arrives.
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

        // Open writer on a `<file>.tmp` sibling in the same dir so
        // the atomic-finalize move is same-volume (Windows requires
        // this for true atomic semantics).
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

        // Build the active-clip list. We pre-construct every renderer
        // because the typical project has tens of clips, not
        // thousands — keeping every reader open for the duration of
        // the render is well within OS handle limits.
        std::vector<std::pair<int, ActiveClip>> activeClips; // (track index, clip state)
        activeClips.reserve(snapshot.tracks.size() * 8);
        int totalClips = 0;
        for (size_t ti = 0; ti < snapshot.tracks.size(); ++ti)
        {
            const auto& track = snapshot.tracks[ti];
            for (const auto& clip : track.clips)
            {
                if (cancelFlag.load())
                {
                    failWith(MixdownFailureCode::Cancelled, "Cancelled.");
                    return;
                }
                ActiveClip ac;
                ac.renderer = std::make_unique<MixdownClipRenderer>(
                    clip, snapshot.projectSampleRate, formatManager);
                if (!ac.renderer->isReady())
                {
                    failWith(MixdownFailureCode::Decode,
                             "Could not open source for clip " + clip.id + " (" + clip.filePath + ")");
                    return;
                }
                ac.clipStartMs = clip.offsetMs;
                ac.clipEndMs = clipTimelineEndMs(clip);
                ac.trackGain = track.gain;
                activeClips.emplace_back(static_cast<int>(ti), std::move(ac));
                ++totalClips;
            }
        }

        // Final mix→output resampler (only when output rate differs
        // from project rate).
        SRC_STATE* finalResampler = nullptr;
        const bool needFinalResample = options.outputSampleRate != snapshot.projectSampleRate;
        if (needFinalResample)
        {
            int srErr = 0;
            finalResampler = src_new(SRC_SINC_MEDIUM_QUALITY, kOutputChannels, &srErr);
            if (finalResampler == nullptr)
            {
                failWith(MixdownFailureCode::Invalid,
                         juce::String("Cannot init output resampler: ") + src_strerror(srErr));
                return;
            }
        }
        struct ResamplerGuard
        {
            SRC_STATE* state;
            ~ResamplerGuard() { if (state) src_delete(state); }
        } resamplerGuard{finalResampler};

        const double projectFramesPerMs = snapshot.projectSampleRate / 1000.0;
        const int64_t totalProjectFrames = static_cast<int64_t>(options.lengthMs * projectFramesPerMs);
        const double outputFramesPerMs = options.outputSampleRate / 1000.0;
        const int64_t totalOutputFrames = static_cast<int64_t>(options.lengthMs * outputFramesPerMs);
        int64_t outputFramesWritten = 0;
        int64_t projectFramesRendered = 0;
        double peakAmplitude = 0.0;
        int64_t lastProgressMs = juce::Time::getMillisecondCounter();

        std::vector<float> mixL(static_cast<size_t>(kBlockFrames));
        std::vector<float> mixR(static_cast<size_t>(kBlockFrames));
        std::vector<float> clipL(static_cast<size_t>(kBlockFrames));
        std::vector<float> clipR(static_cast<size_t>(kBlockFrames));

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
            std::fill(mixL.begin(), mixL.begin() + blockFrames, 0.0F);
            std::fill(mixR.begin(), mixR.begin() + blockFrames, 0.0F);

            const double blockStartMs = projectFramesRendered / projectFramesPerMs;
            const double blockEndMs = (projectFramesRendered + blockFrames) / projectFramesPerMs;

            for (auto& entry : activeClips)
            {
                auto& ac = entry.second;
                // Skip clips entirely outside the block.
                if (ac.clipEndMs <= blockStartMs) continue;
                if (ac.clipStartMs >= blockEndMs) continue;

                std::fill(clipL.begin(), clipL.begin() + blockFrames, 0.0F);
                std::fill(clipR.begin(), clipR.begin() + blockFrames, 0.0F);

                // Where in the block does this clip start (in frames)?
                int writeOffset = 0;
                if (!ac.started)
                {
                    const double clipOffsetInBlockMs =
                        juce::jmax(0.0, ac.clipStartMs - blockStartMs);
                    writeOffset = juce::jmin(blockFrames,
                                             static_cast<int>(std::round(clipOffsetInBlockMs * projectFramesPerMs)));
                    ac.started = true;
                }
                const int framesToPull = blockFrames - writeOffset;
                if (framesToPull <= 0) continue;
                std::vector<float> pullL(static_cast<size_t>(framesToPull));
                std::vector<float> pullR(static_cast<size_t>(framesToPull));
                ac.renderer->pullProjectRateBlock(pullL.data(), pullR.data(), framesToPull);
                for (int i = 0; i < framesToPull; ++i)
                {
                    clipL[static_cast<size_t>(writeOffset + i)] = pullL[static_cast<size_t>(i)];
                    clipR[static_cast<size_t>(writeOffset + i)] = pullR[static_cast<size_t>(i)];
                }

                // Mix into block with track gain.
                const float g = ac.trackGain;
                for (int i = 0; i < blockFrames; ++i)
                {
                    mixL[static_cast<size_t>(i)] += clipL[static_cast<size_t>(i)] * g;
                    mixR[static_cast<size_t>(i)] += clipR[static_cast<size_t>(i)] * g;
                }
            }

            // Hard-clip at full scale; soft-saturation / proper master
            // limiting is Phase 2.
            for (int i = 0; i < blockFrames; ++i)
            {
                mixL[static_cast<size_t>(i)] = juce::jlimit(-1.0F, 1.0F, mixL[static_cast<size_t>(i)]);
                mixR[static_cast<size_t>(i)] = juce::jlimit(-1.0F, 1.0F, mixR[static_cast<size_t>(i)]);
                peakAmplitude = juce::jmax(peakAmplitude,
                                           static_cast<double>(std::abs(mixL[static_cast<size_t>(i)])),
                                           static_cast<double>(std::abs(mixR[static_cast<size_t>(i)])));
            }

            // Write block. Resample to output rate first if needed.
            if (!needFinalResample)
            {
                const float* writePtrs[kOutputChannels] = {mixL.data(), mixR.data()};
                if (!writer->writeFromFloatArrays(writePtrs, kOutputChannels, blockFrames))
                {
                    tmpFile.deleteFile();
                    failWith(MixdownFailureCode::Io, "Writer failed mid-stream.");
                    return;
                }
                outputFramesWritten += blockFrames;
            }
            else
            {
                // Interleave for libsamplerate.
                std::vector<float> mixInterleaved(static_cast<size_t>(blockFrames) * 2);
                for (int i = 0; i < blockFrames; ++i)
                {
                    mixInterleaved[static_cast<size_t>(i) * 2 + 0] = mixL[static_cast<size_t>(i)];
                    mixInterleaved[static_cast<size_t>(i) * 2 + 1] = mixR[static_cast<size_t>(i)];
                }
                const double ratio = static_cast<double>(options.outputSampleRate)
                                     / static_cast<double>(snapshot.projectSampleRate);
                const int worst = static_cast<int>(std::ceil(blockFrames * ratio)) + 8;
                std::vector<float> resampled(static_cast<size_t>(worst) * 2);
                SRC_DATA srcData{};
                srcData.data_in = mixInterleaved.data();
                srcData.input_frames = blockFrames;
                srcData.data_out = resampled.data();
                srcData.output_frames = worst;
                srcData.end_of_input = (projectFramesRendered + blockFrames >= totalProjectFrames) ? 1 : 0;
                srcData.src_ratio = ratio;
                const int err = src_process(finalResampler, &srcData);
                if (err != 0)
                {
                    tmpFile.deleteFile();
                    failWith(MixdownFailureCode::Invalid,
                             juce::String("Final resample failed: ") + src_strerror(err));
                    return;
                }
                const int gen = static_cast<int>(srcData.output_frames_gen);
                if (gen > 0)
                {
                    std::vector<float> outL(static_cast<size_t>(gen));
                    std::vector<float> outR(static_cast<size_t>(gen));
                    for (int i = 0; i < gen; ++i)
                    {
                        outL[static_cast<size_t>(i)] = resampled[static_cast<size_t>(i) * 2 + 0];
                        outR[static_cast<size_t>(i)] = resampled[static_cast<size_t>(i) * 2 + 1];
                    }
                    const float* writePtrs[kOutputChannels] = {outL.data(), outR.data()};
                    if (!writer->writeFromFloatArrays(writePtrs, kOutputChannels, gen))
                    {
                        tmpFile.deleteFile();
                        failWith(MixdownFailureCode::Io, "Writer failed mid-stream.");
                        return;
                    }
                    outputFramesWritten += gen;
                }
            }

            projectFramesRendered += blockFrames;

            const auto now = juce::Time::getMillisecondCounter();
            if (now - lastProgressMs >= kProgressMinIntervalMs)
            {
                const double pct = (static_cast<double>(projectFramesRendered)
                                    / static_cast<double>(juce::jmax<int64_t>(1, totalProjectFrames)))
                                   * 95.0; // reserve last 5% for finalize
                broadcastProgress(bridge, pct, "render");
                lastProgressMs = now;
            }
        }

        broadcastProgress(bridge, 96.0, "finalize");

        // Pad output with silence if it came up short (rare — only
        // happens with finalResampler when the source flush returns
        // fewer frames than expected).
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

        writer.reset(); // flushes & closes the underlying stream

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
