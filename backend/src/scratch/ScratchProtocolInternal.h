#pragma once

// Internal parsing helpers shared by ScratchProtocol.cpp and
// ScratchProtocolPattern.cpp. Not part of the public scratch protocol API —
// do not include this from outside the scratch/ directory.

#include "ScratchProtocol.h"

#include <juce_core/juce_core.h>

#include <cmath>
#include <cstdint>
#include <optional>

namespace silverdaw::scratch::detail
{

inline constexpr double kMaxSafeInteger = 9007199254740991.0;

inline bool isObject(const juce::var& value)
{
    return value.getDynamicObject() != nullptr;
}

inline std::optional<juce::var> property(const juce::var& object, const char* key)
{
    const juce::Identifier id{key};
    if (!isObject(object) || !object.hasProperty(id))
    {
        return std::nullopt;
    }
    return object.getProperty(id, juce::var());
}

inline std::optional<juce::String> requiredString(const juce::var& object, const char* key)
{
    const auto value = property(object, key);
    if (!value || !value->isString())
    {
        return std::nullopt;
    }
    const auto text = value->toString();
    return text.isNotEmpty() ? std::optional<juce::String>{text} : std::nullopt;
}

inline std::optional<double> finiteNumber(const juce::var& object, const char* key)
{
    const auto value = property(object, key);
    if (!value || !(value->isInt() || value->isInt64() || value->isDouble()))
    {
        return std::nullopt;
    }
    const auto number = static_cast<double>(*value);
    return std::isfinite(number) ? std::optional<double>{number} : std::nullopt;
}

inline std::optional<double> boundedTurns(const juce::var& object, const char* key, double maximumMagnitude)
{
    const auto value = finiteNumber(object, key);
    if (!value || std::abs(*value) > maximumMagnitude)
    {
        return std::nullopt;
    }
    return value;
}

inline std::optional<std::int64_t> timeUs(const juce::var& object, const char* key)
{
    const auto number = finiteNumber(object, key);
    if (!number || *number < 0.0 || *number > kMaxSafeInteger || std::floor(*number) != *number)
    {
        return std::nullopt;
    }
    return static_cast<std::int64_t>(*number);
}

inline bool hasVersion(const juce::var& object, const char* key, int expected)
{
    const auto version = finiteNumber(object, key);
    return version && *version == static_cast<double>(expected);
}

inline std::optional<bool> requiredBool(const juce::var& object, const char* key)
{
    const auto value = property(object, key);
    if (!value || !value->isBool())
    {
        return std::nullopt;
    }
    return static_cast<bool>(*value);
}

inline std::optional<DeckSide> deckSide(const juce::var& object, const char* key)
{
    const auto value = finiteNumber(object, key);
    if (!value || std::floor(*value) != *value)
    {
        return std::nullopt;
    }
    if (*value == 1.0)
    {
        return DeckSide::deck1;
    }
    if (*value == 2.0)
    {
        return DeckSide::deck2;
    }
    return std::nullopt;
}

} // namespace silverdaw::scratch::detail
