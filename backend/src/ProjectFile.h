#pragma once

#include "ProjectState.h"

#include <juce_core/juce_core.h>

namespace silverdaw::ProjectFile
{

/**
 * On-disk schema version for `.silverdaw` files.
 *
 * Bump whenever the file format changes in a way that an older loader
 * would not be able to handle correctly. The loader refuses any file
 * whose `schemaVersion` exceeds this constant; smaller values fall
 * through a migration path (no migrations exist yet — version 1 is the
 * first format we ship).
 */
constexpr int kCurrentSchemaVersion = 1;

/** Result envelope for `load`. `ok=true` means `project` was replaced. */
struct LoadResult
{
    bool ok{false};
    /** Human-readable error message; empty when `ok`. */
    juce::String error;
    /** `schemaVersion` attribute read from the file (0 on failure). */
    int schemaVersion{0};
};

/**
 * Serialise `project` to `file` in the current `.silverdaw` format.
 *
 * The on-disk layout is JSON:
 *
 *     {
 *       "schemaVersion": 1,
 *       "appVersion": "1.0.0",
 *       "savedAt": "2026-05-18T11:00:00.000Z",
 *       "project": { "$type": "PROJECT", ...,
 *                    "$children": [
 *                      { "$type": "TRACK", "id": "...", "gain": 1.0,
 *                        "$children": [ ... ] },
 *                      ...
 *                    ] }
 *     }
 *
 * Future state extensions (transport position, library catalogue, UI
 * layout) are added as additional sibling keys under the root object
 * (e.g. `"transport": { ... }`) so the project node itself stays a
 * verbatim `ValueTree → JSON` payload that can be migrated independently.
 *
 * Returns `juce::Result::ok()` on success or a `juce::Result::fail()`
 * carrying a user-displayable error string. Existing file contents are
 * replaced atomically (write to a sibling temp file then rename).
 */
juce::Result save(const juce::File& file, const ProjectState& project);

/**
 * Load a `.silverdaw` file from disk, replacing `project`'s contents on
 * success.
 *
 * On failure `project` is left untouched and `LoadResult::error`
 * describes why (missing file, malformed JSON, missing `project` key,
 * or a schema newer than this build can read). The JSON loader ignores
 * any extra keys it does not recognise, so a file written by a newer
 * build is still loadable as long as its `schemaVersion` does not
 * exceed `kCurrentSchemaVersion`.
 */
LoadResult load(const juce::File& file, ProjectState& project);

} // namespace silverdaw::ProjectFile
