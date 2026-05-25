#pragma once

#include "Log.h"
#include "WarpProcessor.h"

#include <atomic>
#include <cstdint>
#include <functional>
#include <limits>
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <memory>
#include <optional>
#include <unordered_map>

namespace silverdaw
{

/**
 * Positionable wrapper that prepends a configurable number of silent
 * samples to a child source. Used to give each clip a timeline offset so
 * the same global transport position drives all tracks in sync.
 *
 * Effectively shifts the child's audio along the global timeline:
 *   global ms < offset  → silence
 *   global ms >= offset → child at (global ms - offset)
 *
 * The offset is `std::atomic` so the message thread can change it while
 * the audio thread is reading without coarse locking.
 */
class OffsetSource : public juce::PositionableAudioSource
{
  public:
    explicit OffsetSource(juce::PositionableAudioSource* child) : child(child) {}

    /** Where in the master timeline this clip starts playing. */
    void setOffsetSamples(juce::int64 samples)
    {
        offsetSamples.store(juce::jmax(static_cast<juce::int64>(0), samples));
    }
    juce::int64 getOffsetSamples() const
    {
        return offsetSamples.load();
    }

    /** Where in the SOURCE FILE this clip starts reading (the `inMs`
     *  field in `ProjectState`). Lets a trimmed clip skip the leading
     *  audio of the source without re-decoding. */
    void setInSourceSamples(juce::int64 samples)
    {
        inSourceSamples.store(juce::jmax(static_cast<juce::int64>(0), samples));
    }
    juce::int64 getInSourceSamples() const
    {
        return inSourceSamples.load();
    }

    /** How many samples this clip plays for from `inSourceSamples`
     *  onward. Anything beyond `[offsetSamples, offsetSamples + clipDurationSamples)`
     *  on the master timeline emits silence. Zero is treated as
     *  "play to end of source" — used for legacy un-trimmed clips. */
    void setClipDurationSamples(juce::int64 samples)
    {
        clipDurationSamples.store(juce::jmax(static_cast<juce::int64>(0), samples));
    }
    juce::int64 getClipDurationSamples() const
    {
        return clipDurationSamples.load();
    }

    static juce::int64 timelineSamplesForSourceSamples(juce::int64 sourceSamples, WarpProcessor* w) noexcept
    {
        if (sourceSamples <= 0) return sourceSamples;
        if (w == nullptr || !w->isActive()) return sourceSamples;
        const double ratio = w->getTempoRatio();
        return WarpProcessor::timelineSamplesForSourceSamples(sourceSamples, ratio);
    }

    /** Install (or remove with nullptr) the warp processor for this
     *  clip. Pointer is non-owning — the AudioEngine's per-clip
     *  `Track::warp` unique_ptr owns the lifetime. Safe to set / clear
     *  from the message thread; the audio thread reads via the same
     *  pointer on every block. */
    void setWarpProcessor(WarpProcessor* w) noexcept
    {
        warp.store(w, std::memory_order_release);
    }

    void requestWarpReseek() noexcept
    {
        warpReseekRequested.store(true, std::memory_order_release);
    }

    void prepareToPlay(int blockSize, double sampleRate) override
    {
        cachedBlockSize.store(blockSize, std::memory_order_relaxed);
        cachedSampleRate.store(sampleRate, std::memory_order_relaxed);
        if (child != nullptr)
        {
            child->prepareToPlay(blockSize, sampleRate);
        }
        if (auto* w = warp.load(std::memory_order_acquire))
        {
            w->prepareToPlay(blockSize);
        }
    }

