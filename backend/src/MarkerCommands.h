#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

class ProjectState;

// PROJECT_MARKER_* command handlers. Pure ProjectState mutations, kept out of the
// Main.cpp dispatcher (which owns the shared undo prologue/epilogue). Each
// validates its envelope and applies one marker edit to the project tree.

void applyMarkerAdd(const juce::var& payload, ProjectState& projectState);
void applyMarkerMove(const juce::var& payload, ProjectState& projectState);
void applyMarkerRemove(const juce::var& payload, ProjectState& projectState);

} // namespace silverdaw
