#include "MainComponent.h"

//==============================================================================
MainComponent::MainComponent()
{
    // ---- Top bar ----------------------------------------------------------
    addAndMakeVisible (addTrackButton);
    addTrackButton.onClick = [this] { addTrackButtonClicked(); };

    addAndMakeVisible (playButton);
    playButton.onClick = [this] { playButtonClicked(); };
    playButton.setColour (juce::TextButton::buttonColourId, juce::Colours::darkgreen);

    addAndMakeVisible (stopButton);
    stopButton.onClick = [this] { stopButtonClicked(); };
    stopButton.setColour (juce::TextButton::buttonColourId, juce::Colours::darkred);

    addAndMakeVisible (timeLabel);
    timeLabel.setText ("0:00.00 / 0:00.00", juce::dontSendNotification);
    timeLabel.setJustificationType (juce::Justification::centredRight);
    timeLabel.setFont (juce::Font (juce::Font::getDefaultMonospacedFontName(),
                                   14.0f, juce::Font::plain));

    // ---- Arrange view -----------------------------------------------------
    addAndMakeVisible (controlsViewport);
    controlsViewport.setViewedComponent (&controlsColumn, false);
    controlsViewport.setScrollBarsShown (false, false);
    controlsColumn.onResized = [this] { layoutArrangeView(); };

    addAndMakeVisible (timelineViewport);
    timelineViewport.setViewedComponent (&timelineContent, false);
    timelineViewport.setScrollBarsShown (true, true);
    timelineContent.onResized = [this] { layoutArrangeView(); };

    // Keep the controls column scrolled to the same Y as the timeline.
    timelineViewport.onVisibleAreaChanged = [this] (const juce::Rectangle<int>& area)
    {
        controlsViewport.setViewPosition (0, area.getY());
    };

    ruler = std::make_unique<TimeRuler> (transportSource, kPixelsPerSecond);
    ruler->onSeekRequested = [this] (double secs) { seekToSeconds (secs); };
    timelineContent.addAndMakeVisible (*ruler);

    // ---- Audio graph ------------------------------------------------------
    formatManager.registerBasicFormats();
    transportSource.addChangeListener (this);
    transportSource.setSource (&mixer);

    setAudioChannels (0, 2);

    startTimerHz (30);
    setSize (1200, 600);
}

MainComponent::~MainComponent()
{
    shutdownAudio();
    transportSource.setSource (nullptr);
}

//==============================================================================
// Audio thread
//==============================================================================
void MainComponent::prepareToPlay (int samplesPerBlockExpected, double sampleRate)
{
    transportSource.prepareToPlay (samplesPerBlockExpected, sampleRate);
}

void MainComponent::getNextAudioBlock (const juce::AudioSourceChannelInfo& bufferToFill)
{
    transportSource.getNextAudioBlock (bufferToFill);
}

void MainComponent::releaseResources()
{
    transportSource.releaseResources();
}

//==============================================================================
// Painting & layout
//==============================================================================
void MainComponent::paint (juce::Graphics& g)
{
    g.fillAll (getLookAndFeel().findColour (juce::ResizableWindow::backgroundColourId));
}

void MainComponent::resized()
{
    auto bounds = getLocalBounds();

    auto topBar = bounds.removeFromTop (50).reduced (10, 8);
    addTrackButton.setBounds (topBar.removeFromLeft (110));
    topBar.removeFromLeft (8);
    playButton.setBounds    (topBar.removeFromLeft (80));
    topBar.removeFromLeft (4);
    stopButton.setBounds    (topBar.removeFromLeft (80));
    topBar.removeFromLeft (12);
    timeLabel.setBounds     (topBar);

    auto arrange = bounds.reduced (10, 0).withTrimmedBottom (10);

    // Controls column: leave a gap at the top to align with the ruler row.
    auto controlsArea = arrange.removeFromLeft (kControlsColumnWidth);
    arrange.removeFromLeft (8);
    controlsViewport.setBounds (controlsArea);

    timelineViewport.setBounds (arrange);

    layoutArrangeView();
}

