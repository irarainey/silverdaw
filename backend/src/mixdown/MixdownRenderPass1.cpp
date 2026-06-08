#include "MixdownRenderPass1.h"

#include "BusGraph.h"
#include "Log.h"
#include "MixdownBroadcast.h"
#include "SharedFx.h"  // delayNoteToMs

#include <algorithm>
#include <cmath>
#include <climits>
#include <vector>

#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{
namespace mixdown_render_pass1
{

using mixdown_bridge::broadcastProgress;
using mixdown_dither::kLsb16f;
using mixdown_dither::nextUniform;
using mixdown_graph::buildOfflineClip;
using mixdown_graph::FinalResampler;
using mixdown_graph::kBlockFrames;
using mixdown_graph::kOutputChannels;
using mixdown_graph::OfflineClip;

namespace
{
// Min spacing between progress envelopes so the bridge isn't flooded.
constexpr int kProgressMinIntervalMs = 50;

Pass1Result fail(MixdownFailureCode code, const juce::String& message)
{
    Pass1Result r;
    r.ok = false;
    r.code = code;
    r.message = message;
    return r;
}
} // anonymous namespace

Pass1Result runPass1(const MixdownSnapshot& snapshot,
                     const MixdownOptions& options,
                     juce::AudioFormatManager& formatManager,
                     juce::AudioFormatWriter& writer,
                     LoudnessAnalyzer* analyzer,
                     bool normalizing,
                     bool analyzing,
                     const juce::File& pass1File,
                     mixdown_dither::Xorshift32& rngL,
                     mixdown_dither::Xorshift32& rngR,
                     BridgeServer& bridge,
                     std::atomic<bool>& cancelFlag)
{
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
                return fail(MixdownFailureCode::Cancelled, "Cancelled.");
            juce::String err;
            auto built = buildOfflineClip(clip, track.id, track.gain,
                                          snapshot.projectSampleRate,
                                          formatManager, err);
            if (built == nullptr)
                return fail(MixdownFailureCode::Decode,
                            "Could not open source for clip " + clip.id +
                                (err.isNotEmpty() ? juce::String(": ") + err : juce::String("")));
            clips.push_back(std::move(built));
        }
    }

    // Canonical project bus (Phase 5 step 1d). Mirrors the live
    // engine's topology: one `BusGraph::TrackRuntime` per UI track,
    // each summing its clips through the canonical `TrackChain`
    // before they reach the master bus. Declared AFTER `clips` so
    // destruction order is `busGraph` first → its TrackRuntimes
    // release the `ClipSummingSource` pointers → THEN `clips` (and
    // their owned transports) destruct. Without this ordering the
    // TrackRuntimes' inner mixers would briefly hold dangling
    // pointers during teardown.
    silverdaw::BusGraph busGraph;
    busGraph.prepareToPlay(kBlockFrames, static_cast<double>(snapshot.projectSampleRate));
    for (auto& cp : clips)
    {
        busGraph.attachClip(cp->trackId, cp->id, cp->summingSource.get());
    }

    // Phase 5 — push per-track Tone EQ onto the offline bus. Snapped
    // so the very first rendered block is steady-state (the export
    // must never ramp up from flat). Pushed for every track in the
    // snapshot, including any whose tone is default (identity), which
    // is a cheap no-op in the chain.
    for (const auto& trackSnap : snapshot.tracks)
    {
        busGraph.setTrackTone(trackSnap.id, trackSnap.toneBassDb, trackSnap.toneMidDb,
                              trackSnap.toneTrebleDb, trackSnap.toneLowCut,
                              trackSnap.toneHighCut, /*snap*/ true);
        busGraph.setTrackLeveler(trackSnap.id, trackSnap.levelerAmount, /*snap*/ true);
        busGraph.setTrackSends(trackSnap.id, trackSnap.reverbSend, trackSnap.delaySend);
        busGraph.setTrackPan(trackSnap.id, trackSnap.pan);
    }

    // Phase 5 — push the project-shared Reverb / Delay onto the offline
    // bus. Snapped and with the delay time applied immediately so the
    // first rendered block is steady-state. The delay time resolves
    // via the same helper the live engine uses (§7.9.6 parity).
    busGraph.setProjectReverb(snapshot.reverbSize, snapshot.reverbDecay, snapshot.reverbTone,
                              snapshot.reverbMix, /*snap*/ true);
    busGraph.setProjectDelay(silverdaw::delayNoteToMs(snapshot.delayNoteValue, snapshot.bpm),
                             snapshot.delayFeedback, snapshot.delayTone, snapshot.delayMix,
                             /*snap*/ true, /*applyTimeNow*/ true);
    FinalResampler finalResampler(snapshot.projectSampleRate, options.outputSampleRate);
    if (!finalResampler.ok())
        return fail(MixdownFailureCode::Invalid,
                    juce::String("Cannot init output resampler: ") + finalResampler.error());

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
    // Project-shared FX tail budget (§7.10 tail-render policy). The
    // shared Reverb + Delay can ring out past the last clip's end, so we
    // extend the render window by their fail-safe cap and break early
    // (below) once both have actually decayed. Per §7.10 the two FX
    // run in PARALLEL, so the absolute ceiling is the MAX of the
    // per-FX caps (Reverb 8 s, Delay 4 s), not their sum. The real
    // cutoff is detector-driven (`busGraph.sharedFxTerminated()`),
    // with this value only as the hard fail-safe.
    const int64_t sharedFxMaxTailFrames = static_cast<int64_t>(
        std::ceil(8.0 * static_cast<double>(snapshot.projectSampleRate)));
    // Additive user-controlled silence tail, clamped sensibly by
    // the dispatch handler (0..60 s). Lets reverb/delay clips
    // ring out past the timeline end even when no processor-
    // declared tail exists yet. We add it on top of the per-
    // clip processor tail because the user is asking for that
    // many extra seconds AFTER all processors have decayed.
    const double clampedTailSeconds = juce::jlimit(0.0, 60.0, options.tailSeconds);
    const int64_t userTailFrames = static_cast<int64_t>(
        std::round(clampedTailSeconds * static_cast<double>(snapshot.projectSampleRate)));
    totalProjectFrames += maxTailFrames + sharedFxMaxTailFrames + userTailFrames;
    // Guaranteed-minimum render length: the timeline, the worst-case
    // per-clip tail and the user-requested trailing silence are always
    // rendered. The shared-FX cap on top is only consumed while the FX
    // is still ringing — once `busGraph.sharedFxTerminated()` and we
    // have passed this minimum, the loop breaks early (so a project
    // with no/inactive shared FX exports at exactly the pre-step-7
    // length, with bit-identical content).
    const int64_t minRenderFrames = totalProjectFrames - sharedFxMaxTailFrames;
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
    std::vector<float> mixInterleaved(static_cast<size_t>(kBlockFrames) * 2);

    // TPDF dither state. Active only when the target file is a
    // 16-bit integer container (WAV-16 or FLAC-16). For 24-bit
    // the noise floor is well below audibility and dither is
    // skipped by default; for 32-float there's no quantisation
    // step at all so dither would be pure added noise.
    // In Normalize pass-1 we always write a 32-float intermediate
    // (no quantisation) so dither would be pure added noise —
    // gate it off. Pass 2 will dither into the final 16-bit
    // container if appropriate. For Off/AnalyzeOnly we use the
    // existing 16-bit-only TPDF policy. The generators are owned by
    // the caller so Normalize pass-2 can reuse pristine ones.
    const bool ditherActive = ! normalizing
                              && options.dither
                              && options.bitDepth == 16
                              && ! writer.isFloatingPoint();

    // Writer-callback used by FinalResampler. Captures `writer`, the
    // total written counter, peakAmplitude, and writerError so we can
    // unwind cleanly on IO failure mid-stream.
    const auto writeStereo = [&](const float* interleaved, int frames) -> bool
    {
        if (frames <= 0) return true;
        // Feed the loudness analyzer with the pre-dither,
        // post-final-resample stereo program. This is the
        // exact audio that will land in the output file (modulo
        // the small dither contribution which we deliberately
        // exclude from the measurement).
        if (analyzer)
        {
            // Deinterleave into temporary channel pointers for
            // the analyzer's planar API. Stack-buffered to stay
            // RT-clean even though we're on a worker.
            std::vector<float> aL(static_cast<size_t>(frames));
            std::vector<float> aR(static_cast<size_t>(frames));
            for (int i = 0; i < frames; ++i)
            {
                aL[static_cast<size_t>(i)] = interleaved[static_cast<size_t>(i) * 2 + 0];
                aR[static_cast<size_t>(i)] = interleaved[static_cast<size_t>(i) * 2 + 1];
            }
            const float* ch[2] = { aL.data(), aR.data() };
            analyzer->process(ch, 2, frames);
        }
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
        if (!writer.writeFromFloatArrays(writePtrs, kOutputChannels, frames))
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
            pass1File.deleteFile();
            return fail(MixdownFailureCode::Cancelled, "Cancelled.");
        }
        const int blockFrames = static_cast<int>(
            std::min<int64_t>(kBlockFrames, totalProjectFrames - projectFramesRendered));

        mixBus.clear(0, blockFrames);
        float* mixL = mixBus.getWritePointer(0);
        float* mixR = mixBus.getWritePointer(1);

        // Clip retirement (Phase 5 step 1d, mirrors the pre-1d
        // skip-pull logic). Walk the flat clip list once per
        // block; for any clip whose timeline window + processor
        // tail has fully elapsed, detach it from the BusGraph so
        // the audio path stops pulling its transport. The flat
        // walk is cheap (project clip counts are O(10²) at the
        // top end) and the per-detach `juce::CriticalSection`
        // acquisition is uncontended (mixdown is single-threaded).
        for (auto& cp : clips)
        {
            if (cp->retired) continue;
            if (projectFramesRendered >= cp->timelineEndFrames + cp->tailFrames)
            {
                busGraph.detachClip(cp->id, cp->summingSource.get());
                cp->retired = true;
            }
        }

        // Canonical pump: BusGraph sums every active TrackRuntime
        // (each summing its clips through the TrackChain) directly
        // into the mix bus. Identical pull discipline to the live
        // engine — same `getNextAudioBlock(info)` entry point,
        // same internal block partitioning, same per-track chain
        // invocation order.
        juce::AudioSourceChannelInfo busInfo(&mixBus, 0, blockFrames);
        busGraph.getNextAudioBlock(busInfo);

        // Master volume: applied to the summed mix bus BEFORE peak
        // metering, loudness analysis, dither and the final
        // resample so the rendered file matches what the user
        // hears live (where `AudioEngine::setMasterGain` applies
        // the same scalar through `AudioSourcePlayer::setGain`).
        if (! juce::approximatelyEqual(snapshot.masterGain, 1.0F))
        {
            mixBus.applyGain(0, blockFrames, snapshot.masterGain);
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

        // Stream every block as non-final; the resampler is flushed
        // once after the loop (below) so the same drain path serves
        // both the natural end and the early FX-terminated break.
        if (!finalResampler.push(mixInterleaved.data(), blockFrames,
                                 /*endOfInput*/ false, writeStereo))
        {
            pass1File.deleteFile();
            if (writerError.isNotEmpty())
                return fail(MixdownFailureCode::Io, writerError);
            return fail(MixdownFailureCode::Invalid,
                        juce::String("Final resample failed: ") +
                            (finalResampler.error() ? finalResampler.error() : "unknown"));
        }

        projectFramesRendered += blockFrames;

        // Early termination: once we have rendered the guaranteed
        // minimum (timeline + clip tail + user silence) AND both shared
        // FX tails have decayed, stop — don't burn the full fail-safe
        // cap rendering inaudible decay (or trailing silence for a
        // project with inactive FX).
        if (projectFramesRendered >= minRenderFrames && busGraph.sharedFxTerminated())
        {
            break;
        }

        const auto now = juce::Time::getMillisecondCounter();
        if (now - lastProgressMs >= kProgressMinIntervalMs)
        {
            // Progress budget:
            //   - Off / AnalyzeOnly: render owns 0–90%.
            //   - Normalize:        pass 1 owns 0–45%, pass 2 owns 45–90%.
            // Finalize keeps its 10% headroom in either case.
            const double renderShare = normalizing ? 45.0 : 90.0;
            const double pct = (static_cast<double>(projectFramesRendered)
                                / static_cast<double>(juce::jmax<int64_t>(1, totalProjectFrames)))
                               * renderShare;
            broadcastProgress(bridge, pct,
                              normalizing ? "normalize-pass1"
                                          : (analyzing ? "analyze" : "render"));
            lastProgressMs = now;
        }
    }

    // Flush the final resampler exactly once (0-frame, end-of-input)
    // so any samples buffered inside libsamplerate are drained for
    // both the natural-end and early-break exit paths. Pass-through
    // (no resample) treats this as a harmless 0-frame write.
    if (!finalResampler.push(mixInterleaved.data(), 0, /*endOfInput*/ true, writeStereo))
    {
        pass1File.deleteFile();
        if (writerError.isNotEmpty())
            return fail(MixdownFailureCode::Io, writerError);
        return fail(MixdownFailureCode::Invalid,
                    juce::String("Final resample flush failed: ") +
                        (finalResampler.error() ? finalResampler.error() : "unknown"));
    }

    // Actual rendered length (ms) — computed from the frames we really
    // rendered, which may be shorter than the upper-bound
    // `totalProjectFrames` when the FX-terminated early break fired.
    // Drives the pad-to-length safety net and (via outputFramesWritten)
    // the reported duration.
    const double effectiveRenderLengthMs =
        static_cast<double>(projectFramesRendered) / projectFramesPerMs;

    // Tear down the BusGraph BEFORE we return so any per-runtime
    // release of DSP state happens while the clip transports it
    // still references are still alive. This mirrors
    // `AudioEngine::shutdown` discipline. Stack unwind would also do
    // this safely (busGraph is declared after clips), but doing it
    // explicitly makes the lifetime contract obvious.
    busGraph.clear();

    (void) peakAmplitude;

    Pass1Result result;
    result.ok = true;
    result.clips = std::move(clips);
    result.outputFramesWritten = outputFramesWritten;
    result.effectiveRenderLengthMs = effectiveRenderLengthMs;
    result.preClampPeakAmplitude = preClampPeakAmplitude;
    result.clippedSampleCount = clippedSampleCount;
    return result;
}

} // namespace mixdown_render_pass1
} // namespace silverdaw