    void releaseResources() override
    {
        if (child != nullptr)
        {
            child->releaseResources();
        }
    }

    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override
    {
        if (child == nullptr || info.numSamples <= 0)
        {
            info.clearActiveBufferRegion();
            return;
        }

        const juce::int64 startPos = position.load(std::memory_order_relaxed);
        const juce::int64 endPos = startPos + info.numSamples;
        const juce::int64 clipStart = offsetSamples.load();
        auto* currentWarp = warp.load(std::memory_order_acquire);
        const juce::int64 sourceDur = clipDurationSamples.load();
        const juce::int64 dur = timelineSamplesForSourceSamples(sourceDur, currentWarp);
        // `clipEnd = INT64_MAX` when `dur == 0`, so an un-trimmed clip
        // plays to the end of the source (existing behaviour).
        const juce::int64 clipEnd =
            dur > 0 ? clipStart + dur : std::numeric_limits<juce::int64>::max();
        const juce::int64 inSrc = inSourceSamples.load();

        if (endPos <= clipStart || startPos >= clipEnd)
        {
            // Entirely outside the clip window: emit silence.
            info.clearActiveBufferRegion();
            position.store(endPos, std::memory_order_relaxed);
            return;
        }

        // Split the block into [silent leading | audible middle | silent trailing].
        const juce::int64 audibleStart = juce::jmax(startPos, clipStart);
        const juce::int64 audibleEnd = juce::jmin(endPos, clipEnd);
        const int silentLeading = static_cast<int>(audibleStart - startPos);
        const int audibleSamples = static_cast<int>(audibleEnd - audibleStart);
        const int silentTrailing = info.numSamples - silentLeading - audibleSamples;

        if (silentLeading > 0)
        {
            juce::AudioSourceChannelInfo lead = info;
            lead.numSamples = silentLeading;
            lead.clearActiveBufferRegion();
        }

        if (audibleSamples > 0)
        {
            juce::AudioSourceChannelInfo audible = info;
            audible.startSample += silentLeading;
            audible.numSamples = audibleSamples;
            // Read from the source at: how-far-into-the-clip + in-source-offset.
            const juce::int64 sourcePos = (audibleStart - clipStart) + inSrc;
            auto* w = currentWarp;
            if (w != nullptr && w->isActive())
            {
                // Warp path. The processor owns the source cursor and
                // advances it internally as it consumes input. We only
                // need to re-seek when playback is discontinuous —
                // i.e. on the very first block of a fresh play-from
                // (lastBlockEnded), or when the master clock has
                // jumped (audibleStart != lastAudibleEnd). During
                // steady-state playback we leave the cursor alone so
                // the stretcher reaches its steady-state quality —
                // resetting every block was the source of the jittery
                // audio reported on project reload.
                const bool forceReseek = warpReseekRequested.exchange(false, std::memory_order_acq_rel);
                if (forceReseek || lastBlockEnded || audibleStart != lastAudibleEnd)
                {
                    const double ratio = w->getTempoRatio();
                    const juce::int64 warpedSourcePos =
                        inSrc + static_cast<juce::int64>(static_cast<double>(audibleStart - clipStart) * ratio);
                    w->seekSource(warpedSourcePos);
                }
                pullThroughWarp(*w, *audible.buffer, audible.startSample, audibleSamples);
                lastBlockEnded = false;
                lastAudibleEnd = audibleEnd;
            }
            else
            {
                child->setNextReadPosition(sourcePos);
                child->getNextAudioBlock(audible);
                lastBlockEnded = false;
                lastAudibleEnd = audibleEnd;
            }
        }
        else
        {
            // We didn't pull this block — the next time we do, the
            // warp processor's source cursor is going to be stale (it
            // has been sitting waiting for us). Force a re-seek on the
            // next active block by remembering that we just ended.
            lastBlockEnded = true;
        }

        if (silentTrailing > 0)
        {
            juce::AudioSourceChannelInfo trail = info;
            trail.startSample += silentLeading + audibleSamples;
            trail.numSamples = silentTrailing;
            trail.clearActiveBufferRegion();
        }

        position.store(endPos, std::memory_order_relaxed);
        // Record what `setNextReadPosition` should see next if playback
        // is contiguous — used by the discontinuity check there to
        // distinguish routine per-block advancement from a real seek.
        lastBlockEndPosition.store(endPos, std::memory_order_relaxed);
    }

    void setNextReadPosition(juce::int64 newPosition) override
    {
        // Detect discontinuity (master seek) vs routine "next block"
        // call. JUCE's plumbing (BufferingAudioSource etc.) calls
        // `setNextReadPosition` on its source EVERY block as part of
        // normal advancement — a one-block-worth jump from
        // `lastBlockEndPosition` is not a seek. Treat anything farther
        // than 2× the largest sane block size as a real seek so the
        // warp processor flushes its history; otherwise leave its
        // cursor alone and let `getNextAudioBlock` advance it
        // naturally.
        const juce::int64 prevExpected = lastBlockEndPosition.load(std::memory_order_relaxed);
        constexpr juce::int64 kContinuityToleranceSamples = 16384;
        const bool isDiscontinuous =
            prevExpected < 0 ||
            std::abs(newPosition - prevExpected) > kContinuityToleranceSamples;

        position.store(newPosition, std::memory_order_relaxed);
        const juce::int64 off = offsetSamples.load();
        const juce::int64 inSrc = inSourceSamples.load();
        if (child != nullptr)
        {
            // Match the read-position offset the next getNextAudioBlock
            // call will use. Warped playback maps timeline offset through
            // the effective tempo ratio; unwarped playback remains 1:1.
            juce::int64 childPos = inSrc;
            if (newPosition >= off)
            {
                if (auto* w = warp.load(std::memory_order_acquire); w != nullptr && w->isActive())
                {
                    childPos = inSrc + static_cast<juce::int64>(
                        static_cast<double>(newPosition - off) * w->getTempoRatio());
                }
                else
                {
                    childPos = (newPosition - off) + inSrc;
                }
            }
            child->setNextReadPosition(childPos);
        }
        if (isDiscontinuous)
        {
            // Genuine seek — flush the warp processor's internal
            // history so the next pull starts fresh from the new
            // source position. Routine per-block advances skip this.
            lastBlockEnded = true;
            if (auto* w = warp.load(std::memory_order_acquire))
            {
                w->requestReset();
            }
        }
    }

    juce::int64 getNextReadPosition() const override
    {
        return position.load(std::memory_order_relaxed);
    }

    juce::int64 getTotalLength() const override
    {
        return child != nullptr ? child->getTotalLength() + offsetSamples.load() : offsetSamples.load();
    }

    bool isLooping() const override
    {
        return false;
    }

