#include "TimeRuler.h"

//==============================================================================
TimeRuler::TimeRuler (const juce::AudioTransportSource& tr, double pps)
    : transport (tr),
      pixelsPerSecond (pps)
{
    setMouseCursor (juce::MouseCursor::PointingHandCursor);
}

void TimeRuler::setPixelsPerSecond (double pps)
{
    pixelsPerSecond = juce::jmax (1.0, pps);
    repaint();
}

//==============================================================================
double TimeRuler::pickMajorTickSeconds() const noexcept
{
    // Aim for major ticks roughly every 80 px. Snap to a "nice" 1/2/5 * 10^n
    // sequence so labels remain readable at any zoom.
    static const double nice[] = { 1.0, 2.0, 5.0, 10.0, 15.0, 30.0, 60.0,
                                   120.0, 300.0, 600.0 };

    const double target = 80.0 / pixelsPerSecond; // target seconds per major tick
    for (auto s : nice)
        if (s >= target)
            return s;
    return nice[std::size (nice) - 1];
}

//==============================================================================
void TimeRuler::paint (juce::Graphics& g)
{
    auto bounds = getLocalBounds();

    g.setColour (juce::Colour::fromRGB (32, 32, 36));
    g.fillRect (bounds);

    g.setColour (juce::Colour::fromRGB (90, 90, 95));
    g.drawHorizontalLine (bounds.getBottom() - 1,
                          (float) bounds.getX(), (float) bounds.getRight());

    const double majorSecs = pickMajorTickSeconds();
    const double minorSecs = majorSecs / 5.0;

    const double endSecs = (double) bounds.getRight() / pixelsPerSecond;

    g.setFont (juce::Font (11.0f));

    // Minor ticks
    g.setColour (juce::Colour::fromRGB (60, 60, 65));
    for (double t = 0.0; t <= endSecs; t += minorSecs)
    {
        const int x = (int) std::round (t * pixelsPerSecond);
        g.drawVerticalLine (x, (float) (bounds.getBottom() - 5),
                               (float) bounds.getBottom());
    }

    // Major ticks + labels
    g.setColour (juce::Colour::fromRGB (170, 170, 180));
    for (double t = 0.0; t <= endSecs; t += majorSecs)
    {
        const int x = (int) std::round (t * pixelsPerSecond);
        g.drawVerticalLine (x, (float) (bounds.getBottom() - 10),
                               (float) bounds.getBottom());

        const int   mins  = (int) (t / 60.0);
        const double rem  = t - mins * 60.0;
        const auto  label = (majorSecs >= 1.0)
            ? juce::String::formatted ("%d:%02d", mins, (int) std::round (rem))
            : juce::String::formatted ("%d:%05.2f", mins, rem);

        g.drawText (label,
                    x + 3, bounds.getY(), 60, bounds.getHeight() - 10,
                    juce::Justification::centredLeft, false);
    }

    // Playhead
    const auto playheadSecs = transport.getCurrentPosition();
    const int  playheadX    = (int) std::round (playheadSecs * pixelsPerSecond);
    if (playheadX >= bounds.getX() && playheadX <= bounds.getRight())
    {
        g.setColour (juce::Colours::white);
        g.drawLine ((float) playheadX, (float) bounds.getY(),
                    (float) playheadX, (float) bounds.getBottom(),
                    1.5f);
    }
}

void TimeRuler::mouseDown (const juce::MouseEvent& e)
{
    const double seconds = juce::jmax (0.0, (double) e.x / pixelsPerSecond);
    if (onSeekRequested != nullptr)
        onSeekRequested (seconds);
}
