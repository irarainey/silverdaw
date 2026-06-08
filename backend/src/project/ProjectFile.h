#pragma once

#include "ProjectState.h"

#include <juce_core/juce_core.h>

namespace silverdaw::ProjectFile
{

// Bump when older loaders cannot safely read the format; newer schemas are refused.
constexpr int kCurrentSchemaVersion = 1;

struct LoadResult
{
    bool ok{false};
    juce::String error;
    int schemaVersion{0};
};

// Saves an atomic wrapper around the ValueTree JSON so root-level metadata can evolve independently.
juce::Result save(const juce::File& file, const ProjectState& project);

// Persists view state without saving unrelated project edits or flipping dirty.
juce::Result saveViewState(const juce::File& file, double viewScrollX, double playheadMs,
                           const juce::String& selectedTrackId, bool fxPanelOpen);

// Leaves `project` untouched on failure; unknown compatible keys are ignored.
LoadResult load(const juce::File& file, ProjectState& project);

} // namespace silverdaw::ProjectFile
