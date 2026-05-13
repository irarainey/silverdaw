#pragma once

#include <JuceHeader.h>

#include "Track.h"

//==============================================================================
/**
    Mixes a collection of Tracks into a single PositionableAudioSource that an
    AudioTransportSource can drive. Handles solo/mute logic and per-track gain.

    Tracks can be added and removed from the message thread while audio is
    running; an internal lock guards the list against the audio thread.
*/
class TrackMixerSource : public juce::PositionableAudioSource
{
public:
    TrackMixerSource();
    ~TrackMixerSource() override;

    //==============================================================================
    /** Adds a track. Takes ownership. Returns a non-owning pointer so the UI
        can keep a reference to it. */
    Track* addTrack (std::unique_ptr<Track> track);

    /** Removes (and destroys) the track at the given index. */
    void removeTrack (int index);

    int    getNumTracks() const;
    Track* getTrack (int index) const;

    //==============================================================================
    // PositionableAudioSource
    void prepareToPlay (int samplesPerBlockExpected, double sampleRate) override;
    void releaseResources() override;
    void getNextAudioBlock (const juce::AudioSourceChannelInfo& info) override;

    void  setNextReadPosition (juce::int64 newPosition) override;
    juce::int64 getNextReadPosition() const override;
    juce::int64 getTotalLength() const override;
    bool  isLooping() const override { return false; }

private:
    //==============================================================================
    mutable juce::CriticalSection         tracksLock;
    std::vector<std::unique_ptr<Track>>   tracks;

    juce::AudioBuffer<float>              tempBuffer;
    int    currentBlockSize { 0 };
    double currentSampleRate { 0.0 };
    bool   prepared { false };

    juce::int64 currentPosition { 0 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (TrackMixerSource)
};
