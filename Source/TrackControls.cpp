#include "TrackControls.h"

//==============================================================================
TrackControls::TrackControls (Track& t)
    : track (t)
{
    addAndMakeVisible (nameLabel);
    nameLabel.setText (track.getName(), juce::dontSendNotification);
    nameLabel.setJustificationType (juce::Justification::centredLeft);
    nameLabel.setFont (juce::Font (14.0f, juce::Font::bold));
    nameLabel.setEditable (false, true);
    nameLabel.onTextChange = [this] { track.setName (nameLabel.getText()); };

    auto setupToggle = [this] (juce::TextButton& b, juce::Colour onColour)
    {
        addAndMakeVisible (b);
        b.setClickingTogglesState (true);
        b.setColour (juce::TextButton::buttonOnColourId, onColour);
    };

    setupToggle (muteButton, juce::Colours::darkred);
    setupToggle (soloButton, juce::Colours::goldenrod);

    muteButton.onClick = [this] { track.setMuted (muteButton.getToggleState()); };
    soloButton.onClick = [this] { track.setSoloed (soloButton.getToggleState()); };

    addAndMakeVisible (removeButton);
    removeButton.setColour (juce::TextButton::buttonColourId, juce::Colours::darkgrey);
    removeButton.onClick = [this]
    {
        if (onRemoveRequested != nullptr)
            onRemoveRequested();
    };

    addAndMakeVisible (gainSlider);
    gainSlider.setSliderStyle (juce::Slider::LinearHorizontal);
    gainSlider.setTextBoxStyle (juce::Slider::TextBoxRight, false, 44, 18);
    gainSlider.setRange (0.0, 1.5, 0.001);
    gainSlider.setSkewFactorFromMidPoint (1.0);
    gainSlider.setValue (track.getGain(), juce::dontSendNotification);
    gainSlider.onValueChange = [this] { track.setGain ((float) gainSlider.getValue()); };
}

//==============================================================================
void TrackControls::paint (juce::Graphics& g)
{
    auto bounds = getLocalBounds();

    g.setColour (juce::Colour::fromRGB (40, 40, 44));
    g.fillRoundedRectangle (bounds.toFloat(), 4.0f);

    g.setColour (juce::Colour::fromRGB (60, 60, 64));
    g.drawRoundedRectangle (bounds.toFloat().reduced (0.5f), 4.0f, 1.0f);
}

void TrackControls::resized()
{
    auto bounds = getLocalBounds().reduced (6);

    auto topRow = bounds.removeFromTop (22);
    nameLabel.setBounds   (topRow.removeFromLeft (bounds.getWidth() - 72));
    topRow.removeFromLeft (4);
    muteButton.setBounds  (topRow.removeFromLeft (22));
    topRow.removeFromLeft (2);
    soloButton.setBounds  (topRow.removeFromLeft (22));
    topRow.removeFromLeft (2);
    removeButton.setBounds (topRow.removeFromLeft (22));

    bounds.removeFromTop (6);
    gainSlider.setBounds (bounds.removeFromTop (24));
}
