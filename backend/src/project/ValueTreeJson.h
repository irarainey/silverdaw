#pragma once

#include <juce_core/juce_core.h>
#include <juce_data_structures/juce_data_structures.h>

namespace silverdaw::ValueTreeJson
{

// `$`-prefixed keys cannot collide with ValueTree property identifiers.
inline constexpr const char* kTypeKey = "$type";
inline constexpr const char* kChildrenKey = "$children";

// Serialises a valid ValueTree into JSON-friendly `$type` / `$children` shape.
juce::var toVar(const juce::ValueTree& tree);

// Invalid shape returns an invalid ValueTree rather than partial state.
juce::ValueTree fromVar(const juce::var& value);

} // namespace silverdaw::ValueTreeJson
