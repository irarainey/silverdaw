#pragma once

#include <JuceHeader.h>

//==============================================================================
/**
    A horizontal time ruler. Draws major tick marks at regular intervals along
    its length and a playhead indicator at the current transport position.
    Clicking anywhere on the ruler seeks the master transport.
*/
class TimeRuler  : public juce::Component
{
public:
    TimeRuler (const juce::AudioTransportSource& transport, double pixelsPerSecond);

    /** Fires when the user clicks somewhere on the ruler. */
    std::function<void (double seconds)> onSeekRequested;

    void setPixelsPerSecond (double pps);

    void paint (juce::Graphics& g) override;
    void mouseDown (const juce::MouseEvent& e) override;

private:
    /** Picks a "nice" major tick interval in seconds for the current zoom. */
    double pickMajorTickSeconds() const noexcept;

    const juce::AudioTransportSource& transport;
    double pixelsPerSecond { 100.0 };
};
