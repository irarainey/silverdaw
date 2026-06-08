#pragma once

#include <juce_core/juce_core.h>
#include <juce_data_structures/juce_data_structures.h>

namespace silverdaw::ValueTreeJson
{

/**
 * Reserved JSON keys used by the ValueTree ↔ JSON converter.
 *
 * `$type` carries the ValueTree element's `juce::Identifier` so the
 * reader can reconstruct the right node type when reading back. The
 * leading `$` is illegal in `juce::Identifier`, so it can never collide
 * with a real property name set via `ValueTree::setProperty`.
 *
 * `$children` carries the ordered list of nested ValueTrees (each of
 * them serialised by the same recursive shape). When a node has no
 * children the key is omitted so files stay compact.
 */
inline constexpr const char* kTypeKey = "$type";
inline constexpr const char* kChildrenKey = "$children";

/**
 * Serialise `tree` to a `juce::var` shaped for `juce::JSON::toString`.
 *
 * The result is a `DynamicObject` of the form
 *
 *   { "$type": "TRACK",
 *     "id": "...", "gain": 1.0,
 *     "$children": [ { ... }, ... ] }
 *
 * Properties are converted via `juce::var`'s native JSON support (strings,
 * numbers, bools, arrays, nested DynamicObjects). Unsupported `var` flavours
 * (e.g. raw MemoryBlocks, method bindings) are dropped — none of those
 * appear in our project state today and the converter will assert in
 * debug builds if one ever does.
 *
 * The returned value is `void` only when `tree.isValid() == false`.
 */
juce::var toVar(const juce::ValueTree& tree);

/**
 * Parse a `juce::var` produced by `toVar` (or by any JSON document with
 * the same shape) back into a `juce::ValueTree`.
 *
 * Returns an invalid `ValueTree` if `value` is not an object, is missing
 * a `$type` key, or has a `$children` value that is not an array. A
 * property whose value is itself an object/array is round-tripped as a
 * JSON-typed `juce::var` (the property reader on the consuming side can
 * dispatch on that).
 */
juce::ValueTree fromVar(const juce::var& value);

} // namespace silverdaw::ValueTreeJson