  private:
    juce::PositionableAudioSource* child = nullptr;
    // Read-position invariant
    // ───────────────────────
    // `position` is treated as the *next read position* in the parent
    // (`PositionableAudioSource`) sample frame. It is only ever advanced
    // by `getNextAudioBlock()` (called on the audio thread by JUCE's
    // `BufferingAudioSource` / `AudioTransportSource` plumbing) and
    // reset by `setNextReadPosition()` (called on the message thread
    // when the engine seeks or rebuilds the source chain).
    //
    // Those two callers never run concurrently for the same source under
    // normal JUCE usage, BUT `getNextReadPosition()` may be called from
    // the message thread (e.g. metering, UI polling) while the audio
    // thread is mid-block. Making `position` `std::atomic` makes that
    // observation well-defined under the C++ memory model without
    // requiring a coarse lock around the audio callback. Relaxed
    // ordering is sufficient: there is no other state we need to
    // synchronise with the position value.
    std::atomic<juce::int64> position{0};
    std::atomic<juce::int64> offsetSamples{0};
    std::atomic<juce::int64> inSourceSamples{0};
    std::atomic<juce::int64> clipDurationSamples{0};
    /** Non-owning warp pointer. nullptr means "no warp" — the normal
     *  fast path. Lifetime is managed by the owning `Track::warp`
     *  unique_ptr in AudioEngine. */
    std::atomic<WarpProcessor*> warp{nullptr};
    std::atomic<bool> warpReseekRequested{false};
    /** Bookkeeping so we don't reset the warp processor on every
     *  block during steady-state playback. `lastAudibleEnd` is the
     *  master-clock position one-past-end of the previous block's
     *  audible region; when the next block's `audibleStart` matches,
     *  playback is contiguous and we let the WarpProcessor advance
     *  its source cursor internally without a re-seek. */
    juce::int64 lastAudibleEnd{std::numeric_limits<juce::int64>::min()};
    /** Master-clock position one-past-end of the last block we
     *  produced. Used by `setNextReadPosition` to distinguish a
     *  routine per-block advance (a JUCE BufferingAudioSource sets
     *  the read position before each pull) from a genuine seek that
     *  warrants flushing the warp processor's internal history.
     *  -1 sentinel means "no block produced yet". */
    std::atomic<juce::int64> lastBlockEndPosition{-1};
    bool lastBlockEnded{true};
    std::atomic<int> cachedBlockSize{0};
    std::atomic<double> cachedSampleRate{0.0};

    /** Pull `numSamples` of warped audio into `dest[startSample..]`,
     *  sourcing from `child` via the WarpProcessor's callback. Called
     *  from `getNextAudioBlock` only when the audible region falls
     *  inside the clip's timeline window AND the warp processor is
     *  active. */
    void pullThroughWarp(WarpProcessor& w, juce::AudioBuffer<float>& dest, int startSample, int numSamples)
    {
        if (child == nullptr || numSamples <= 0) return;
        const int chans = juce::jmin(dest.getNumChannels(), 2);
        // Build per-channel write pointers into the audible region.
        // The output buffer is `dest`'s active region — channels live
        // in separate float planes per JUCE convention.
        float* outPtrs[8] = {nullptr};
        const int outChannels = juce::jmin(chans, 8);
        for (int c = 0; c < outChannels; ++c)
        {
            outPtrs[c] = dest.getWritePointer(c, startSample);
        }
        // Source-read callback. The WarpProcessor demands chunks of
        // input at absolute source-sample positions; we seek the
        // reader and pull into a scratch JUCE buffer aliased over the
        // caller-supplied raw pointers. The reader's own
        // `getNextAudioBlock` does the heavy lifting (file decode +
        // resample to engine sample rate); we just sit between it and
        // the stretcher.
        auto readSource =
            [this, outChannels](float* const* dst, juce::int64 srcPos, int n)
        {
            child->setNextReadPosition(srcPos);
            juce::AudioBuffer<float> bufView(const_cast<float**>(dst), outChannels, n);
            juce::AudioSourceChannelInfo info(&bufView, 0, n);
            child->getNextAudioBlock(info);
        };
        w.process(outPtrs, numSamples, readSource);
    }
};

/**
 * Authoritative master transport clock.
 *
 * Wraps the engine's mixer at the top of the audio graph so the chain is
 *
 *   tracks[i] → OffsetSource → AudioTransportSource → MixerAudioSource
 *                                                    → MasterClockSource → device
 *
 * `MasterClockSource` is the single source of truth for "what time is it":
 *
 *   - When `playing == false` it CLEARS the active buffer region and does
 *     NOT pull from the child. This is the gate — no per-track transport
 *     advances when the gate is closed because nobody is pulling from
 *     them, and we don't emit a stale audio tail after pause/stop.
 *   - When `playing == true` it pulls from the child and advances
 *     `positionSamples` by `info.numSamples`. The increment happens AFTER
 *     the pull, so `getPositionSamples()` reads as "next read position",
 *     matching JUCE's `getNextReadPosition` convention.
 *
 * `positionSamples` is in DEVICE-SAMPLE-RATE samples (i.e. project
 * timeline samples at the device's current rate). On device sample-rate
 * change, `prepareToPlay` rescales the stored counter to preserve real
 * time (seconds), not samples.
 *
 * Per-track `latencySamples` (also in device-sample-rate samples) is
 * subtracted when fanning out seeks to per-track transports so that a
 * future latency-introducing processor (e.g. Rubber Band) can declare
 * its delay via `Track::latencySamples` and the engine will read its
 * input that many samples earlier. Today every track reports 0; the
 * compensation path is wired but a no-op.
 */
class MasterClockSource : public juce::AudioSource
{
  public:
    explicit MasterClockSource(juce::AudioSource& child) : child(child) {}

