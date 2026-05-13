#include "TrackLane.h"

//==============================================================================
TrackLane::TrackLane (Track& t, const juce::AudioTransportSource& tr, double pps)
    : track (t),
      transport (tr),
      pixelsPerSecond (pps)
{
    setOpaque (true);
    setMouseCursor (juce::MouseCursor::PointingHandCursor);
    track.getThumbnail().addChangeListener (this);
}

TrackLane::~TrackLane()
{
    track.getThumbnail().removeChangeListener (this);
}

void TrackLane::setPixelsPerSecond (double pps)
{
    pixelsPerSecond = juce::jmax (1.0, pps);
    repaint();
}

//==============================================================================
void TrackLane::paint (juce::Graphics& g)
{
    auto bounds = getLocalBounds();

    // Lane background.
    g.setColour (juce::Colour::fromRGB (24, 24, 28));
    g.fillRect (bounds);

    g.setColour (juce::Colour::fromRGB (50, 50, 54));
    g.drawHorizontalLine (bounds.getBottom() - 1,
                          (float) bounds.getX(), (float) bounds.getRight());

    auto& thumb = track.getThumbnail();
    const double totalSeconds = thumb.getTotalLength();
    if (totalSeconds > 0.0)
    {
        const double offsetSeconds = track.getStartOffsetSeconds();
        const int    clipX = (int) std::round (offsetSeconds * pixelsPerSecond);
        const int    clipW = juce::jmax (1, (int) std::round (totalSeconds * pixelsPerSecond));

        juce::Rectangle<int> clipBounds (clipX, bounds.getY() + 4,
                                         clipW, bounds.getHeight() - 8);

        // Skip the expensive thumbnail draw when the dirty region misses the clip
        // (e.g. a playhead-only repaint of a 3-pixel-wide strip).
        if (g.getClipBounds().intersects (clipBounds))
        {
            g.setColour (juce::Colour::fromRGB (35, 55, 80));
            g.fillRect (clipBounds);

            g.setColour (juce::Colours::lightblue);
            thumb.drawChannels (g, clipBounds.reduced (1, 1), 0.0, totalSeconds, 1.0f);

            g.setColour (juce::Colour::fromRGB (90, 130, 180));
            g.drawRect (clipBounds, 1);
        }
    }

    // Playhead — vertical line if it falls within this lane's visible area.
    const auto playheadSeconds = transport.getCurrentPosition();
    const int  playheadX = (int) std::round (playheadSeconds * pixelsPerSecond);
    if (playheadX >= bounds.getX() && playheadX <= bounds.getRight())
    {
        g.setColour (juce::Colours::white.withAlpha (0.7f));
        g.drawLine ((float) playheadX, (float) bounds.getY(),
                    (float) playheadX, (float) bounds.getBottom(),
                    1.0f);
    }
}

//==============================================================================
void TrackLane::mouseDown (const juce::MouseEvent& e)
{
    isDragging      = false;
    mouseDownX      = e.x;
    dragStartOffset = track.getStartOffsetSeconds();
}

void TrackLane::mouseDrag (const juce::MouseEvent& e)
{
    const int dx = e.x - mouseDownX;

    if (! isDragging && std::abs (dx) >= kDragThresholdPx)
        isDragging = true;

    if (! isDragging)
        return;

    const double dt = (double) dx / pixelsPerSecond;
    track.setStartOffsetSeconds (dragStartOffset + dt);
    repaint();

    if (onClipMoved != nullptr)
        onClipMoved();
}

void TrackLane::mouseUp (const juce::MouseEvent& e)
{
    if (! isDragging)
    {
        // Treat as a click — seek to that point on the timeline.
        const double seconds = juce::jmax (0.0, (double) e.x / pixelsPerSecond);
        if (onSeekRequested != nullptr)
            onSeekRequested (seconds);
    }

    isDragging = false;
}

//==============================================================================
void TrackLane::changeListenerCallback (juce::ChangeBroadcaster* source)
{
    if (source == &track.getThumbnail())
    {
        // AudioThumbnail broadcasts progress updates very frequently while a
        // file is being scanned. Coalesce them: schedule one repaint at most
        // every 50 ms instead of repainting on every change.
        if (! thumbnailRepaintPending)
        {
            thumbnailRepaintPending = true;
            startTimer (50);
        }
    }
}

void TrackLane::timerCallback()
{
    stopTimer();
    thumbnailRepaintPending = false;

    auto& thumb = track.getThumbnail();
    const double totalSeconds = thumb.getTotalLength();
    if (totalSeconds <= 0.0)
    {
        repaint();
        return;
    }

    // Only repaint the area occupied by the clip, not the entire (possibly
    // tens-of-thousands-of-pixels-wide) lane.
    const double offsetSeconds = track.getStartOffsetSeconds();
    const int    clipX = (int) std::round (offsetSeconds * pixelsPerSecond);
    const int    clipW = juce::jmax (1, (int) std::round (totalSeconds * pixelsPerSecond));
    repaint (clipX, 0, clipW, getHeight());
}
