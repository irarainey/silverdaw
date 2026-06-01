// Bridge payload validation helpers.
//
// These wrap `juce::var::getProperty(...)` reads with strict type
// checking so bridge handlers can reject malformed envelopes instead
// of silently consuming the coerced result of `var::toString()` on
// a wrong-typed value. Defined as `inline` functions in this header
// so both the dispatch sites in `Main.cpp` and the backend test
// binary can link them in.
//
// Logging is delegated to `silverdaw::log::warn` — the central
// observability sink. Failure messages carry the field name; the
// caller decides whether to broadcast an error envelope on top.

#pragma once

#include "Log.h"

#include <juce_core/juce_core.h>
#include <juce_data_structures/juce_data_structures.h>

#include <optional>

namespace silverdaw::bridge
{

/**
 * Extract a numeric field from a bridge payload without the silent
 * coercion that `juce::var::getProperty(key, default)` performs.
 * Returns `std::nullopt` (and logs) when the field is missing or
 * wrong-typed so dispatch handlers can reject the envelope instead of
 * silently applying a default value (e.g. seek-to-0, zero-gain).
 */
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

/**
 * Extract a string field from a bridge payload, validating that the
 * underlying `juce::var` actually holds a string. Returns
 * `std::nullopt` (and logs) when the field is missing or wrong-typed
 * — avoids the silent coercion of `var::toString()` on objects,
 * arrays, numbers, etc. Accepts empty strings; the caller can decide
 * whether an empty value is meaningful (use `tryGetRequiredString`
 * for the common "must be non-empty" dispatch case).
 */
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

/**
 * As `tryGetString`, but additionally rejects empty strings. Use at
 * dispatch sites where the field gates a state mutation (clip / track
 * / library / file-path lookups) and an empty value would silently
 * no-op or operate on the wrong target.
 */
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

// ─── Optional (partial-update) reads ─────────────────────────────────────
//
// Partial-update handlers (Tone, Reverb, Delay) accept envelopes
// that carry only the fields the user touched and fall back to the
// stored value for the rest. For those, an ABSENT field is legitimate —
// it means "keep the current value" — so these readers return
// `std::nullopt` silently when the key is missing. A PRESENT but
// wrong-typed field is still rejected (and logged): callers fall back to
// the stored value rather than silently coercing the bogus payload
// (e.g. `var::toString()` on an object, or a string coerced to 0.0).

/** Optional numeric read: value when present and numeric, `nullopt`
 *  when absent (no log) or present-but-non-numeric (logged). */
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

/** Optional boolean read: value when present and boolean, `nullopt`
 *  when absent (no log) or present-but-non-boolean (logged). */
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

/** Optional string read: value when present and a string, `nullopt`
 *  when absent (no log) or present-but-non-string (logged). */
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

} // namespace silverdaw::bridge
