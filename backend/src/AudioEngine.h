#pragma once

#include "Log.h"

#include <atomic>
#include <cstdint>
#include <limits>
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <memory>
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

    void prepareToPlay(int blockSize, double sampleRate) override
    {
        if (child != nullptr)
        {
            child->prepareToPlay(blockSize, sampleRate);
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
        const juce::int64 dur = clipDurationSamples.load();
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
            child->setNextReadPosition(sourcePos);
            child->getNextAudioBlock(audible);
        }

        if (silentTrailing > 0)
        {
            juce::AudioSourceChannelInfo trail = info;
            trail.startSample += silentLeading + audibleSamples;
            trail.numSamples = silentTrailing;
            trail.clearActiveBufferRegion();
        }

        position.store(endPos, std::memory_order_relaxed);
    }

    void setNextReadPosition(juce::int64 newPosition) override
    {
        position.store(newPosition, std::memory_order_relaxed);
        const juce::int64 off = offsetSamples.load();
        const juce::int64 inSrc = inSourceSamples.load();
        if (child != nullptr)
        {
            // Match the read-position offset the next getNextAudioBlock
            // call will use, so a seek immediately followed by a pull
            // produces aligned audio (no half-block of stale samples).
            child->setNextReadPosition(newPosition >= off ? (newPosition - off) + inSrc : inSrc);
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
        const auto count = callbackCount.fetch_add(1, std::memory_order_relaxed) + 1;
        // Diagnostic heartbeat: ~1 s at 48 kHz / 512 buffer. Logged so we
        // can tell whether the audio device thread is alive even when no
        // audible output is being produced.
        if ((count % 100) == 0)
        {
            silverdaw::log::debug("master", "cb#" + juce::String(static_cast<juce::int64>(count)) + " playing=" +
                                                juce::String(playing.load(std::memory_order_acquire) ? 1 : 0) +
                                                " pos=" + juce::String(positionSamples.load(std::memory_order_relaxed)));
        }
        if (!playing.load(std::memory_order_acquire))
        {
            info.clearActiveBufferRegion();
            return;
        }

        child.getNextAudioBlock(info);
        positionSamples.fetch_add(static_cast<juce::int64>(info.numSamples), std::memory_order_relaxed);
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

    /** Open the default audio device. Returns the device error string, or empty on success. */
    juce::String initialise();

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

    /**
     * Atomically update a clip's trim window — used by edge-drag trim,
     * split, and duplicate. All three fields are applied together so a
     * trim that simultaneously moves `startMs` and `inMs` doesn't
     * desynchronise the audible playback for one block. Returns true
     * if the clip existed.
     */
    bool setClipTrim(const juce::String& clipId, double startMs, double inMs, double clipDurationMs);

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
                     juce::String* outError = nullptr);

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

    /** Monotonic counter incremented on every load/unload. Used by the
     *  bridge layer to discard stale state broadcasts after the user
     *  has closed and re-opened the editor.
     */
    juce::int64 getPreviewGeneration() const;

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

  private:
    struct Track
    {
        std::unique_ptr<juce::AudioFormatReaderSource> readerSource;
        std::unique_ptr<OffsetSource> offsetSource;
        std::unique_ptr<juce::AudioTransportSource> transportSource;
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

    /** Rebuild a track's BufferingAudioSource so a fresh prefetch starts from the current offset. */
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
        double sampleRate = 44100.0;
        double inMs = 0.0;
        double durationMs = 0.0;
        double sourceDurationMs = 0.0;
    };
    Preview preview;
    std::atomic<juce::int64> previewGeneration{0};
};

} // namespace silverdaw
