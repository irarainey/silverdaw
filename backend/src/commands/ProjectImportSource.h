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
    juce::String kind;
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