    void prepareToPlay(int blockSize, double newSampleRate) override
    {
        const double oldSr = sampleRate.load(std::memory_order_acquire);
        if (oldSr > 0.0 && newSampleRate > 0.0 && oldSr != newSampleRate)
        {
            const juce::int64 oldPos = positionSamples.load(std::memory_order_relaxed);
            const auto rescaled = static_cast<juce::int64>(
                (static_cast<double>(oldPos) * newSampleRate) / oldSr);
            positionSamples.store(rescaled, std::memory_order_relaxed);
        }
        sampleRate.store(newSampleRate, std::memory_order_release);
        silverdaw::log::info("master",
                             "prepareToPlay block=" + juce::String(blockSize) + " sr=" + juce::String(newSampleRate));
        child.prepareToPlay(blockSize, newSampleRate);
    }

    void releaseResources() override
    {
        silverdaw::log::info("master", "releaseResources");
        child.releaseResources();
    }

    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override
    {
        const auto startTicks = juce::Time::getHighResolutionTicks();
        const auto count = callbackCount.fetch_add(1, std::memory_order_relaxed) + 1;
        if (!playing.load(std::memory_order_acquire))
        {
            info.clearActiveBufferRegion();
            maybeLogAudioPerf(count, startTicks, info.numSamples);
            return;
        }

        child.getNextAudioBlock(info);
        positionSamples.fetch_add(static_cast<juce::int64>(info.numSamples), std::memory_order_relaxed);
        maybeLogAudioPerf(count, startTicks, info.numSamples);
    }

    void setPlaying(bool p) noexcept
    {
        playing.store(p, std::memory_order_release);
    }
    bool isPlaying() const noexcept
    {
        return playing.load(std::memory_order_acquire);
    }

    void setPositionSamples(juce::int64 p) noexcept
    {
        positionSamples.store(juce::jmax(static_cast<juce::int64>(0), p), std::memory_order_relaxed);
    }
    juce::int64 getPositionSamples() const noexcept
    {
        return positionSamples.load(std::memory_order_relaxed);
    }

    double getSampleRate() const noexcept
    {
        return sampleRate.load(std::memory_order_acquire);
    }

  private:
    void maybeLogAudioPerf(std::uint64_t count, juce::int64 startTicks, int numSamples) const
    {
        // Diagnostic heartbeat: ~1 s at 48 kHz / 512 buffer. Logged only
        // when diagnostic logging is enabled; keep the audio-thread work
        // bounded to a couple of tick reads and simple arithmetic.
        if ((count % 100) != 0) return;
        const auto elapsedTicks = juce::Time::getHighResolutionTicks() - startTicks;
        const double elapsedMs = juce::Time::highResolutionTicksToSeconds(elapsedTicks) * 1000.0;
        const double sr = sampleRate.load(std::memory_order_acquire);
        const double budgetMs = sr > 0.0 && numSamples > 0 ? (static_cast<double>(numSamples) * 1000.0) / sr : 0.0;
        const double pct = budgetMs > 0.0 ? (elapsedMs / budgetMs) * 100.0 : 0.0;
        silverdaw::log::debug("perf.audio",
                              "cb#" + juce::String(static_cast<juce::int64>(count)) +
                                  " playing=" + juce::String(playing.load(std::memory_order_acquire) ? 1 : 0) +
                                  " pos=" + juce::String(positionSamples.load(std::memory_order_relaxed)) +
                                  " elapsedMs=" + juce::String(elapsedMs, 3) +
                                  " budgetMs=" + juce::String(budgetMs, 3) +
                                  " budgetPct=" + juce::String(pct, 1));
    }

    juce::AudioSource& child;
    std::atomic<juce::int64> positionSamples{0};
    std::atomic<bool> playing{false};
    // Device sample rate. Updated only from `prepareToPlay`, read from
    // message-thread accessors that convert samples↔ms. The audio
    // callback path itself doesn't read it.
    std::atomic<double> sampleRate{0.0};
    // Diagnostic counter for the audio-callback heartbeat log.
    std::atomic<std::uint64_t> callbackCount{0};

    static_assert(std::atomic<juce::int64>::is_always_lock_free,
                  "MasterClockSource requires a lock-free 64-bit atomic counter on the audio thread");
};

/**
 * Headless audio engine.
 *
 * Owns a `juce::AudioDeviceManager` plus a mixer source that combines
 * any number of tracks. Each track wraps an `AudioFormatReaderSource`
 * (the actual file reader) inside an `AudioTransportSource` (which
 * handles thread-safe start/stop and position tracking).
 *
 * All public methods are designed to be called from the JUCE message
 * thread. Internal access from the audio thread is handled by JUCE's
 * own locking inside `MixerAudioSource` / `AudioTransportSource`.
 */
class AudioEngine
{
  public:
    AudioEngine();
    ~AudioEngine();

