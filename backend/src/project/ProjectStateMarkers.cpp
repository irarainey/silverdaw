#include "ProjectState.h"

#include <cmath>

namespace silverdaw
{

int ProjectState::getMarkerCount() const noexcept
{
    const auto markers = root.getChildWithName(kMarkers);
    return markers.isValid() ? markers.getNumChildren() : 0;
}

bool ProjectState::hasMarkerNear(double positionMs, double toleranceMs) const noexcept
{
    const auto markers = root.getChildWithName(kMarkers);
    for (int i = 0; i < markers.getNumChildren(); ++i)
    {
        const auto marker = markers.getChild(i);
        if (marker.hasType(kMarker) &&
            std::abs(static_cast<double>(marker.getProperty(kPositionMs, 0.0)) - positionMs) <=
                toleranceMs)
            return true;
    }
    return false;
}

bool ProjectState::addMarker(const juce::String& markerId, double positionMs)
{
    if (markerId.isEmpty() || positionMs < 0.0)
    {
        return false;
    }

    juce::ValueTree markers;
    for (int i = 0; i < root.getNumChildren(); ++i)
    {
        const auto child = root.getChild(i);
        if (child.hasType(kMarkers))
        {
            markers = child;
            break;
        }
    }
    if (!markers.isValid())
    {
        markers = juce::ValueTree(kMarkers);
        root.addChild(markers, -1, nullptr);
    }

    for (int i = 0; i < markers.getNumChildren(); ++i)
    {
        auto marker = markers.getChild(i);
        const double markerPositionMs = static_cast<double>(marker.getProperty(kPositionMs, 0.0));
        if (marker.hasType(kMarker) && std::abs(markerPositionMs - positionMs) < 0.5
            && marker.getProperty(kId).toString() != markerId)
        {
            return true;
        }
        if (marker.hasType(kMarker) && marker.getProperty(kId).toString() == markerId)
        {
            marker.setProperty(kPositionMs, positionMs, &undoManager);
            return true;
        }
    }

    juce::ValueTree marker(kMarker);
    marker.setProperty(kId, markerId, nullptr);
    marker.setProperty(kPositionMs, positionMs, nullptr);
    markers.addChild(marker, -1, &undoManager);
    return true;
}

bool ProjectState::moveMarker(const juce::String& markerId, double positionMs)
{
    if (markerId.isEmpty() || positionMs < 0.0)
    {
        return false;
    }

    auto markers = root.getChildWithName(kMarkers);
    if (!markers.isValid())
    {
        return false;
    }

    for (int i = 0; i < markers.getNumChildren(); ++i)
    {
        auto marker = markers.getChild(i);
        const double markerPositionMs = static_cast<double>(marker.getProperty(kPositionMs, 0.0));
        if (marker.hasType(kMarker) && std::abs(markerPositionMs - positionMs) < 0.5
            && marker.getProperty(kId).toString() != markerId)
        {
            return false;
        }
        if (marker.hasType(kMarker) && marker.getProperty(kId).toString() == markerId)
        {
            const double current = markerPositionMs;
            if (std::abs(current - positionMs) < 0.01)
            {
                return true;
            }
            marker.setProperty(kPositionMs, positionMs, &undoManager);
            return true;
        }
    }
    return false;
}

bool ProjectState::removeMarker(const juce::String& markerId)
{
    if (markerId.isEmpty())
    {
        return false;
    }

    auto markers = root.getChildWithName(kMarkers);
    if (!markers.isValid())
    {
        return false;
    }

    for (int i = markers.getNumChildren() - 1; i >= 0; --i)
    {
        auto marker = markers.getChild(i);
        if (marker.hasType(kMarker) && marker.getProperty(kId).toString() == markerId)
        {
            markers.removeChild(marker, &undoManager);
            return true;
        }
    }
    return false;
}

} // namespace silverdaw
