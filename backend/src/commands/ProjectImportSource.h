#pragma once

#include <map>
#include <optional>

#include <juce_core/juce_core.h>

namespace silverdaw
{

struct SourceLibraryItem
{
    juce::var data;
    juce::String id;
    /** Library kind — "stem" or "sample". */
    juce::String kind;
    /** The artifact folder the file lives in: "stems", "samples", "scratches" or
     *  "recordings". A recording is a sample by kind but keeps its own folder and
     *  its own group in the importer, so kind alone cannot place or present it. */
    juce::String category;
    juce::File file;
    juce::File root;
};

struct SourceProjectImport
{
    juce::String name;
    std::map<juce::String, SourceLibraryItem> library;
    std::map<juce::String, juce::var> scratchPatterns;
};

// Reads only importable persisted records without constructing ProjectState.
std::optional<SourceProjectImport> loadSourceProjectImport(const juce::File& sourceProjectFile,
                                                           juce::String& error);

} // namespace silverdaw
