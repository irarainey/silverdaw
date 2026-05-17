#pragma once

#include <juce_core/juce_core.h>
#include <juce_data_structures/juce_data_structures.h>

namespace silverdaw
{

/**
 * Backend-authoritative project state.
 *
 * Wraps a `juce::ValueTree` and a single `juce::UndoManager` so every
 * mutation that touches user-visible project structure (tracks, clips,
 * positions, gains) lives in one place that can later be serialised,
 * persisted, and undone as a unit.
 *
 * Tree shape:
 *
 *     PROJECT
 *       TRACK (id="t1", gain=1.0)
 *         CLIP (id="c1", filePath="...", offsetMs=0.0)
 *         CLIP (id="c2", filePath="...", offsetMs=4000.0)
 *       TRACK (id="t2", gain=0.7)
 *         CLIP (id="c3", ...)
 *
 * `ProjectState` is the structural truth; `AudioEngine` owns the matching
 * audio-graph nodes and is updated in lockstep by the bridge dispatch
 * handlers. Today the engine has one playable audio source per `clipId`;
 * multi-clip-per-track audio playback is Phase 4 work — but the ValueTree
 * already models the right shape so that future change is wire-compatible.
 *
 * Thread model: all methods run on the JUCE message thread, matching the
 * dispatch site in `Main.cpp::dispatchBridgeMessage`. No locking needed.
 */
class ProjectState
{
  public:
    /** Default name applied to a freshly-constructed project. */
    static const juce::String kDefaultName;

    ProjectState();

    // ─── Project metadata ──────────────────────────────────────────────

    /** User-facing project name; "Untitled" until renamed or loaded. */
    juce::String getName() const;

    /** Update the project's name. Empty / blank inputs are coerced to `kDefaultName`. */
    void setName(const juce::String& name);

    // ─── Tracks ────────────────────────────────────────────────────────

    /** Add an empty track. Idempotent: returns true if `trackId` already exists. */
    bool addTrack(const juce::String& trackId);

    /**
     * Remove `trackId` and every clip it contains. Returns the ids of
     * the clips that were removed (so the audio engine can drop their
     * playable sources in lockstep). Empty if the track did not exist.
     */
    juce::StringArray removeTrack(const juce::String& trackId);

    /** Returns true if `trackId` exists in the tree. */
    bool hasTrack(const juce::String& trackId) const;

    /** Per-track linear gain (0 = silent, 1 = unity). 1.0 if unknown. */
    float getTrackGain(const juce::String& trackId) const;

    /** Set per-track gain. Returns true if the track existed. */
    bool setTrackGain(const juce::String& trackId, float gain);

    /** Ordered ids of all clips on `trackId` (empty if the track is missing). */
    juce::StringArray getTrackClipIds(const juce::String& trackId) const;

    // ─── Clips ─────────────────────────────────────────────────────────

    /**
     * Add a clip under an existing track. Returns false if `trackId` is
     * unknown or `clipId` already exists anywhere in the tree.
     */
    bool addClip(const juce::String& trackId, const juce::String& clipId, const juce::String& filePath, double offsetMs,
                 double durationMs);

    /** Remove a clip. Returns true if it existed. */
    bool removeClip(const juce::String& clipId);

    /** Update a clip's timeline offset. Returns true if the clip existed. */
    bool setClipOffsetMs(const juce::String& clipId, double offsetMs);

    /** Returns the trackId owning `clipId`, or empty string if not found. */
    juce::String getClipTrackId(const juce::String& clipId) const;

    /** Returns the backend-stored file path for `clipId`, or empty if unknown. */
    juce::String getClipFilePath(const juce::String& clipId) const;

    // ─── Serialisation ─────────────────────────────────────────────────

    /**
     * Snapshot the project's tracks as a `juce::var` array of track
     * objects, ready to drop into a PROJECT_STATE envelope as its
     * `tracks` field. Caller composes the wrapping envelope (file path,
     * project name, reset flag) in `Main.cpp::buildProjectStateEnvelope`.
     *
     * Each track:
     *   { id, gain, clips: [ { id, filePath, offsetMs, durationMs } ] }
     */
    juce::var tracksAsJson() const;

    /**
     * Read-only access to the underlying `ValueTree`. Used by serialisation
     * (`ProjectFile::save`) and tests that need to assert structural shape.
     * The returned reference is stable for the lifetime of `ProjectState`.
     */
    const juce::ValueTree& getTree() const noexcept
    {
        return root;
    }

    /**
     * Replace this project's contents with `newTree`. The supplied tree
     * must have type `PROJECT` (the root element produced by `getTree`).
     *
     * Properties and children of the existing root are dropped first;
     * `root`'s node identity is preserved so any future listeners stay
     * attached. The undo history is cleared because undo is meaningless
     * across a project load.
     *
     * Returns `juce::Result::ok()` on success, or a failure result with
     * a user-displayable message when validation fails.
     */
    juce::Result replaceTree(const juce::ValueTree& newTree);

    /** Access the shared undo manager (Phase 7 will surface this in the UI). */
    juce::UndoManager& getUndoManager() noexcept
    {
        return undoManager;
    }

  private:
    juce::ValueTree findTrack(const juce::String& trackId) const;
    juce::ValueTree findClip(const juce::String& clipId) const;

    juce::ValueTree root;
    juce::UndoManager undoManager;

    // ValueTree identifiers — defined once so typos surface at link time
    // rather than as silent zero-property reads on the audio side.
    static const juce::Identifier kProject;
    static const juce::Identifier kTrack;
    static const juce::Identifier kClip;
    static const juce::Identifier kId;
    static const juce::Identifier kName;
    static const juce::Identifier kGain;
    static const juce::Identifier kFilePath;
    static const juce::Identifier kOffsetMs;
    static const juce::Identifier kDurationMs;
};

} // namespace silverdaw
