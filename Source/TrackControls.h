#pragma once

#include <JuceHeader.h>

#include "Track.h"

//==============================================================================
/**
    Left-column controls for a single track: name, mute / solo / remove, and
    a gain slider. Sits in the fixed controls column to the left of the
    horizontally-scrolling timeline.
*/
class TrackControls : public juce::Component
{
public:
    explicit TrackControls (Track& track);
    ~TrackControls() override = default;

    /** Called when the user clicks the remove (X) button. */
    std::function<void()> onRemoveRequested;

    Track& getTrack() noexcept { return track; }

    void paint (juce::Graphics& g) override;
    void resized() override;

private:
    Track& track;

    juce::Label      nameLabel;
    juce::TextButton muteButton    { "M" };
    juce::TextButton soloButton    { "S" };
    juce::TextButton removeButton  { "X" };
    juce::Slider     gainSlider;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (TrackControls)
};
