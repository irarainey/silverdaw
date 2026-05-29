#pragma once

#include <atomic>
#include <functional>
#include <optional>
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

    /**
     * Force the dirty flag to true. Used by crash-recovery loads where
     * we deliberately want File > Save to be the next step the user
     * takes (the autosave is a transient safety net, not a real save).
     * No-op if already dirty.
     */
    void markDirty();

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

    /** Move `trackId` so it ends up at `newIndex` in the project's
     *  track order. `newIndex` is clamped to [0, trackCount-1]. Returns
     *  true if the track existed and the order actually changed. The
     *  move goes through `juce::ValueTree::moveChild` so it sits in
     *  the undo manager as a single coalesced step. */
    bool moveTrack(const juce::String& trackId, int newIndex);

    /** Per-track linear gain (0 = silent, 1 = unity). 1.0 if unknown.
     *  Now stores the USER VOLUME (slider position) rather than the
     *  post-mute/solo effective gain. The audible gain is computed
     *  on the fly via `getEffectiveTrackGain` so mute / solo can be
     *  toggled without losing the underlying volume choice. Old
     *  project files (which stored the post-mute effective value
     *  here) load with `muted=false`, so a muted-at-save-time track
     *  comes back as `volume=0, muted=false` — same audible result
     *  as today; the toggleable mute state is what's new. */
    float getTrackGain(const juce::String& trackId) const;

    /** Mute / solo state for a track. Both persist with the project
     *  and survive save / load. The renderer mirrors them and the
     *  effective gain (what the AudioEngine / MixdownEngine apply)
     *  is derived from `gain × audible(muted, soloed, anySoloed)`
     *  via `getEffectiveTrackGain`. */
    bool getTrackMuted(const juce::String& trackId) const;
    bool getTrackSoloed(const juce::String& trackId) const;
    bool anyTrackSoloed() const;

    /** Effective audible gain for the AudioEngine / MixdownEngine.
     *  Returns `0` for a muted track, or for any track that isn't
     *  the soloed one when at least one track is soloed; otherwise
     *  returns the per-track `gain` (= user volume). */
    float getEffectiveTrackGain(const juce::String& trackId) const;

    /** Set a track's user-facing name. Blank names are rejected. */
    bool setTrackName(const juce::String& trackId, const juce::String& name);

    /** Set per-track user volume (NOT effective gain). Returns true if
     *  the track existed. Mute and solo are toggled via the dedicated
     *  setters below — calling `setTrackGain` doesn't clear them. */
    bool setTrackGain(const juce::String& trackId, float gain);

    /** Set per-track mute / solo flags. Both mark the project dirty
     *  and round-trip through save / load. Returns true if the track
     *  existed. */
    bool setTrackMuted(const juce::String& trackId, bool muted);
    bool setTrackSoloed(const juce::String& trackId, bool soloed);

    /** Per-track row height in CSS pixels (renderer-side display
     *  metric). 0 if unknown — the renderer falls back to its default
     *  in that case. Clamped to a sane min/max by the setter so a
     *  hostile bridge payload can't make rows invisible. */
    double getTrackHeightPx(const juce::String& trackId) const;

    /** Persist a per-track row height. Returns false if the track is
     *  unknown. The value is clamped to [`kMinTrackHeightPx`,
     *  `kMaxTrackHeightPx`] mirroring the renderer's clamp so a value
     *  written by an older / different client doesn't drift outside
     *  the resize-handle's range. */
    bool setTrackHeightPx(const juce::String& trackId, double heightPx);

    /** Ordered ids of all clips on `trackId` (empty if the track is missing). */
    juce::StringArray getTrackClipIds(const juce::String& trackId) const;

    // ─── Clips ─────────────────────────────────────────────────────────

    /**
     * Add a clip under an existing track. Returns false if `trackId` is
     * unknown or `clipId` already exists anywhere in the tree.
     */
    bool addClip(const juce::String& trackId, const juce::String& clipId, const juce::String& libraryItemId,
                 double offsetMs, double durationMs, double inMs = 0.0, int colorIndex = -1);

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

    /** Per-clip lock flag. When locked, the timeline UI prevents moving
     *  and trimming the clip (double-click to open in the editor still
     *  works). Purely a UI policy — the audio engine is unaffected. The
     *  flag is per-clip, not per-library-item, so locking one instance
     *  of a saved-clip does not affect siblings. `false` removes the
     *  property so absent==unlocked on the wire and on disk. Returns
     *  true if the clip exists. */
    bool setClipLocked(const juce::String& clipId, bool locked);

    /** Read a clip's lock flag. Defaults to false. */
    bool isClipLocked(const juce::String& clipId) const;

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

    /** Read the library item id the clip is sourced from. Empty if
     *  the clip is not yet linked (legacy paths only). */
    juce::String getClipLibraryItemId(const juce::String& clipId) const;

    /** Update which library item a clip is sourced from. Used by the
     *  CLIP_RELINK / library-relink flow. */
    bool setClipLibraryItemId(const juce::String& clipId, const juce::String& libraryItemId);

    /** Set a clip's user-facing display name override. Empty/blank
     *  clears the override. Marks dirty. Returns true if the clip
     *  existed. */
    bool setClipName(const juce::String& clipId, const juce::String& name);

    /** Read a clip's user-facing display name override, or empty if unset. */
    juce::String getClipName(const juce::String& clipId) const;

    /** Per-warp-clip snapshot returned by `forEachWarpClip`. */
    struct WarpClipInfo
    {
        juce::String clipId;
        juce::String libraryItemId;
        bool warpEnabled;
        bool tempoRatioPinned;
        double tempoRatio;
        double semitones;
        double cents;
        juce::String warpMode;
        /** True when the clip was dropped before its source BPM was
         *  known. The `LIBRARY_ITEM_ANALYSIS` late-flip path uses
         *  this to distinguish "user opted into auto-warp but BPM
         *  wasn't ready yet" from "user explicitly disabled warp". */
        bool pendingAutoWarp;
    };

    /** Visit every clip in the project. Used by `Main.cpp`'s
     *  `PROJECT_SET_BPM` handler to update the warp ratio of every
     *  clip whose `tempoRatio` is not explicitly pinned, so a tempo
     *  change live-re-stretches the whole timeline in lockstep. */
    void forEachWarpClip(const std::function<void(const WarpClipInfo&)>& visitor) const;

    struct EffectiveClipTiming
    {
        double tempoRatio = 1.0;
        double durationMs = 0.0;
        bool warpActive = false;
    };

    /** Backend-authoritative effective timing for a clip. `durationMs`
     *  is the timeline/output footprint, while the stored clip
     *  `durationMs` remains the source-time window. */
    EffectiveClipTiming getClipEffectiveTiming(const juce::String& clipId) const;

    /** Source BPM (from the library item) in beats-per-minute. 0 if
     *  the item is unknown or its BPM hasn't been detected yet. */
    double getLibraryItemBpm(const juce::String& itemId) const;

    /**
     * Partial update of a clip's warp + pitch settings. Every parameter
     * is wrapped in `std::optional` so the caller can drive a single
     * field (e.g. just `semitones`) without touching the rest. Returns
     * true if the clip existed. Mutations go through the `UndoManager`
     * so a single `CLIP_SET_WARP` envelope coalesces with any other
     * fields landed in the same drag window.
     *
     * The `tempoRatio` argument follows tri-state semantics:
     *   - `std::nullopt` — caller is not touching `tempoRatio`.
     *   - non-null double — pin `tempoRatio` to this explicit value;
     *     project BPM changes no longer move the clip.
     *   - sentinel: pass `std::optional<double>{}` plus
     *     `tempoRatioClear=true` to remove the property so it reverts
     *     to project-BPM tracking.
     */
    bool setClipWarp(const juce::String& clipId,
                     std::optional<bool> warpEnabled,
                     std::optional<juce::String> warpMode,
                     std::optional<double> tempoRatio,
                     bool tempoRatioClear,
                     std::optional<double> semitones,
                     std::optional<double> cents,
                     std::optional<bool> pendingAutoWarp);

    /** Returns the trackId owning `clipId`, or empty string if not found. */
    juce::String getClipTrackId(const juce::String& clipId) const;

    /** Returns the backend-stored file path for `clipId`, or empty if unknown. */
    juce::String getClipFilePath(const juce::String& clipId) const;

    // ─── View settings ─────────────────────────────────────────────────
    //
    // Project-scoped view state that survives save/load but is NOT
    // considered a meaningful "edit" — changing the zoom level or
    // scroll position should not prompt an unsaved-changes dialog. The
    // setter routes through `setNonDirtyRootProperty`, which writes to
    // the live tree under suppression AND mirrors the value into
    // `cleanSnapshot` so the listener's equivalence check never sees a
    // delta on this property after a net-zero edit + undo.

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

    /** Per-project preferred audio output device. Both fields default to
     *  empty (no project-level override). Empty values are persisted as
     *  absent properties so projects that never set a preference don't
     *  carry the keys forward. */
    juce::String getAudioOutputTypeName() const;
    juce::String getAudioOutputDeviceName() const;

    /** Update the per-project preferred audio output device. Pass empty
     *  strings to clear the preference (the user's global
     *  `preferences.json` then applies on next load). Marks dirty and
     *  records an undo step. */
    void setAudioOutput(const juce::String& typeName, const juce::String& deviceName);

    /** Per-project target sample rate (Hz). Drives the playback-cache
     *  rebuild so every clip's audio is at this rate on disk.
     *  Defaults to 0 (= "not set"; renderer falls back to the user-
     *  scope `audio.defaultProjectSampleRate` preference, then 44 100). */
    int getTargetSampleRate() const;

    /** Update the per-project target sample rate. Pass 0 to clear the
     *  preference (renderer-scope default will apply on next load).
     *  Records an undo step; marks the project dirty. */
    void setTargetSampleRate(int sampleRate);

    /** Opaque JSON blob of the last-used export-dialog settings (format,
     *  bit depth, dither, tail seconds, MP3 bitrate, Ogg quality,
     *  loudness preset / target, length mode, file-level tags, …).
     *  The renderer owns the schema; the backend just round-trips the
     *  string verbatim. Empty when the project has never run an export.
     *  Roundtrips through `.silverdaw` so the same settings reappear on
     *  next open. New projects start empty (= dialog uses base defaults). */
    juce::String getExportSettingsJson() const;

    /** Replace the persisted export-settings JSON. Pass an empty string
     *  to clear. Does NOT push an undo step (export dialog choices are
     *  not part of the editing undo stack) but DOES mark the project
     *  dirty so the user is prompted to save. */
    void setExportSettingsJson(const juce::String& json);

    /** Master output volume (0.0 = silent, 1.0 = unity). Applied to the
     *  live audio engine's final mix bus and to the export render so
     *  the mixed file matches what the user hears. Defaults to 1.0
     *  when absent (new projects start at unity). */
    float getMasterVolume() const;

    /** Update the master output volume. Clamped to [0.0, 1.0]. Pushes
     *  an undo step (mirrors `setTrackGain`) and marks the project
     *  dirty. Persisted to `.silverdaw` only when ≠ unity so legacy
     *  projects round-trip with no extra property. */
    void setMasterVolume(float volume);

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
                        const juce::String& playbackPath = {}, const juce::String& key = {},
                        const juce::String& kind = {}, const juce::String& displayName = {},
                        const juce::String& sourceItemId = {}, const juce::String& sourceClipId = {},
                        double sourceInMs = -1.0, double sourceDurationMs = -1.0,
                        int collapsedFlag = -1);

    /** Remove a library item by id. Returns true if it existed. Marks dirty. */
    bool removeLibraryItem(const juce::String& itemId);

    /** Set the detected BPM on a library item. Pass 0.0 to clear.
     *  Derived cache metadata — does NOT mark the project dirty (the
     *  value is regenerated from the source file on demand). Returns
     *  true if the item existed. */
    bool setLibraryItemBpm(const juce::String& itemId, double bpm);

    /** Set the detected beat positions (seconds from start of source)
     *  on a library item. Empty array clears them. Derived cache
     *  metadata — does NOT mark the project dirty. Returns true if
     *  the item existed. */
    bool setLibraryItemBeats(const juce::String& itemId, const std::vector<double>& beatTimesSec);

    /** Set the regression-derived "ideal beat 0" anchor (seconds, may
     *  be negative) on a library item. Used by the renderer to lay
     *  out the synthesised beat-marker grid robustly. Derived cache
     *  metadata — does NOT mark the project dirty. Returns true if
     *  the item existed. */
    bool setLibraryItemBeatAnchor(const juce::String& itemId, double anchorSec);

    /** Set the cached-decoded-WAV path on a library item. Used by
     *  the backend after `DecodedCache::ensureDecoded` has finished.
     *  Pass an empty string to clear. Derived cache metadata — does
     *  NOT mark the project dirty (the cache file is regenerated from
     *  the source). Returns true if the item existed. */
    bool setLibraryItemPlaybackPath(const juce::String& itemId, const juce::String& playbackPath);

    /** Update a library item's source file path. Used by the
     *  relink-missing-files flow: the user picks a replacement file
     *  and the new path is applied to the library item. All clips
     *  referencing the item pick up the new file automatically. */
    bool setLibraryItemFilePath(const juce::String& itemId, const juce::String& filePath);

    /** Read a library item's source file path. */
    juce::String getLibraryItemFilePath(const juce::String& itemId) const;

    /** Read a library item's decoded-WAV playback path. Empty when
     *  no cache has been written yet. */
    juce::String getLibraryItemPlaybackPath(const juce::String& itemId) const;

    /** Replace or clear the detected musical key for a library item.
     *  Pass an empty string to clear. Marks dirty. Returns true if
     *  the item existed. */
    bool setLibraryItemKey(const juce::String& itemId, const juce::String& key);

    /** Partial update of a saved-clip library item's warp + pitch
     *  defaults — the same five fields a `CLIP_SET_WARP` carries.
     *  Mirrors `setClipWarp` exactly so save/load round-trip is
     *  uniform between clips and saved clips. No-op (returns false)
     *  on `audio-file` items; warp is meaningful only on saved
     *  clips. */
    bool setLibraryItemWarp(const juce::String& itemId,
                            std::optional<bool> warpEnabled,
                            std::optional<juce::String> warpMode,
                            std::optional<double> tempoRatio,
                            bool tempoRatioClear,
                            std::optional<double> semitones,
                            std::optional<double> cents);

    /** Clear persisted BPM/beat/variable-tempo fields before a forced
     *  reanalysis. Derived cache metadata — does NOT mark the project
     *  dirty (clicking Re-analyse is a request to recompute, not an
     *  edit to the project itself). Returns true if the item existed. */
    bool clearLibraryItemAnalysis(const juce::String& itemId);

    /** Read the cached-decoded-WAV path for the library item with
     *  `filePath` as its source path. Returns empty string when no
     *  matching item exists or no cache has been written yet. Used
     *  by `handleClipAdd` to prefer the cached WAV over the original
     *  for new clip sources. */
    juce::String getLibraryItemPlaybackPathForSource(const juce::String& sourceFilePath) const;

    /** Flag (or clear) the library item as having a variable tempo —
     *  drives the UI badge and suppresses the first-clip project
     *  BPM seed. Derived cache metadata — does NOT mark the project
     *  dirty. Returns true if the item existed. */
    bool setLibraryItemVariableTempo(const juce::String& itemId, bool variable);

    /** Flag (or clear) the library item as having a low-confidence
     *  BPM analysis result — used by the renderer to auto-classify
     *  it as a non-musical "sample". Derived cache metadata — does
     *  NOT mark the project dirty. Returns true if the item existed. */
    bool setLibraryItemLowConfidence(const juce::String& itemId, bool lowConfidence);

    /** Persist the user's classification override for a library
     *  item: "sample" forces non-musical treatment, "music" forces
     *  musical treatment, empty/absent restores auto-classification
     *  from `lowConfidence`. Marks dirty. Returns true if the item
     *  existed. */
    bool setLibraryItemSampleMode(const juce::String& itemId, const juce::String& mode);

    /** True if a library item is registered for `filePath`. Used by the
     *  detection scheduler to avoid duplicate work. */
    bool hasLibraryItemForPath(const juce::String& filePath) const;

    /** Read the BPM on the library item matching `filePath`. Returns 0
     *  if no item matches or no BPM has been detected yet. */
    double getLibraryItemBpmForPath(const juce::String& filePath) const;

    /** Snapshot the persisted library items, ready to drop into a
     *  PROJECT_STATE envelope's `library` field. */
    juce::var libraryAsJson() const;

    // ─── Timeline markers ──────────────────────────────────────────────

    /** Add a timeline marker at an absolute project position in ms. Marks dirty. */
    bool addMarker(const juce::String& markerId, double positionMs);

    /** Move an existing timeline marker. Returns false when no marker matches. */
    bool moveMarker(const juce::String& markerId, double positionMs);

    /** Remove an existing timeline marker. Returns false when no marker matches. */
    bool removeMarker(const juce::String& markerId);

    /** Snapshot persisted timeline markers for PROJECT_STATE. */
    juce::var markersAsJson() const;

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
    void recomputeDirty();

    /**
     * Writes a property that is persisted on the project tree but is
     * NOT considered a user-facing edit (view zoom, scroll, playhead).
     * Mirrors the value into `cleanSnapshot` so the post-edit
     * equivalence check used by `recomputeDirty()` continues to ignore
     * the property — without that mirror, any drift between the live
     * tree and the snapshot would survive an undo and leave the project
     * stuck in the dirty state.
     */
    void setNonDirtyRootProperty(const juce::Identifier& id, const juce::var& value);

    /**
     * Apply a mutation to a library item *without* marking the project
     * dirty. Used for derived/cache metadata (BPM analysis, beat grid,
     * decoded-WAV playback path) that is regenerated from the source
     * audio file and should not force the user to "save" their project
     * just because a background analysis finished. Finds the item by
     * id in both `root` and `cleanSnapshot`, applies the mutator to
     * each under suppression. Returns true if the item existed in the
     * live tree. If the item exists only in `root` (added after the
     * last `markClean`) the live mutation still happens but the
     * snapshot mirror is skipped — that's harmless because the item
     * itself is already a structural delta against the snapshot.
     */
    bool mutateDerivedLibraryItem(const juce::String& itemId,
                                  const std::function<void(juce::ValueTree&)>& mutator);

    juce::ValueTree root;
    juce::ValueTree cleanSnapshot;
    juce::UndoManager undoManager;
    bool dirty{false};
    /**
     * Re-entrant suppression depth for listener-driven dirty
     * transitions. Bumped via the scoped `SuppressDirtyScope` guard
     * below — listeners early-out whenever depth > 0. Used by
     * `replaceTree` (a project load is by definition clean) and by
     * `setNonDirtyRootProperty` (view / playhead state mutations that
     * are persisted but never count as user edits). A counter rather
     * than a bool so a nested suppression scope cannot accidentally
     * unsuppress a still-active outer scope.
     */
    int suppressDirtyDepth{0};
    DirtyChangedCallback onDirtyChanged;

    /**
     * RAII guard that bumps `suppressDirtyDepth` on construction and
     * decrements it on destruction. Exception-safe (the listeners stay
     * suppressed only for the lifetime of the scope) and nest-safe (a
     * nested scope still increments then decrements, so the outer
     * scope's suppression remains intact).
     */
    class SuppressDirtyScope
    {
    public:
        explicit SuppressDirtyScope(ProjectState& owner) noexcept : state(owner)
        {
            ++state.suppressDirtyDepth;
        }
        ~SuppressDirtyScope() noexcept { --state.suppressDirtyDepth; }
        SuppressDirtyScope(const SuppressDirtyScope&) = delete;
        SuppressDirtyScope& operator=(const SuppressDirtyScope&) = delete;

    private:
        ProjectState& state;
    };

    // ValueTree identifiers — defined once so typos surface at link time
    // rather than as silent zero-property reads on the audio side.
    static const juce::Identifier kProject;
    static const juce::Identifier kTrack;
    static const juce::Identifier kClip;
    static const juce::Identifier kId;
    static const juce::Identifier kName;
    static const juce::Identifier kGain;
    static const juce::Identifier kMuted;
    static const juce::Identifier kSoloed;
    static const juce::Identifier kHeightPx;
    static const juce::Identifier kFilePath;
    static const juce::Identifier kOffsetMs;
    static const juce::Identifier kInMs;
    static const juce::Identifier kDurationMs;
    static const juce::Identifier kSampleRate;
    static const juce::Identifier kChannelCount;
    static const juce::Identifier kColorIndex;
    static const juce::Identifier kLocked;
    static const juce::Identifier kViewPxPerSecond;
    static const juce::Identifier kViewScrollX;
    static const juce::Identifier kPlayheadMs;
    static const juce::Identifier kBpm;
    static const juce::Identifier kProjectLengthMs;
    static const juce::Identifier kAudioOutputTypeName;
    static const juce::Identifier kAudioOutputDeviceName;
    static const juce::Identifier kTargetSampleRate;
    static const juce::Identifier kExportSettingsJson;
    static const juce::Identifier kMasterVolume;
    static const juce::Identifier kLibrary;
    static const juce::Identifier kLibraryItem;
    static const juce::Identifier kMarkers;
    static const juce::Identifier kMarker;
    static const juce::Identifier kPositionMs;
    static const juce::Identifier kBeats;
    static const juce::Identifier kBeatAnchorSec;
    static const juce::Identifier kPlaybackFilePath;
    static const juce::Identifier kVariableTempo;
    static const juce::Identifier kLowConfidence;
    static const juce::Identifier kSampleMode;
    static const juce::Identifier kKey;
    static const juce::Identifier kKind;
    static const juce::Identifier kSourceItemId;
    static const juce::Identifier kSourceClipId;
    static const juce::Identifier kSourceInMs;
    static const juce::Identifier kSourceDurationMs;
    static const juce::Identifier kDisplayName;
    static const juce::Identifier kClipName;
    static const juce::Identifier kCollapsed;
    static const juce::Identifier kLibraryItemId;

    // Per-clip warp + pitch shift. Identifiers are reused for the same
    // properties on saved-clip library items (where they act as the
    // copy-on-drop defaults for a future timeline placement).
    static const juce::Identifier kWarpEnabled;
    static const juce::Identifier kWarpMode;
    static const juce::Identifier kTempoRatio;
    static const juce::Identifier kSemitones;
    static const juce::Identifier kCents;
    static const juce::Identifier kPendingAutoWarp;
};

} // namespace silverdaw
