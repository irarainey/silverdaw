#pragma once

// Scratch-pattern persistence identifiers and contracts. Keeps the scratch-
// pattern domain boundary explicit without growing ProjectState.h.

#include <juce_core/juce_core.h>

namespace silverdaw::scratch_ids
{

// ValueTree node types and property keys for persisted scratch patterns.
inline const juce::Identifier kScratchPatterns{"SCRATCH_PATTERNS"};
inline const juce::Identifier kScratchPattern{"SCRATCH_PATTERN"};
inline const juce::Identifier kScratchPatternData{"scratchPatternData"};

} // namespace silverdaw::scratch_ids
