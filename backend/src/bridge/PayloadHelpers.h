// Strict bridge payload readers prevent `juce::var` coercion from accepting malformed envelopes.

#pragma once

#include "Log.h"

#include <juce_core/juce_core.h>
#include <juce_data_structures/juce_data_structures.h>

#include <optional>

namespace silverdaw::bridge
{

// Required numeric read; logs and rejects missing/wrong-typed fields instead of defaulting.
inline std::optional<double> tryGetNumber(const juce::var& payload, const char* key)
{
    const juce::var v = payload.getProperty(key, juce::var());
    if (v.isDouble() || v.isInt() || v.isInt64())
    {
        return static_cast<double>(v);
    }
    silverdaw::log::warn("bridge", juce::String("field '") + key + "' missing or non-numeric; envelope ignored");
    return std::nullopt;
}

// Required string read; avoids `var::toString()` coercion on wrong-typed payloads.
inline std::optional<juce::String> tryGetString(const juce::var& payload, const char* key)
{
    const juce::var v = payload.getProperty(key, juce::var());
    if (v.isString())
    {
        return v.toString();
    }
    silverdaw::log::warn("bridge", juce::String("field '") + key + "' missing or non-string; envelope ignored");
    return std::nullopt;
}

// Reject empty strings where they would no-op or target the wrong state.
inline std::optional<juce::String> tryGetRequiredString(const juce::var& payload, const char* key)
{
    auto s = tryGetString(payload, key);
    if (!s || s->isEmpty())
    {
        if (s) // logged for the wrong-type case inside `tryGetString`; only log here for the empty case.
        {
            silverdaw::log::warn("bridge", juce::String("field '") + key + "' is empty; envelope ignored");
        }
        return std::nullopt;
    }
    return s;
}

// Optional readers are silent for absent fields but log present wrong-typed values.

inline std::optional<double> readOptionalNumber(const juce::var& payload, const char* key)
{
    const juce::Identifier id{key};
    if (!payload.hasProperty(id))
    {
        return std::nullopt;
    }
    const juce::var v = payload.getProperty(id, juce::var());
    if (v.isDouble() || v.isInt() || v.isInt64())
    {
        return static_cast<double>(v);
    }
    silverdaw::log::warn("bridge", juce::String("optional field '") + key + "' present but non-numeric; ignored");
    return std::nullopt;
}

inline std::optional<bool> readOptionalBool(const juce::var& payload, const char* key)
{
    const juce::Identifier id{key};
    if (!payload.hasProperty(id))
    {
        return std::nullopt;
    }
    const juce::var v = payload.getProperty(id, juce::var());
    if (v.isBool())
    {
        return static_cast<bool>(v);
    }
    silverdaw::log::warn("bridge", juce::String("optional field '") + key + "' present but non-boolean; ignored");
    return std::nullopt;
}

inline std::optional<juce::String> readOptionalString(const juce::var& payload, const char* key)
{
    const juce::Identifier id{key};
    if (!payload.hasProperty(id))
    {
        return std::nullopt;
    }
    const juce::var v = payload.getProperty(id, juce::var());
    if (v.isString())
    {
        return v.toString();
    }
    silverdaw::log::warn("bridge", juce::String("optional field '") + key + "' present but non-string; ignored");
    return std::nullopt;
}

// Required string-array read. The caller owns any domain-specific item limit;
// this helper only rejects malformed array members before a command mutates state.
inline std::optional<juce::StringArray> tryGetStringArray(const juce::var& payload, const char* key)
{
    const juce::var value = payload.getProperty(key, juce::var());
    const auto* array = value.getArray();
    if (array == nullptr)
    {
        silverdaw::log::warn("bridge", juce::String("field '") + key + "' missing or non-array; envelope ignored");
        return std::nullopt;
    }

    juce::StringArray result;
    for (const auto& entry : *array)
    {
        if (!entry.isString() || entry.toString().isEmpty())
        {
            silverdaw::log::warn("bridge", juce::String("field '") + key +
                                             "' contains an empty or non-string item; envelope ignored");
            return std::nullopt;
        }
        if (!result.contains(entry.toString()))
            result.add(entry.toString());
    }
    return result;
}

} // namespace silverdaw::bridge
