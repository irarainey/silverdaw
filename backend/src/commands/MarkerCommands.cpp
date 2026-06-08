#include "MarkerCommands.h"

#include "PayloadHelpers.h"
#include "ProjectState.h"

namespace silverdaw
{

using silverdaw::bridge::tryGetRequiredString;

void applyMarkerAdd(const juce::var& payload, ProjectState& projectState)
{
    const auto markerId = tryGetRequiredString(payload, "markerId").value_or(juce::String{});
    const auto posVar = payload.getProperty("positionMs", juce::var());
    if (!markerId.isEmpty() && (posVar.isDouble() || posVar.isInt() || posVar.isInt64()))
    {
        const double positionMs = static_cast<double>(posVar);
        if (positionMs >= 0.0)
        {
            projectState.addMarker(markerId, positionMs);
        }
    }
}

void applyMarkerMove(const juce::var& payload, ProjectState& projectState)
{
    const auto markerId = tryGetRequiredString(payload, "markerId").value_or(juce::String{});
    const auto posVar = payload.getProperty("positionMs", juce::var());
    if (!markerId.isEmpty() && (posVar.isDouble() || posVar.isInt() || posVar.isInt64()))
    {
        const double positionMs = static_cast<double>(posVar);
        if (positionMs >= 0.0)
        {
            projectState.moveMarker(markerId, positionMs);
        }
    }
}

void applyMarkerRemove(const juce::var& payload, ProjectState& projectState)
{
    const auto markerId = tryGetRequiredString(payload, "markerId").value_or(juce::String{});
    if (markerId.isNotEmpty())
    {
        projectState.removeMarker(markerId);
    }
}

} // namespace silverdaw
