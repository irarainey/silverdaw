#pragma once

#include <JuceHeader.h>

//==============================================================================
/**
    One audio track in a project.

    A Track owns the decoder for a single audio file, a per-track resampler so
    that files at different sample rates can be mixed together, and the
    per-track mix state (gain / mute / solo). It exposes itself as a
    PositionableAudioSource so it can be plugged straight into a
    TrackMixerSource.

    All position values exposed via the PositionableAudioSource interface are
    in *device-rate* samples, i.e. the sample rate that was passed to
    prepareToPlay(). The Track converts to/from the file's native rate
    internally.
*/
class Track : public juce::PositionableAudioSource
{
public:
    //==============================================================================
    Track (juce::AudioFormatManager& formatManager,
           juce::AudioThumbnailCache& thumbnailCache);
    ~Track() override;

    //==============================================================================
    /** Loads an audio file into this track. Returns false if the format
        isn't recognised. Safe to call from the message thread while audio
        is running (an internal lock guards the swap). */
    bool loadFile (const juce::File& file);

    const juce::File& getFile() const noexcept   { return file; }
    juce::String getName() const                  { return name; }
    void setName (const juce::String& newName)    { name = newName; }

    //==============================================================================
    // Mix state. All accessors are safe to call from any thread.
    void  setGain (float linearGain) noexcept     { gain.store (linearGain); }
    float getGain() const noexcept                { return gain.load(); }

    void setMuted (bool shouldBeMuted) noexcept   { muted.store (shouldBeMuted); }
    bool isMuted() const noexcept                 { return muted.load(); }

    void setSoloed (bool shouldBeSoloed) noexcept { soloed.store (shouldBeSoloed); }
    bool isSoloed() const noexcept                { return soloed.load(); }

    /** Sets the start time of this track on the project timeline, in seconds.
        Negative values are clamped to zero. Safe to call from any thread. */
    void   setStartOffsetSeconds (double seconds) noexcept
    {
        startOffsetSeconds.store (juce::jmax (0.0, seconds));
    }
    double getStartOffsetSeconds() const noexcept { return startOffsetSeconds.load(); }

    /** Returns the duration of the loaded audio in seconds (independent of
        the device sample rate). Returns 0 when no file is loaded. */
    double getLengthInSeconds() const noexcept;

    //==============================================================================
    juce::AudioThumbnail& getThumbnail() noexcept { return thumbnail; }

    //==============================================================================
    // PositionableAudioSource
    void prepareToPlay (int samplesPerBlockExpected, double sampleRate) override;
    void releaseResources() override;
    void getNextAudioBlock (const juce::AudioSourceChannelInfo& bufferToFill) override;

    void  setNextReadPosition (juce::int64 newPosition) override;
    juce::int64 getNextReadPosition() const override;
    juce::int64 getTotalLength() const override;
    bool  isLooping() const override              { return false; }

private:
    //==============================================================================
    juce::AudioFormatManager&                       formatManager;
    juce::AudioThumbnail                            thumbnail;

    // The audio chain: AudioFormatReaderSource -> ResamplingAudioSource.
    // 'sourceLock' guards swaps in loadFile() against the audio thread.
    juce::CriticalSection                            sourceLock;
    std::unique_ptr<juce::AudioFormatReaderSource>   readerSource;
    std::unique_ptr<juce::ResamplingAudioSource>     resampler;

    juce::File   file;
    juce::String name;

    double fileSampleRate    { 0.0 };
    double deviceSampleRate  { 0.0 };
    int    currentBlockSize  { 0 };
    juce::int64 currentDevicePos { 0 };

    std::atomic<float> gain   { 1.0f };
    std::atomic<bool>  muted  { false };
    std::atomic<bool>  soloed { false };
    std::atomic<double> startOffsetSeconds { 0.0 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (Track)
};