void MainComponent::layoutArrangeView()
{
    // -- Controls column ----------------------------------------------------
    const int scrollBarThickness = timelineViewport.getScrollBarThickness();
    const int controlsWidth = juce::jmax (kControlsColumnWidth - 2, 100);
    const int totalRowsHeight = (int) trackUis.size() * (kStripHeight + kStripGap);

    // Reserve top space equal to the ruler height so row N in the controls
    // column lines up vertically with lane N in the timeline.
    const int controlsContentHeight = kRulerHeight + totalRowsHeight;
    controlsColumn.setSize (controlsWidth,
                            juce::jmax (controlsContentHeight,
                                        controlsViewport.getHeight()));

    int y = kRulerHeight;
    for (auto& ui : trackUis)
    {
        ui.controls->setBounds (0, y, controlsColumn.getWidth(), kStripHeight);
        y += kStripHeight + kStripGap;
    }

    // -- Timeline content ---------------------------------------------------
    recomputeTimelineSize();

    if (ruler != nullptr)
        ruler->setBounds (0, 0, timelineContent.getWidth(), kRulerHeight);

    y = kRulerHeight;
    for (auto& ui : trackUis)
    {
        ui.lane->setBounds (0, y, timelineContent.getWidth(), kStripHeight);
        y += kStripHeight + kStripGap;
    }

    juce::ignoreUnused (scrollBarThickness);
}

void MainComponent::recomputeTimelineSize()
{
    // Find the rightmost clip end in seconds, then pad a bit so there's
    // always somewhere to drag clips to.
    double maxEndSeconds = 0.0;
    for (auto& ui : trackUis)
    {
        const double end = ui.controls->getTrack().getStartOffsetSeconds()
                          + ui.controls->getTrack().getLengthInSeconds();
        maxEndSeconds = juce::jmax (maxEndSeconds, end);
    }

    constexpr double kTailPadSeconds = 30.0;
    const int neededWidth = (int) std::ceil ((maxEndSeconds + kTailPadSeconds) * kPixelsPerSecond);
    const int minWidth    = timelineViewport.getWidth();
    const int width       = juce::jmax (neededWidth, minWidth);

    const int totalRowsHeight = (int) trackUis.size() * (kStripHeight + kStripGap);
    const int contentHeight   = kRulerHeight + totalRowsHeight;
    const int height          = juce::jmax (contentHeight, timelineViewport.getHeight());

    // Only resize when the bounds actually change; otherwise we trigger a
    // cascade of resized() calls on every child during a mouse-drag and
    // re-layout the entire arrange view on every pixel of movement.
    if (width != timelineContent.getWidth() || height != timelineContent.getHeight())
        timelineContent.setSize (width, height);
}

//==============================================================================
// Button handlers
//==============================================================================
void MainComponent::addTrackButtonClicked()
{
    fileChooser = std::make_unique<juce::FileChooser> (
        "Select an audio file to add as a track...",
        juce::File{},
        "*.wav;*.aif;*.aiff;*.flac;*.ogg;*.mp3");

    const auto flags = juce::FileBrowserComponent::openMode
                     | juce::FileBrowserComponent::canSelectFiles;

    fileChooser->launchAsync (flags, [this] (const juce::FileChooser& chooser)
    {
        const auto file = chooser.getResult();
        if (file != juce::File{})
            addTrackFromFile (file);
    });
}

void MainComponent::playButtonClicked()
{
    if (mixer.getNumTracks() == 0)
        return;

    if (state == TransportState::Paused || state == TransportState::Stopped)
        setTransportState (TransportState::Starting);
    else if (state == TransportState::Playing)
        setTransportState (TransportState::Pausing);
}

void MainComponent::stopButtonClicked()
{
    if (state == TransportState::Paused)
    {
        transportSource.setPosition (0.0);
        setTransportState (TransportState::Stopped);
    }
    else
    {
        setTransportState (TransportState::Stopping);
    }
}

