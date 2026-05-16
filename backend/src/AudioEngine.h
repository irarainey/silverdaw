#pragma once

#include <atomic>
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_core/juce_core.h>
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

    void setOffsetSamples(juce::int64 samples)
    {
        offsetSamples.store(juce::jmax(static_cast<juce::int64>(0), samples));
    }
    juce::int64 getOffsetSamples() const
    {
        return offsetSamples.load();
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
        const juce::int64 off = offsetSamples.load();

        if (endPos <= off)
        {
            // Entirely before the offset: emit silence.
            info.clearActiveBufferRegion();
            position.store(endPos, std::memory_order_relaxed);
            return;
        }

        if (startPos >= off)
        {
            // Entirely past the offset: forward to the child.
            child->setNextReadPosition(startPos - off);
            child->getNextAudioBlock(info);
            position.store(endPos, std::memory_order_relaxed);
            return;
        }

        // Block straddles the offset: silent leading section + audible tail.
        const int silentSamples = static_cast<int>(off - startPos);
        const int audibleSamples = info.numSamples - silentSamples;

        juce::AudioSourceChannelInfo silentInfo = info;
        silentInfo.numSamples = silentSamples;
        silentInfo.clearActiveBufferRegion();

        juce::AudioSourceChannelInfo audibleInfo = info;
        audibleInfo.startSample += silentSamples;
        audibleInfo.numSamples = audibleSamples;
        child->setNextReadPosition(0);
        child->getNextAudioBlock(audibleInfo);

        position.store(endPos, std::memory_order_relaxed);
    }

    void setNextReadPosition(juce::int64 newPosition) override
    {
        position.store(newPosition, std::memory_order_relaxed);
        const juce::int64 off = offsetSamples.load();
        if (child != nullptr)
        {
            child->setNextReadPosition(newPosition >= off ? newPosition - off : 0);
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
     * Load `filePath` into a new track keyed by `trackId`. Replaces an
     * existing track with the same id. Returns true on success.
     * On failure, `outError` (if non-null) is populated with a short diagnostic.
     */
    bool addClip(const juce::String& trackId, const juce::File& filePath, juce::String* outError = nullptr);

    /** Remove the track with the given id. Returns true if it existed. */
    bool removeTrack(const juce::String& trackId);

    /**
     * Set the linear gain applied to `trackId` (0.0 = silent, 1.0 = unity).
     * Used for mute/solo: the frontend computes effective audibility and
     * pushes 0 or 1 per track. Returns true if the track existed.
     */
    bool setTrackGain(const juce::String& trackId, float gain);

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
     * Set the timeline offset (ms) for the clip on `trackId` — i.e. how far
     * along the global timeline its audio should start.
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
     * Returns true if the track existed.
     */
    bool setClipOffsetMs(const juce::String& trackId, double offsetMs);

    /** True if any track is currently playing. */
    bool isPlaying() const;

    /** Master playhead position in milliseconds (uses the first track as clock). */
    double getPositionMs() const;

  private:
    struct Track
    {
        std::unique_ptr<juce::AudioFormatReaderSource> readerSource;
        std::unique_ptr<OffsetSource> offsetSource;
        std::unique_ptr<juce::AudioTransportSource> transportSource;
        double sampleRate = 44100.0;
        int numChannels = 2;
    };

    juce::AudioDeviceManager deviceManager;
    juce::AudioSourcePlayer sourcePlayer;
    juce::MixerAudioSource mixer;
    juce::AudioFormatManager formatManager;

    // Background thread used by each track's read-ahead buffer so file I/O
    // never happens on the audio thread.
    juce::TimeSliceThread readAheadThread{"silverdaw-readahead"};

    std::unordered_map<juce::String, std::unique_ptr<Track>> tracks;
};

} // namespace silverdaw
