#pragma once

// Shared ValueTree unit-float writer: clamps to [0,1] and suppresses near-default
// values so untouched track/project FX state stays absent from the persisted tree.

#include <juce_core/juce_core.h>
#include <juce_data_structures/juce_data_structures.h>

#include <cmath>

namespace silverdaw
{

inline bool applyUnitFloat(juce::ValueTree& tree,
                           const juce::Identifier& id,
                           float value,
                           float epsilon,
                           juce::UndoManager* undo)
{
    const auto clamped = juce::jlimit(0.0f, 1.0f, value);
    const bool hadProperty = tree.hasProperty(id);
    const auto previous = hadProperty
        ? static_cast<float>(static_cast<double>(tree.getProperty(id)))
        : 0.0f;
    if (std::abs(clamped) < epsilon)
    {
        if (!hadProperty) return false;
        tree.removeProperty(id, undo);
        return true;
    }
    if (hadProperty && std::abs(previous - clamped) < epsilon) return false;
    tree.setProperty(id, clamped, undo);
    return true;
}

} // namespace silverdaw
