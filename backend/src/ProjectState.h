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
 *       TRACK (id="t1", name="Drums", gain=1.0)
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

    /** Set a track's user-facing name. Blank names are rejected. */
    bool setTrackName(const juce::String& trackId, const juce::String& name);

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
                 double durationMs, double inMs = 0.0, int colorIndex = -1);

    /** Remove a clip. Returns true if it existed. */
    bool removeClip(const juce::String& clipId);

    /** Update a clip's timeline offset. Returns true if the clip existed. */
    bool setClipOffsetMs(const juce::String& clipId, double offsetMs);

    /** Move a clip to a different host track. The clip's node is
     *  re-parented in the ValueTree to the new TRACK node; properties
     *  (offset, in, duration, colour) are preserved. Returns true if
     *  both the clip and the destination track existed. */
    bool setClipTrack(const juce::String& clipId, const juce::String& newTrackId);

    /**
     * Atomically update the trim window (offsetMs / inMs / durationMs)
     * of `clipId`. Used by edge-drag trim and renderer-side split. All
     * three writes happen inside one `suppressDirtyTransitions=false`
     * scope so the project flips dirty exactly once. Returns true if
     * the clip existed.
     */
    bool setClipTrim(const juce::String& clipId, double offsetMs, double inMs, double durationMs);

    /** Update the per-clip colour palette index (0..15). Pass `-1` to
     *  remove the override and inherit the host track's colour. */
    bool setClipColorIndex(const juce::String& clipId, int colorIndex);

    /** Read the clip's `inMs` (where in the source file it starts reading). 0 if unknown. */
    double getClipInMs(const juce::String& clipId) const;

    /** Read the clip's `durationMs`. 0 if unknown. */
    double getClipDurationMs(const juce::String& clipId) const;

    /** Update a clip's source file path. Returns true if the clip
     *  existed. Used by the relink-missing-files flow on load — the
     *  user picks a replacement file in an OS dialog and the renderer
     *  emits CLIP_RELINK so we can re-create the engine's audio source
     *  against the new path. */
    bool setClipFilePath(const juce::String& clipId, const juce::String& filePath);

    /** Returns the trackId owning `clipId`, or empty string if not found. */
    juce::String getClipTrackId(const juce::String& clipId) const;

    /** Returns the backend-stored file path for `clipId`, or empty if unknown. */
    juce::String getClipFilePath(const juce::String& clipId) const;

    // ─── View settings ─────────────────────────────────────────────────
    //
    // Project-scoped view state that survives save/load but is NOT
    // considered a meaningful "edit" — changing the zoom level or
    // scroll position should not prompt an unsaved-changes dialog. The
    // setter wraps the mutation in `suppressDirtyTransitions` so the
    // listener ignores it; the read path is a plain property read.

    /** Horizontal zoom (pixels per second). Defaults to 60. */
    double getViewPxPerSecond() const;

    /** Update the persisted zoom level. Does NOT mark the project dirty. */
    void setViewPxPerSecond(double pxPerSecond);

    /** Horizontal scroll position in pixels (renderer-space). Defaults to 0. */
    double getViewScrollX() const;

    /** Update the persisted scroll position. Does NOT mark the project dirty. */
    void setViewScrollX(double scrollX);

    /** Persisted playhead position in ms. Defaults to 0. */
    double getPlayheadMs() const;

    /** Update the persisted playhead position. Does NOT mark the project dirty. */
    void setPlayheadMs(double playheadMs);

    // ─── Tempo / length (meaningful edits — flip dirty flag) ───────────

    /** Project tempo in BPM. Defaults to 100. */
    double getBpm() const;

    /** Update the tempo. Marks the project dirty as a normal property edit. */
    void setBpm(double bpm);

    /** Persisted project length in ms (the user-editable Length field).
     *  Defaults to 0 — the renderer falls back to the per-track default
     *  in that case. */
    double getProjectLengthMs() const;

    /** Update the persisted project length. Marks dirty. */
    void setProjectLengthMs(double lengthMs);

    // ─── Library catalogue ─────────────────────────────────────────────
    //
    // Items the user has imported into the library — independently of
    // whether they've been dragged onto a track yet. Persisted with
    // the project so re-opening it restores the full catalogue, not
    // just the items referenced by an active clip. Cover art / ID3
    // metadata is NOT stored here (renderer re-extracts it on load
    // via the existing `audio:readMetadata` IPC) — only the stable
    // `(id, filePath, fileName, duration, format details)` fields the
    // backend needs to know about.

    /** Add (or update the file path of) a library item. Marks dirty. */
    bool addLibraryItem(const juce::String& itemId, const juce::String& filePath, const juce::String& fileName = {},
                        double durationMs = 0.0, int sampleRate = 0, int channelCount = 0,
                        const juce::String& playbackPath = {});

    /** Remove a library item by id. Returns true if it existed. Marks dirty. */
    bool removeLibraryItem(const juce::String& itemId);

    /** Set the detected BPM on a library item. Pass 0.0 to clear.
     *  Marks the project dirty. Returns true if the item existed. */
    bool setLibraryItemBpm(const juce::String& itemId, double bpm);

    /** Set the detected beat positions (seconds from start of source)
     *  on a library item. Empty array clears them. Marks dirty.
     *  Returns true if the item existed. */
    bool setLibraryItemBeats(const juce::String& itemId, const std::vector<double>& beatTimesSec);

    /** Set the regression-derived "ideal beat 0" anchor (seconds, may
     *  be negative) on a library item. Used by the renderer to lay
     *  out the synthesised beat-marker grid robustly. Marks dirty.
     *  Returns true if the item existed. */
    bool setLibraryItemBeatAnchor(const juce::String& itemId, double anchorSec);

    /** Set the cached-decoded-WAV path on a library item. Used by
     *  the backend after `DecodedCache::ensureDecoded` has finished.
     *  Pass an empty string to clear. Marks dirty. Returns true if
     *  the item existed. */
    bool setLibraryItemPlaybackPath(const juce::String& itemId, const juce::String& playbackPath);

    /** Read the cached-decoded-WAV path for the library item with
     *  `filePath` as its source path. Returns empty string when no
     *  matching item exists or no cache has been written yet. Used
     *  by `handleClipAdd` to prefer the cached WAV over the original
     *  for new clip sources. */
    juce::String getLibraryItemPlaybackPathForSource(const juce::String& sourceFilePath) const;

    /** Flag (or clear) the library item as having a variable tempo —
     *  drives the UI badge and suppresses the first-clip project
     *  BPM seed. Marks dirty. Returns true if the item existed. */
    bool setLibraryItemVariableTempo(const juce::String& itemId, bool variable);

    /** True if a library item is registered for `filePath`. Used by the
     *  detection scheduler to avoid duplicate work. */
    bool hasLibraryItemForPath(const juce::String& filePath) const;

    /** Read the BPM on the library item matching `filePath`. Returns 0
     *  if no item matches or no BPM has been detected yet. */
    double getLibraryItemBpmForPath(const juce::String& filePath) const;

    /** Snapshot the persisted library items, ready to drop into a
     *  PROJECT_STATE envelope's `library` field. */
    juce::var libraryAsJson() const;

    // ─── Serialisation ─────────────────────────────────────────────────

    /**
     * Snapshot the project's tracks as a `juce::var` array of track
     * objects, ready to drop into a PROJECT_STATE envelope as its
     * `tracks` field. Caller composes the wrapping envelope (file path,
     * project name, reset flag) in `Main.cpp::buildProjectStateEnvelope`.
     *
     * Each track:
     *   { id, name, gain, clips: [ { id, filePath, offsetMs, durationMs } ] }
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
    static const juce::Identifier kInMs;
    static const juce::Identifier kDurationMs;
    static const juce::Identifier kSampleRate;
    static const juce::Identifier kChannelCount;
    static const juce::Identifier kColorIndex;
    static const juce::Identifier kViewPxPerSecond;
    static const juce::Identifier kViewScrollX;
    static const juce::Identifier kPlayheadMs;
    static const juce::Identifier kBpm;
    static const juce::Identifier kProjectLengthMs;
    static const juce::Identifier kLibrary;
    static const juce::Identifier kLibraryItem;
    static const juce::Identifier kBeats;
    static const juce::Identifier kBeatAnchorSec;
    static const juce::Identifier kPlaybackFilePath;
    static const juce::Identifier kVariableTempo;
};

} // namespace silverdaw