    AudioEngine(const AudioEngine&) = delete;
    AudioEngine& operator=(const AudioEngine&) = delete;

    /**
     * Open the audio device. Returns the device error string, or empty
     * on success.
     *
     * `preferredTypeName` / `preferredDeviceName` come from the
     * `SILVERDAW_OUTPUT_DEVICE_TYPE` / `SILVERDAW_OUTPUT_DEVICE_NAME`
     * env vars passed by the main process at spawn time. When both are
     * non-empty we try to honour them; on any failure (saved device
     * unplugged, type missing on this platform, etc.) we silently fall
     * back to the system default and set `outFellBackToDefault = true`
     * so the bridge can surface a "your saved device wasn't available"
     * notice to the renderer.
     */
    juce::String initialise(const juce::String& preferredTypeName = {},
                            const juce::String& preferredDeviceName = {},
                            bool* outFellBackToDefault = nullptr);

    /** Close everything. Safe to call multiple times. */
    void shutdown();

    /**
     * Load `filePath` into a new playable source keyed by `clipId`. Replaces
     * an existing source with the same id. `initialOffsetMs` is the clip's
     * starting position on the global timeline (passed atomically with
     * the load so the clip never briefly plays at offset 0 before the
     * intended offset is applied). `initialGain` is applied before the clip
     * enters the mixer so muted / solo-silenced clips never leak a block of
     * audio at unity gain. Returns true on success.
     * On failure, `outError` (if non-null) is populated with a short diagnostic.
     */
    bool addClip(const juce::String& clipId, const juce::File& filePath, double initialOffsetMs = 0.0,
                 double inMs = 0.0, double clipDurationMs = 0.0, float initialGain = 1.0F,
                 juce::String* outError = nullptr);

    /** Remove the playable source with the given clip id. Returns true if it existed. */
    bool removeClip(const juce::String& clipId);

    /**
     * Set the linear gain applied to `clipId` (0.0 = silent, 1.0 = unity).
     * Used for mute/solo: the frontend computes effective audibility per
     * logical track and `Main.cpp` fans the resulting gain out to every
     * clip on that track. Returns true if the clip existed.
     */
    bool setClipGain(const juce::String& clipId, float gain);

    /** Start playback of all tracks from their current positions. */
    void play();

    /** Pause playback (positions retained). */
    void pause();

    /** Stop playback and rewind all tracks to t=0. */
    void stop();

    /**
     * Seek every track's playhead to `ms`. Position is clamped to 0; if a
     * track's duration is shorter than `ms` JUCE's transport clamps it to
     * the end internally. Safe to call whether or not playback is active.
     */
    void setPositionMs(double ms);

    /**
     * Set the timeline offset (ms) for `clipId` — i.e. how far along the
     * global timeline its audio should start.
     *
     * Fast path (transport stopped or paused): updates the
     * `OffsetSource`'s atomic offset only. Lock-free, no allocations,
     * cheap enough to call per-frame during a clip drag.
     *
     * Fallback (transport actively playing): additionally rebuilds the
     * track's source chain so the `BufferingAudioSource`'s prefetch can't
     * serve ~0.7 s of stale audio at the OLD offset. The current
     * playback position is preserved across the rebuild.
     *
     * Returns true if the clip existed.
     */
    bool setClipOffsetMs(const juce::String& clipId, double offsetMs);
    bool commitClipOffset(const juce::String& clipId);

    /**
     * Atomically update a clip's trim window — used by edge-drag trim,
     * split, and duplicate. All three fields are applied together so a
     * trim that simultaneously moves `startMs` and `inMs` doesn't
     * desynchronise the audible playback for one block. Returns true
     * if the clip existed.
     */
    bool setClipTrim(const juce::String& clipId, double startMs, double inMs, double clipDurationMs);

    /**
     * Per-clip warp + pitch shift control. Each parameter is wrapped
     * in `std::optional` so the renderer can drive a single field
     * (e.g. just `semitones`) without echoing the rest. `enabled`
     * gates the whole engine — when `false` the per-clip
     * `WarpProcessor` is destroyed and the audio path falls back to
     * the unwarped reader-source pull. `tempoRatio` follows the
     * Silverdaw convention `projectBpm / sourceBpm` (i.e. "how many
     * times faster the clip plays at native pitch"); the processor
     * inverts it internally before feeding Rubber Band.
     *
     * Pitch is `semitones + cents/100` combined into a scale via
     * `2^(s/12)`. Both fields are independent of `tempoRatio` —
     * Rubber Band changes pitch without affecting tempo and vice
     * versa.
     *
     * Mode (`'rhythmic'` / `'tonal'` / `'complex'`) is captured at
     * construction time only; changing modes destroys and recreates
     * the processor. Default is `'rhythmic'` (R2 / Faster) so the
     * audio thread stays inside its CPU budget even with many active
     * warped clips; the user can escalate per-clip from the Warp
     * settings dialog when quality matters.
     *
     * Returns true if the clip existed.
     */
    bool setClipWarp(const juce::String& clipId,
                     std::optional<bool> enabled,
                     std::optional<juce::String> mode,
                     std::optional<double> tempoRatio,
                     std::optional<double> semitones,
                     std::optional<double> cents);

