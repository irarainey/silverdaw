#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class ProjectState;


void applyMarkerAdd(const juce::var& payload, ProjectState& projectState);
void applyMarkerMove(const juce::var& payload, ProjectState& projectState);
void applyMarkerRemove(const juce::var& payload, ProjectState& projectState);

} // namespace silverdaw
