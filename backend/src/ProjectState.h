#pragma once

#include <atomic>
#include <functional>
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
 * multi-clip-per-track audio playback is Phase 5 work — but the ValueTree
 * already models the right shape so that future change is wire-compatible.
 *
 * Thread model: all methods run on the JUCE message thread, matching the
 * dispatch site in `Main.cpp::dispatchBridgeMessage`. No locking needed.
 *
 * Dirty tracking: a `juce::ValueTree::Listener` flips an internal flag
 * on every mutation (property change, child add/remove/order). The flag
 * is cleared by `markClean()` (called after load and successful save),
 * and `setDirtyChangedCallback` lets `Main.cpp` broadcast PROJECT_DIRTY
 * envelopes on transitions so the renderer's title bar / unsaved-changes
 * prompt stay in lockstep with the truth.
 */
class ProjectState : public juce::ValueTree::Listener
{
  public:
    /** Default name applied to a freshly-constructed project. */
    static const juce::String kDefaultName;

    /** Fired when the dirty flag transitions. Set by `Main.cpp` after the bridge exists. */
    using DirtyChangedCallback = std::function<void(bool dirty)>;

    ProjectState();
    ~ProjectState() override;

    ProjectState(const ProjectState&) = delete;
    ProjectState& operator=(const ProjectState&) = delete;
    ProjectState(ProjectState&&) = delete;
    ProjectState& operator=(ProjectState&&) = delete;

    // ─── Dirty tracking ────────────────────────────────────────────────

    /** True if the project has been mutated since the last load / save / new. */
    bool isDirty() const noexcept
    {
        return dirty;
    }

    /**
     * Reset the dirty flag to false. Called after a successful load,
     * save, or new-project — at which point the in-memory state matches
     * the on-disk file (or the blank canvas). Fires the dirty-changed
     * callback if this is an actual transition.
     */
    void markClean();

    /** Register a callback fired on every dirty-flag transition. */
    void setDirtyChangedCallback(DirtyChangedCallback callback);

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

    // ─── View settings ─────────────────────────────────────────────────
    //
    // Project-scoped view state that survives save/load but is NOT
    // considered a meaningful "edit" — changing the zoom level should
    // not prompt an unsaved-changes dialog. The setter wraps the
    // mutation in `suppressDirtyTransitions` so the listener ignores
    // it; the read path is a plain property read.

    /** Horizontal zoom (pixels per second). Defaults to 60. */
    double getViewPxPerSecond() const;

    /** Update the persisted zoom level. Does NOT mark the project dirty. */
    void setViewPxPerSecond(double pxPerSecond);

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

    void valueTreePropertyChanged(juce::ValueTree& /*tree*/,
                                  const juce::Identifier& /*property*/) override;
    void valueTreeChildAdded(juce::ValueTree& /*parent*/, juce::ValueTree& /*child*/) override;
    void valueTreeChildRemoved(juce::ValueTree& /*parent*/, juce::ValueTree& /*child*/,
                               int /*index*/) override;
    void valueTreeChildOrderChanged(juce::ValueTree& /*parent*/, int /*oldIndex*/,
                                    int /*newIndex*/) override;

    void setDirty(bool d);

    juce::ValueTree root;
    juce::UndoManager undoManager;
    bool dirty{false};
    /**
     * Suppresses listener-driven dirty transitions during bulk
     * mutations we know don't count as user edits — currently used by
     * `replaceTree` (a project load is by definition clean) and the
     * default constructor (the initial `name=Untitled` property write).
     */
    bool suppressDirtyTransitions{false};
    DirtyChangedCallback onDirtyChanged;

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
    static const juce::Identifier kViewPxPerSecond;
};

} // namespace silverdaw
