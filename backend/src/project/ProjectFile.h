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

// Persists view state (and the silent monitoring metronome toggles) without saving unrelated
// project edits or flipping dirty.
juce::Result saveViewState(const juce::File& file, double viewScrollX, double viewPxPerSecond,
                           double playheadMs, const juce::String& selectedTrackId, bool fxPanelOpen,
                           bool metronomeEnabled, bool clipEditorMetronomeEnabled,
                           std::optional<ProjectState::TimelineSelectionView> timelineSelection = std::nullopt);

// Removes the given library items from an ALREADY-SAVED project file in place, leaving
// every other saved field (and the user's other unsaved in-memory edits) untouched. Used
// by a "clean up project files" removal: the item's generated file has just been deleted
// from disk, so pruning only that item from the saved project keeps the file consistent
// without committing anything else. A no-op success when the file does not exist yet (an
// unsaved project has nothing persisted to prune) or the items are already absent.
juce::Result removeLibraryItems(const juce::File& file, const juce::StringArray& itemIds);

// Leaves `project` untouched on failure; unknown compatible keys are ignored.
LoadResult load(const juce::File& file, ProjectState& project);

} // namespace silverdaw::ProjectFile