//==============================================================================
// Track management
//==============================================================================
void MainComponent::addTrackFromFile (const juce::File& file)
{
    auto track = std::make_unique<Track> (formatManager,
                                           thumbnailCache,
                                           mixer.getReadAheadThread());
    if (! track->loadFile (file))
    {
        juce::NativeMessageBox::showMessageBoxAsync (
            juce::AlertWindow::WarningIcon,
            "Could not open file",
            "Jackdaw could not find a decoder for: " + file.getFullPathName());
        return;
    }

    Track* rawTrack = mixer.addTrack (std::move (track));

    TrackUI ui;
    ui.controls = std::make_unique<TrackControls> (*rawTrack);
    ui.lane     = std::make_unique<TrackLane> (*rawTrack, transportSource, kPixelsPerSecond);

    // Remove button → find own index and remove.
    auto* rawControls = ui.controls.get();
    ui.controls->onRemoveRequested = [this, rawControls]
    {
        for (size_t i = 0; i < trackUis.size(); ++i)
            if (trackUis[i].controls.get() == rawControls)
            {
                removeTrackAt ((int) i);
                return;
            }
    };

    // Click on lane → seek master transport.
    ui.lane->onSeekRequested = [this] (double secs) { seekToSeconds (secs); };

    // Drag on lane → recompute timeline width so the clip can be moved past
    // the previous tail.
    ui.lane->onClipMoved = [this] { recomputeTimelineSize(); };

    controlsColumn.addAndMakeVisible (*ui.controls);
    timelineContent.addAndMakeVisible (*ui.lane);

    trackUis.push_back (std::move (ui));

    layoutArrangeView();
}

void MainComponent::removeTrackAt (int index)
{
    if (! juce::isPositiveAndBelow (index, (int) trackUis.size()))
        return;

    auto& ui = trackUis[(size_t) index];
    controlsColumn.removeChildComponent (ui.controls.get());
    timelineContent.removeChildComponent (ui.lane.get());

    trackUis.erase (trackUis.begin() + index);
    mixer.removeTrack (index);

    if (mixer.getNumTracks() == 0)
        setTransportState (TransportState::Stopping);

    layoutArrangeView();
}

//==============================================================================
// Transport state machine
//==============================================================================
void MainComponent::setTransportState (TransportState newState)
{
    if (state == newState)
        return;

    state = newState;

    switch (state)
    {
        case TransportState::Stopped:
            playButton.setButtonText ("Play");
            transportSource.setPosition (0.0);
            break;

        case TransportState::Starting:
            transportSource.start();
            break;

        case TransportState::Playing:
            playButton.setButtonText ("Pause");
            break;

        case TransportState::Pausing:
            transportSource.stop();
            break;

        case TransportState::Paused:
            playButton.setButtonText ("Resume");
            break;

        case TransportState::Stopping:
            transportSource.stop();
            break;
    }
}

void MainComponent::seekToSeconds (double seconds)
{
    transportSource.setPosition (juce::jmax (0.0, seconds));
}

void MainComponent::changeListenerCallback (juce::ChangeBroadcaster* source)
{
    if (source == &transportSource)
    {
        if (transportSource.isPlaying())
            setTransportState (TransportState::Playing);
        else if (state == TransportState::Pausing)
            setTransportState (TransportState::Paused);
        else
            setTransportState (TransportState::Stopped);
    }
}

void MainComponent::timerCallback()
{
    const auto pos = transportSource.getCurrentPosition();
    const auto len = transportSource.getLengthInSeconds();

    auto newLabel = formatTime (pos) + " / " + formatTime (len);
    if (newLabel != lastTimeLabel)
    {
        timeLabel.setText (newLabel, juce::dontSendNotification);
        lastTimeLabel = std::move (newLabel);
    }

    const int newX = (int) std::round (pos * kPixelsPerSecond);
    if (newX == lastPlayheadX)
        return;

    auto invalidatePlayheadStrip = [] (juce::Component* c, int oldX, int newPlayheadX)
    {
        if (c == nullptr)
            return;
        const int h = c->getHeight();
        if (oldX >= 0)
            c->repaint (oldX - 1, 0, 3, h);
        c->repaint (newPlayheadX - 1, 0, 3, h);
    };

    invalidatePlayheadStrip (ruler.get(), lastPlayheadX, newX);
    for (auto& ui : trackUis)
        invalidatePlayheadStrip (ui.lane.get(), lastPlayheadX, newX);

    lastPlayheadX = newX;
}

juce::String MainComponent::formatTime (double seconds) const
{
    if (seconds < 0.0 || ! std::isfinite (seconds))
        seconds = 0.0;

    const int   mins = (int) (seconds / 60.0);
    const double rem = seconds - mins * 60.0;
    return juce::String::formatted ("%d:%05.2f", mins, rem);
}