    /** True if any track is currently playing. */
    bool isPlaying() const;

    /** Master playhead position in milliseconds (uses the first track as clock). */
    double getPositionMs() const;

    /** Duration of the clip's underlying file in milliseconds. Returns 0
     *  if the clip doesn't exist or its reader is unavailable.
     */
    double getClipDurationMs(const juce::String& clipId) const;

    // -------------------------------------------------------------------
    // Preview voice — an independent playback path used by the Clip
    // Editor dialog. Plays a single audio file, optionally windowed to a
    // [inMs, inMs + durationMs] selection. Its own play/pause is
    // independent of the project transport, but `loadPreview()` /
    // `playPreview()` callers are expected to pause the project
    // transport first when they want exclusive playback.
    // -------------------------------------------------------------------

    /** Open `filePath`, build the preview source chain, and attach it to
     *  the top mixer. `inMs` is where in the source the selection starts;
     *  `durationMs` is the selection length (0 = play to end of source).
     *  Returns true on success and increments the preview generation.
     */
    bool loadPreview(const juce::File& filePath, double inMs, double durationMs,
                     juce::String* outError = nullptr,
                     std::optional<bool> initialWarpEnabled = std::nullopt,
                     std::optional<juce::String> initialWarpMode = std::nullopt,
                     std::optional<double> initialTempoRatio = std::nullopt,
                     std::optional<double> initialSemitones = std::nullopt,
                     std::optional<double> initialCents = std::nullopt);

    /** Detach the preview source from the top mixer and release its
     *  reader. Increments the preview generation so any in-flight async
     *  state targeting the old preview is discarded. Safe to call when
     *  no preview is loaded.
     */
    void unloadPreview();

    /** Start preview playback. No-op if no preview is loaded. */
    void playPreview();

    /** Pause preview playback (position retained). */
    void pausePreview();

    /** Stop preview playback and seek to the start of the window. */
    void stopPreview();

    /** Seek within the preview window. `ms` is relative to the window
     *  start (0..durationMs).
     */
    void setPreviewPositionMs(double ms);

    /** Current preview position relative to the window start (ms). */
    double getPreviewPositionMs() const;

    /** Preview window length in ms (mirrors the argument to loadPreview). */
    double getPreviewDurationMs() const;

    /** True if the preview transport is currently playing. */
    bool isPreviewPlaying() const;

    /** True if a preview source is currently loaded. */
    bool isPreviewLoaded() const;

    /**
     * Per-preview warp configuration. Mirrors the per-clip
     * `setClipWarp` API exactly so the Clip Editor's preview voice
     * sounds the way the timeline clip will play. No-op when no
     * preview is loaded; the next `loadPreview()` resets the warp
     * state to bypass.
     */
    bool setPreviewWarp(std::optional<bool> enabled,
                        std::optional<juce::String> mode,
                        std::optional<double> tempoRatio,
                        std::optional<double> semitones,
                        std::optional<double> cents);

    /** Monotonic counter incremented on every load/unload. Used by the
     *  bridge layer to discard stale state broadcasts after the user
     *  has closed and re-opened the editor. */
    juce::int64 getPreviewGeneration() const;

    /**
     * Effective output latency in milliseconds — the gap between the
     * sample the audio thread is currently writing and the sample the
     * user actually hears.
     *
     * Two layers:
     *
     *   1. `juce::AudioIODevice::getOutputLatencyInSamples()` — the
     *      driver's own report. Accurate for ASIO (≈0) and WASAPI
     *      shared (10–30 ms); the driver knows its own buffer chain.
     *
     *   2. Bluetooth-headset heuristic. Windows only sees the buffer
     *      it controls — the BT radio + headset DSP + headset DAC
     *      pipeline (another 100–250 ms) is invisible to the OS, so
     *      a stock A2DP/SBC headset reads back ~10 ms of latency but
     *      actually lags by ~200 ms. When the active device name
     *      matches a conservative Bluetooth pattern (`bluetooth`,
     *      `airpods`, `hands-free`, `wireless headphones`, …) we
     *      add a baseline `kBluetoothLatencyMs` of additional
     *      compensation on top of the driver's value.
     *
     * Used by the `PlayheadEmitter` to compensate the broadcast
     * playhead position during playback so the visual cursor matches
     * what the user is hearing. Paused / seek reads stay raw — see
     * `getPositionMs()` for the rationale.
     */
    double getOutputLatencyMs() const;

    /** Convenience: just the Bluetooth heuristic part of the latency
     *  calculation, in milliseconds. Returns 0 when the active device
     *  is not a recognised Bluetooth device. Useful for the renderer
     *  to label the transport-bar chip with "BT" when non-zero. */
    double getHeuristicExtraLatencyMs() const;

    /**
     * Access to the engine's `AudioFormatManager`. Used by the waveform
     * subsystem to open an independent reader for peaks computation on a
     * worker thread without disturbing the audio source the engine is
     * already streaming.
     */
    juce::AudioFormatManager& getFormatManager() noexcept
    {
        return formatManager;
    }

