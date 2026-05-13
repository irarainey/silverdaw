#pragma once

#include <JuceHeader.h>

#include "Track.h"

//==============================================================================
/**
    The timeline-side view of a single track.

    Sits inside the horizontally-scrolling timeline and spans the full width
    of the timeline. The clip's waveform is drawn at `startOffsetSeconds`
    pixels-per-second from the left, so each track can begin at a different
    time on the project timeline.

    Mouse interactions:
      * Click  — seek the master transport to that time on the timeline.
      * Drag   — move the clip's start offset on the timeline.

    The click-vs-drag distinction is based on a small movement threshold.
*/
class TrackLane  : public juce::Component,
                   private juce::ChangeListener
{
public:
    TrackLane (Track& track,
               const juce::AudioTransportSource& transport,
               double pixelsPerSecond);
    ~TrackLane() override;

    /** Called when a click on empty timeline (no drag) wants to seek. */
    std::function<void (double seconds)> onSeekRequested;

    /** Called whenever the clip's offset changes (drag). The host may want
        to recompute the total timeline width in response. */
    std::function<void()> onClipMoved;

    void setPixelsPerSecond (double pps);

    Track& getTrack() noexcept { return track; }

    void paint (juce::Graphics& g) override;

    void mouseDown  (const juce::MouseEvent& e) override;
    void mouseDrag  (const juce::MouseEvent& e) override;
    void mouseUp    (const juce::MouseEvent& e) override;

private:
    void changeListenerCallback (juce::ChangeBroadcaster* source) override;

    Track&                               track;
    const juce::AudioTransportSource&    transport;
    double                               pixelsPerSecond { 100.0 };

    // Click/drag state
    static constexpr int kDragThresholdPx = 4;
    bool   isDragging       { false };
    int    mouseDownX       { 0 };
    double dragStartOffset  { 0.0 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (TrackLane)
};
