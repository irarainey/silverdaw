#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_core/juce_core.h>
#include <memory>
#include <unordered_map>

namespace jackdaw
{

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
     */
    bool addClip(const juce::String& trackId, const juce::File& filePath);

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

    /** True if any track is currently playing. */
    bool isPlaying() const;

    /** Master playhead position in milliseconds (uses the first track as clock). */
    double getPositionMs() const;

  private:
    struct Track
    {
        std::unique_ptr<juce::AudioFormatReaderSource> readerSource;
        std::unique_ptr<juce::AudioTransportSource> transportSource;
    };

    juce::AudioDeviceManager deviceManager;
    juce::AudioSourcePlayer sourcePlayer;
    juce::MixerAudioSource mixer;
    juce::AudioFormatManager formatManager;

    // Background thread used by each track's read-ahead buffer so file I/O
    // never happens on the audio thread.
    juce::TimeSliceThread readAheadThread{"jackdaw-readahead"};

    std::unordered_map<juce::String, std::unique_ptr<Track>> tracks;
};

} // namespace jackdaw