    // ─── Audio output device control ────────────────────────────────────
    //
    // Cached snapshot of the available device types + names plus the
    // current selection. Rebuilt lazily on construction, after a switch,
    // and on explicit `refreshAudioDevices()` requests — `scanForDevices()`
    // on some Windows backends (notably ASIO) can take tens of ms, so we
    // don't pay it on every UI dropdown open.
    struct DeviceTypeListing
    {
        juce::String typeName;
        juce::StringArray deviceNames;
    };

    struct AudioDevicesSnapshot
    {
        juce::Array<DeviceTypeListing> types;
        /** Active device type ("Windows Audio", "DirectSound", "ASIO" …) or empty when no device is open. */
        juce::String currentTypeName;
        /** Active output device name, or empty when no device is open. */
        juce::String currentDeviceName;
        double currentSampleRate = 0.0;
        int currentBufferSize = 0;
        /** Total effective output latency in ms — driver-reported +
         *  Bluetooth heuristic. See `AudioEngine::getOutputLatencyMs()`. */
        double outputLatencyMs = 0.0;
        /** Just the Bluetooth heuristic part. Non-zero signals "the
         *  driver under-reports — we've added a baseline guess for
         *  the radio/headset pipeline." Surfaces a "BT" hint in the
         *  renderer. */
        double heuristicExtraLatencyMs = 0.0;
        /** Set when `initialise()` tried to honour persisted prefs but
         *  the saved device couldn't be found — surfaces a one-shot
         *  "saved device unavailable" notice to the renderer. */
        bool fellBackToDefault = false;
    };

    /** Return the cached snapshot. Cheap; safe to call from message-thread
     *  bridge handlers without rescanning. */
    AudioDevicesSnapshot getAudioDevicesSnapshot() const
    {
        return devicesSnapshot;
    }

    /** Force a rescan of every device type and refresh the cached
     *  snapshot. Use sparingly — `scanForDevices()` is the slow step. */
    void refreshAudioDevices();

    /** True once the engine has performed at least one full
     *  `refreshAudioDevices()`. Used by the bridge dispatcher to do
     *  one mandatory scan on the renderer's first
     *  `AUDIO_DEVICES_REQUEST` (which seeds the dropdowns) while
     *  letting subsequent requests respect their `refresh` flag. */
    bool hasScannedAllDevices() const noexcept
    {
        return hasFullyScanned;
    }

    /**
     * Switch the active output device.
     *
     *  - Both empty ⇒ revert to the system default (`initialiseWithDefaultDevices`).
     *  - Otherwise: switch the device type if needed, then apply the
     *    chosen output device name. On any failure the previous setup
     *    is restored and an error string returned; the cached snapshot
     *    is left pointing at whichever device is actually live after
     *    the dust settles.
     *
     * Returns an empty string on success, or a short diagnostic on
     * failure.
     */
    juce::String selectOutputDevice(const juce::String& typeName, const juce::String& deviceName);

    /**
     * Register a callback fired when the audio device list changes
     * (USB plug / unplug, Windows audio reconfig). The callback runs on
     * the JUCE message thread and is invoked AFTER the engine has
     * already refreshed `devicesSnapshot` and applied any forced
     * fallback (a removed current device drops back to default
     * silently). Used by `Main.cpp` to rebroadcast `AUDIO_DEVICES_LIST`
     * to the renderer.
     */
    using DeviceListChangedCallback = std::function<void()>;
    void setDeviceListChangedCallback(DeviceListChangedCallback cb)
    {
        deviceListChangedCallback = std::move(cb);
    }

  private:
    struct Track
    {
        std::unique_ptr<juce::AudioFormatReaderSource> readerSource;
        std::unique_ptr<OffsetSource> offsetSource;
        std::unique_ptr<juce::AudioTransportSource> transportSource;
        /** Owns the lifetime of the per-clip warp engine when warp is
         *  enabled. nullptr means "no warp / bypass" — the fast path.
         *  `OffsetSource` holds a non-owning atomic pointer to the
         *  same instance for the audio thread to find on every block. */
        std::unique_ptr<WarpProcessor> warp;
        double sampleRate = 44100.0;
        int numChannels = 2;
        /**
         * Future-processor latency declared by this track, in
         * device-sample-rate samples. Subtracted from the master read
         * position when seeking this track's transport so a delayed
         * processor (e.g. Rubber Band) downstream of the reader still
         * outputs samples aligned to the master clock. 0 means
         * "this track introduces no latency" — true for every track
         * today; plumbed for Phase 3+ warp work.
         */
        juce::int64 latencySamples = 0;

        /**
         * Set true when the clip's offset has changed since the
         * `BufferingAudioSource` was last (re)built. The buffer can hold
         * up to ~0.7 s of prefetched audio at the OLD offset; if we let
         * playback start with a dirty buffer the listener hears the old
         * position briefly before the prefetch catches up. `play()`
         * checks this flag and rebuilds the source chain for any track
         * whose offset has moved while paused — preserving the master
         * position so the audible result is sample-accurate.
         */
        bool prefetchDirty = false;
    };

    /** Compute a per-track transport seek position (in seconds) given the master sample position. */
    double trackSeekSecondsFor(const Track& track, juce::int64 masterSamples) const;

