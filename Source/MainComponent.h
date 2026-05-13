#pragma once

#include <JuceHeader.h>

#include "TimeRuler.h"
#include "TrackControls.h"
#include "TrackLane.h"
#include "TrackMixerSource.h"

//==============================================================================
/**
    Root window component.

    Owns the project's audio graph and the entire arrangement view. The
    arrangement view is split into two columns:

      * Left  — a fixed-width column of TrackControls (mute/solo/gain), kept
                in vertical sync with the timeline.
      * Right — a horizontally-and-vertically scrolling timeline made of a
                TimeRuler plus one TrackLane per track.

    Click on the ruler or on any track lane to seek the master transport.
    Drag a track lane horizontally to move the clip on the timeline.
*/
class MainComponent  : public juce::AudioAppComponent,
                       private juce::ChangeListener,
                       private juce::Timer
{
public:
    MainComponent();
    ~MainComponent() override;

    //==============================================================================
    void prepareToPlay (int samplesPerBlockExpected, double sampleRate) override;
    void getNextAudioBlock (const juce::AudioSourceChannelInfo& bufferToFill) override;
    void releaseResources() override;

    void paint (juce::Graphics& g) override;
    void resized() override;

private:
    //==============================================================================
    enum class TransportState { Stopped, Starting, Playing, Pausing, Paused, Stopping };

    void setTransportState (TransportState newState);
    void addTrackButtonClicked();
    void playButtonClicked();
    void stopButtonClicked();
    void addTrackFromFile (const juce::File& file);
    void removeTrackAt (int index);

    void layoutArrangeView();
    void recomputeTimelineSize();
    void seekToSeconds (double seconds);

    juce::String formatTime (double seconds) const;

    void changeListenerCallback (juce::ChangeBroadcaster* source) override;
    void timerCallback() override;

    //==============================================================================
    // ---- Constants --------------------------------------------------------
    static constexpr int    kControlsColumnWidth = 220;
    static constexpr int    kStripHeight         = 90;
    static constexpr int    kStripGap            = 4;
    static constexpr int    kRulerHeight         = 24;
    static constexpr double kPixelsPerSecond     = 100.0;

    //==============================================================================
    // ---- Audio graph ------------------------------------------------------
    juce::AudioFormatManager   formatManager;
    juce::AudioThumbnailCache  thumbnailCache { 32 };

    TrackMixerSource           mixer;
    juce::AudioTransportSource transportSource;
    TransportState             state { TransportState::Stopped };

    // ---- Top bar UI -------------------------------------------------------
    juce::TextButton addTrackButton { "Add Track..." };
    juce::TextButton playButton     { "Play" };
    juce::TextButton stopButton     { "Stop" };
    juce::Label      timeLabel;

    // ---- Arrange view -----------------------------------------------------
    /** Inner component that owns the stacked TrackControls. */
    class ControlsColumn : public juce::Component
    {
    public:
        void resized() override { if (onResized != nullptr) onResized(); }
        std::function<void()> onResized;
    };

    /** Viewport that announces vertical-scroll changes so the controls
        column can be kept in sync. */
    class TimelineViewport : public juce::Viewport
    {
    public:
        void visibleAreaChanged (const juce::Rectangle<int>& newVisibleArea) override
        {
            juce::Viewport::visibleAreaChanged (newVisibleArea);
            if (onVisibleAreaChanged != nullptr)
                onVisibleAreaChanged (newVisibleArea);
        }
        std::function<void (const juce::Rectangle<int>&)> onVisibleAreaChanged;
    };

    /** The wide+tall content that sits inside the timeline viewport. */
    class TimelineContent : public juce::Component
    {
    public:
        void resized() override { if (onResized != nullptr) onResized(); }
        std::function<void()> onResized;
    };

    juce::Viewport      controlsViewport;   // hidden scrollbars; scrolled programmatically
    ControlsColumn      controlsColumn;
    TimelineViewport    timelineViewport;
    TimelineContent     timelineContent;

    std::unique_ptr<TimeRuler> ruler;

    struct TrackUI
    {
        std::unique_ptr<TrackControls> controls;
        std::unique_ptr<TrackLane>     lane;
    };
    std::vector<TrackUI> trackUis;

    std::unique_ptr<juce::FileChooser> fileChooser;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MainComponent)
};