    /** Invalidate a track's BufferingAudioSource so a fresh prefetch starts from the current offset. */
    void rebuildTrackPrefetch(Track& track);

    /** Rebuild every track flagged `prefetchDirty` synchronously,
     *  in one tight loop. Called by `play()` so the very next audio
     *  block reads from a fresh buffer chain. */
    void flushAllDirtyRebuildsSync();

    /** Rebuild ONE dirty track and, if more remain, re-arm the
     *  debounce timer so the next rebuild happens on the next
     *  message-thread tick. Called from the timer callback —
     *  chunking the work like this keeps the message thread
     *  responsive when several tracks need their prefetch buffer
     *  rebuilt after a drag (each `rebuildTrackPrefetch` blocks the
     *  message thread for ~1 s while JUCE's BufferingAudioSource is
     *  initialised, which would otherwise pile up and starve the
     *  WebSocket dispatcher of CPU time). */
    void flushDirtyRebuilds();

    /**
     * Debounce timer: setClipOffsetMs (paused fast path) restarts a
     * ~150 ms one-shot. When it fires we flush dirty rebuilds so a
     * subsequent `play()` sees a hot prefetch buffer instead of paying
     * the rebuild cost at play time. The timer fires on the JUCE
     * message thread, same thread that mutates the tracks map, so
     * no extra synchronisation is needed.
     */
    class RebuildTimer : public juce::Timer
    {
      public:
        explicit RebuildTimer(AudioEngine& e) : engine(e) {}
        void timerCallback() override
        {
            stopTimer();
            engine.flushDirtyRebuilds();
        }

      private:
        AudioEngine& engine;
    };
    RebuildTimer rebuildTimer{*this};
    static constexpr int kRebuildDebounceMs = 150;

    juce::AudioDeviceManager deviceManager;
    juce::AudioSourcePlayer sourcePlayer;
    juce::MixerAudioSource mixer;

    /** Refresh `devicesSnapshot` from the current `deviceManager`
     *  state. Optionally calls `scanForDevices()` first when `rescan`
     *  is true (slow on some backends; pass false to just refresh the
     *  current-device fields after a switch). */
    void rebuildDevicesSnapshot(bool rescan);

    /** Internal: react to `audioDeviceListChanged` from JUCE. If the
     *  currently-active device is no longer present (USB pulled, etc.)
     *  drop back to the system default; otherwise just refresh the
     *  cached snapshot. Either way, fires `deviceListChangedCallback`
     *  so the bridge rebroadcasts. */
    void onDeviceListChanged();

    AudioDevicesSnapshot devicesSnapshot;
    DeviceListChangedCallback deviceListChangedCallback;
    /** Latches true on the first `rebuildDevicesSnapshot(true)` call.
     *  Lets the bridge dispatcher distinguish "renderer's first
     *  request, please populate the list" from "renderer's
     *  cheap-refresh request, give them whatever's cached". */
    bool hasFullyScanned = false;

    /** Bridge between JUCE's `ChangeListener` API and our private
     *  `onDeviceListChanged()` method. Construct-time bound to the
     *  enclosing engine; registered with `deviceManager` in
     *  `initialise()`. */
    class DeviceChangeListener : public juce::ChangeListener
    {
      public:
        explicit DeviceChangeListener(AudioEngine& e) : engine(e) {}
        void changeListenerCallback(juce::ChangeBroadcaster*) override
        {
            engine.onDeviceListChanged();
        }

      private:
        AudioEngine& engine;
    };
    DeviceChangeListener deviceChangeListener{*this};

    // MasterClockSource wraps the mixer; the top mixer in turn mixes the
    // master (project tracks) with the preview voice so the Clip Editor
    // can play in parallel with — or in place of — the project transport.
    // Construction order: mixer → master → topMixer (refs the others).
    MasterClockSource master{mixer};
    juce::MixerAudioSource topMixer;
    juce::AudioFormatManager formatManager;

    // Background thread used by each track's read-ahead buffer so file I/O
    // never happens on the audio thread.
    juce::TimeSliceThread readAheadThread{"silverdaw-readahead"};

    std::unordered_map<juce::String, std::unique_ptr<Track>> tracks; // keyed by clipId

    // Preview voice — single playable file, windowed by an OffsetSource
    // configured with offsetSamples=0, inSourceSamples=inMs, and
    // clipDurationSamples=durationMs. Mutated only on the message thread;
    // the audio thread reads atomics on `previewTransport`.
    struct Preview
    {
        std::unique_ptr<juce::AudioFormatReaderSource> readerSource;
        std::unique_ptr<OffsetSource> offsetSource;
        std::unique_ptr<juce::AudioTransportSource> transportSource;
        /** Owns the preview-voice warp engine when warp is enabled.
         *  Lifetime mirrors `Track::warp`; the OffsetSource holds a
         *  non-owning atomic pointer to the same instance so the
         *  audio thread can fast-path it on every block. */
        std::unique_ptr<WarpProcessor> warp;
        double sampleRate = 44100.0;
        double inMs = 0.0;
        double durationMs = 0.0;
        double sourceDurationMs = 0.0;
    };
    Preview preview;
    std::atomic<juce::int64> previewGeneration{0};
};

} // namespace silverdaw
