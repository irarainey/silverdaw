#pragma once

#include <atomic>
#include <functional>
#include <optional>
#include <vector>
#include <juce_core/juce_core.h>
#include <juce_data_structures/juce_data_structures.h>

#include "EdgeFadeSnapshot.h"

namespace silverdaw
{

// Backend-authoritative ValueTree model; message-thread owned, undoable, and persisted as a unit.
// Dirty tracking compares against a clean snapshot so net-zero edits can return to clean.

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

    bool isDirty() const noexcept
    {
        return dirty;
    }

    // Called after load/save/new when memory matches disk or the blank canvas.
    void markClean();

    // Crash recovery marks dirty because autosave is not a real save target.
    void markDirty();

    /** Register a callback fired on every dirty-flag transition. */
    void setDirtyChangedCallback(DirtyChangedCallback callback);

    /** User-facing project name; "Untitled" until renamed or loaded. */
    juce::String getName() const;

    /** Update the project's name. Empty / blank inputs are coerced to `kDefaultName`. */
    void setName(const juce::String& name);

    /** Add an empty track. Idempotent: returns true if `trackId` already exists. */
    bool addTrack(const juce::String& trackId);

    // Returns removed clip ids so the engine can drop playable sources in lockstep.
    juce::StringArray removeTrack(const juce::String& trackId);

    /** Returns true if `trackId` exists in the tree. */
    bool hasTrack(const juce::String& trackId) const;

    // `newIndex` is track-ordinal; moveChild keeps ordering undoable.
    bool moveTrack(const juce::String& trackId, int newIndex);

    // Stores user volume; mute/solo effective gain is derived so volume survives toggles.
    float getTrackGain(const juce::String& trackId) const;

    // Mute/solo persist; effective gain is derived from volume and solo context.
    bool getTrackMuted(const juce::String& trackId) const;
    bool getTrackSoloed(const juce::String& trackId) const;
    bool anyTrackSoloed() const;

    float getEffectiveTrackGain(const juce::String& trackId) const;

    /** Set a track's user-facing name. Blank names are rejected. */
    bool setTrackName(const juce::String& trackId, const juce::String& name);

    // Sets user volume without clearing mute/solo.
    bool setTrackGain(const juce::String& trackId, float gain);

    bool setTrackMuted(const juce::String& trackId, bool muted);
    bool setTrackSoloed(const juce::String& trackId, bool soloed);

    // Defaults are suppressed so no-op drag echoes can skip broadcasts and undo entries.
    bool setTrackSends(const juce::String& trackId, float reverbSend, float delaySend);

    float getTrackReverbSend(const juce::String& trackId) const;
    float getTrackDelaySend(const juce::String& trackId) const;

    // Centred pan is suppressed so legacy projects round-trip byte-equivalent.
    bool setTrackPan(const juce::String& trackId, float pan);
    float getTrackPan(const juce::String& trackId) const;

    // Tone defaults are suppressed so flat tracks preserve legacy file shape.
    bool setTrackTone(const juce::String& trackId, float bassDb, float midDb, float trebleDb,
                      bool lowCut, bool highCut);
    float getTrackToneBassDb(const juce::String& trackId) const;
    float getTrackToneMidDb(const juce::String& trackId) const;
    float getTrackToneTrebleDb(const juce::String& trackId) const;
    bool getTrackToneLowCut(const juce::String& trackId) const;
    bool getTrackToneHighCut(const juce::String& trackId) const;

    // Zero amount is suppressed until Leveler DSP makes this more than persistence.
    bool setTrackLevelerAmount(const juce::String& trackId, float amount);
    float getTrackLevelerAmount(const juce::String& trackId) const;

    // One array property keeps envelope drags atomic and default suppression simple.
    bool setClipEnvelope(const juce::String& clipId, const juce::Array<juce::var>& points);
    juce::Array<juce::var> getClipEnvelope(const juce::String& clipId) const;

    // Transitions store partners only; overlap is derived from live clip geometry.

    // Derived edge fades are ready for AudioEngine::setClipEdgeFade.
    struct ClipEdgeFade
    {
        bool hasFadeIn = false;
        double fadeInStartMs = 0.0;
        double fadeInEndMs = 0.0;
        EdgeFadeCurve fadeInCurve = EdgeFadeCurve::equalPower;
        bool hasFadeOut = false;
        double fadeOutStartMs = 0.0;
        double fadeOutEndMs = 0.0;
        EdgeFadeCurve fadeOutCurve = EdgeFadeCurve::equalPower;
        bool any() const noexcept { return hasFadeIn || hasFadeOut; }
    };

    // Rejects invalid overlaps or reused edges so each clip edge has one crossfade owner.
    bool addTransition(const juce::String& trackId, const juce::String& transitionId,
                       const juce::String& leftClipId, const juce::String& rightClipId,
                       const juce::var& recipe);

    /** Remove a transition by id from `trackId`. Returns true if it existed. */
    bool removeTransition(const juce::String& trackId, const juce::String& transitionId);

    /** Replace a transition's recipe. Returns true if it existed and changed. */
    bool setTransitionRecipe(const juce::String& trackId, const juce::String& transitionId,
                             const juce::var& recipe);

    ClipEdgeFade getClipEdgeFade(const juce::String& clipId) const;

    // `useUndo=false` keeps load-time transition cleanup out of undo history.
    bool reconcileTransitions(bool useUndo);

    // Cheap guard for skipping transition reconcile/sync on transition-free projects.
    bool hasAnyTransition() const;

    // Reverb defaults are suppressed so untouched projects stay byte-clean.
    bool setProjectReverb(float size, float decay, float tone, float mix);
    float getProjectReverbSize() const;
    float getProjectReverbDecay() const;
    float getProjectReverbTone() const;
    float getProjectReverbMix() const;

    // Unknown delay note values are rejected rather than persisted.
    bool setProjectDelay(const juce::String& noteValue, float feedback, float tone, float mix);
    juce::String getProjectDelayNoteValue() const;
    float getProjectDelayFeedback() const;
    float getProjectDelayTone() const;
    float getProjectDelayMix() const;

    // Height is clamped so bridge payloads cannot make rows invisible.
    double getTrackHeightPx(const juce::String& trackId) const;

    // Mirrors renderer clamps to keep persisted heights inside resize-handle range.
    bool setTrackHeightPx(const juce::String& trackId, double heightPx);

    /** Ordered ids of all clips on `trackId` (empty if the track is missing). */
    juce::StringArray getTrackClipIds(const juce::String& trackId) const;

    /** Ids of every clip in the project, across all tracks. */
    juce::StringArray getAllClipIds() const;

    bool addClip(const juce::String& trackId, const juce::String& clipId, const juce::String& libraryItemId,
                 double offsetMs, double durationMs, double inMs = 0.0, int colorIndex = -1);

    /** Remove a clip. Returns true if it existed. */
    bool removeClip(const juce::String& clipId);

    /** Update a clip's timeline offset. Returns true if the clip existed. */
    bool setClipOffsetMs(const juce::String& clipId, double offsetMs);

    // ValueTree re-parenting preserves clip properties.
    bool setClipTrack(const juce::String& clipId, const juce::String& newTrackId);

    // Keeps trim window writes together so dirty/undo semantics stay coherent.
    bool setClipTrim(const juce::String& clipId, double offsetMs, double inMs, double durationMs);

    // `-1` restores host-track colour inheritance.
    bool setClipColorIndex(const juce::String& clipId, int colorIndex);

    // Clip lock is UI-only and per-instance; false is suppressed on disk/wire.
    bool setClipLocked(const juce::String& clipId, bool locked);

    /** Read a clip's lock flag. Defaults to false. */
    bool isClipLocked(const juce::String& clipId) const;

    // Clip reverse is a non-destructive per-instance flag; false is suppressed on disk/wire.
    bool setClipReversed(const juce::String& clipId, bool reversed);

    /** Read a clip's reverse flag. Defaults to false. */
    bool isClipReversed(const juce::String& clipId) const;

    /** Read the clip's `inMs` (where in the source file it starts reading). 0 if unknown. */
    double getClipInMs(const juce::String& clipId) const;

    /** Read the clip's `durationMs`. 0 if unknown. */
    double getClipDurationMs(const juce::String& clipId) const;

    // Relink writes the replacement path so the engine can recreate the source.
    bool setClipFilePath(const juce::String& clipId, const juce::String& filePath);

    juce::String getClipLibraryItemId(const juce::String& clipId) const;

    bool setClipLibraryItemId(const juce::String& clipId, const juce::String& libraryItemId);

    // Empty clip names clear the display-name override.
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
            // Distinguishes pending auto-warp from explicit warp-off before BPM was known.
        bool pendingAutoWarp;
    };

    // Used to re-stretch unpinned warped clips after project tempo changes.
    void forEachWarpClip(const std::function<void(const WarpClipInfo&)>& visitor) const;

    struct EffectiveClipTiming
    {
        double tempoRatio = 1.0;
        double durationMs = 0.0;
        bool warpActive = false;
    };

    // Effective duration is timeline/output time; stored duration remains source time.
    EffectiveClipTiming getClipEffectiveTiming(const juce::String& clipId) const;

    double getLibraryItemBpm(const juce::String& itemId) const;

    // Optional fields allow partial warp edits; `tempoRatioClear` reverts to project-BPM tracking.
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

    // View state persists but is mirrored into cleanSnapshot so it never marks dirty.

    /** Horizontal zoom (pixels per second). Defaults to 60. */
    double getViewPxPerSecond() const;

    /** Update the persisted zoom level. Does NOT mark the project dirty. */
    void setViewPxPerSecond(double pxPerSecond);

    /** Horizontal scroll position in pixels (renderer-space). Defaults to 0. */
    double getViewScrollX() const;

    /** Update the persisted scroll position. Does NOT mark the project dirty. */
    void setViewScrollX(double scrollX);

    juce::String getViewSelectedTrack() const;

    // Selection is navigation, not a content edit.
    void setViewSelectedTrack(const juce::String& trackId);

    bool getViewFxPanelOpen() const;

    void setViewFxPanelOpen(bool open);

    /** Persisted playhead position in ms. Defaults to 0. */
    double getPlayheadMs() const;

    /** Update the persisted playhead position. Does NOT mark the project dirty. */
    void setPlayheadMs(double playheadMs);

    /** Project tempo in BPM. Defaults to 100. */
    double getBpm() const;

    /** Update the tempo. Marks the project dirty as a normal property edit. */
    void setBpm(double bpm);

    /** True once the project tempo has been auto-seeded from the first musical
     *  clip placed on a track. Prevents later clips (or derived stems) from
     *  overriding an already-established project tempo. */
    bool isBpmSeeded() const;

    /** Record whether the project tempo has been auto-seeded. Does NOT mark dirty. */
    void setBpmSeeded(bool seeded);

    double getProjectLengthMs() const;

    /** Update the persisted project length. Marks dirty. */
    void setProjectLengthMs(double lengthMs);

    // Empty audio-output fields mean no project-level override.
    juce::String getAudioOutputTypeName() const;
    juce::String getAudioOutputDeviceName() const;

    // Empty strings clear the project override so user-scope preferences apply.
    void setAudioOutput(const juce::String& typeName, const juce::String& deviceName);

    // Zero means no project override; renderer falls back to user/default sample rate.
    int getTargetSampleRate() const;

    // Passing 0 clears the project sample-rate override.
    void setTargetSampleRate(int sampleRate);

    // Renderer-owned export settings are round-tripped verbatim.
    juce::String getExportSettingsJson() const;

    // Export choices mark dirty but stay out of the editing undo stack.
    void setExportSettingsJson(const juce::String& json);

    // Shared by live playback and export so rendered output matches monitoring.
    float getMasterVolume() const;

    // Unity is suppressed so legacy projects round-trip without an extra property.
    void setMasterVolume(float volume);

    // Library items persist imported sources; rich metadata is re-read by the renderer.

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

    // Derived BPM metadata is regenerated from source and does not mark dirty.
    bool setLibraryItemBpm(const juce::String& itemId, double bpm);

    // Derived beat metadata is regenerated from source and does not mark dirty.
    bool setLibraryItemBeats(const juce::String& itemId, const std::vector<double>& beatTimesSec);

    // Derived beat anchor supports renderer beat-grid layout without marking dirty.
    bool setLibraryItemBeatAnchor(const juce::String& itemId, double anchorSec);

    // Decoded-WAV cache paths are derived metadata and do not mark dirty.
    bool setLibraryItemPlaybackPath(const juce::String& itemId, const juce::String& playbackPath);

    // Relinking the library item updates all clips that reference it.
    bool setLibraryItemFilePath(const juce::String& itemId, const juce::String& filePath);

    /** Read a library item's source file path. */
    juce::String getLibraryItemFilePath(const juce::String& itemId) const;

    juce::String getLibraryItemPlaybackPath(const juce::String& itemId) const;

    // Empty key clears the detected-key override.
    bool setLibraryItemKey(const juce::String& itemId, const juce::String& key);

    // Saved-clip warp defaults mirror clip warp fields for copy-on-drop consistency.
    bool setLibraryItemWarp(const juce::String& itemId,
                            std::optional<bool> warpEnabled,
                            std::optional<juce::String> warpMode,
                            std::optional<double> tempoRatio,
                            bool tempoRatioClear,
                            std::optional<double> semitones,
                            std::optional<double> cents);

    // Re-analysis clears derived metadata without marking the project dirty.
    bool clearLibraryItemAnalysis(const juce::String& itemId);

    // Clip ingest prefers cached WAVs when available.
    juce::String getLibraryItemPlaybackPathForSource(const juce::String& sourceFilePath) const;

    // Variable-tempo analysis suppresses project-BPM seeding without marking dirty.
    bool setLibraryItemVariableTempo(const juce::String& itemId, bool variable);

    // Low-confidence analysis feeds auto-classification without marking dirty.
    bool setLibraryItemLowConfidence(const juce::String& itemId, bool lowConfidence);

    // Classification override beats low-confidence auto-classification.
    bool setLibraryItemSampleMode(const juce::String& itemId, const juce::String& mode);

    bool hasLibraryItemForPath(const juce::String& filePath) const;

    double getLibraryItemBpmForPath(const juce::String& filePath) const;

    juce::var libraryAsJson() const;

    /** Add a timeline marker at an absolute project position in ms. Marks dirty. */
    bool addMarker(const juce::String& markerId, double positionMs);

    /** Move an existing timeline marker. Returns false when no marker matches. */
    bool moveMarker(const juce::String& markerId, double positionMs);

    /** Remove an existing timeline marker. Returns false when no marker matches. */
    bool removeMarker(const juce::String& markerId);

    /** Snapshot persisted timeline markers for PROJECT_STATE. */
    juce::var markersAsJson() const;

    juce::var tracksAsJson() const;

    const juce::ValueTree& getTree() const noexcept
    {
        return root;
    }

    // Preserves root node identity for listeners; clears undo because loads are a new baseline.
    juce::Result replaceTree(const juce::ValueTree& newTree);

    /** Access the shared undo manager (Phase 7 will surface this in the UI). */
    juce::UndoManager& getUndoManager() noexcept
    {
        return undoManager;
    }

  private:
    juce::ValueTree findTrack(const juce::String& trackId) const;
    juce::ValueTree findClip(const juce::String& clipId) const;

    juce::var buildTransitionsJson(const juce::ValueTree& track) const;

    // Transition math uses warp-scaled timeline footprints.
    bool clipTimelineSpanMs(const juce::String& clipId, double& startMs, double& endMs) const;

    // Valid transitions require a proper tail/head overlap with no third-clip intrusion.
    bool transitionOverlapMs(const juce::ValueTree& track,
                             const juce::String& leftClipId, const juce::String& rightClipId,
                             double& overlapStartMs, double& overlapEndMs) const;

    void valueTreePropertyChanged(juce::ValueTree& /*tree*/,
                                  const juce::Identifier& /*property*/) override;
    void valueTreeChildAdded(juce::ValueTree& /*parent*/, juce::ValueTree& /*child*/) override;
    void valueTreeChildRemoved(juce::ValueTree& /*parent*/, juce::ValueTree& /*child*/,
                               int /*index*/) override;
    void valueTreeChildOrderChanged(juce::ValueTree& /*parent*/, int /*oldIndex*/,
                                    int /*newIndex*/) override;

    void setDirty(bool d);
    void recomputeDirty();

    // Mirrors non-edit state into cleanSnapshot so undo cannot leave phantom dirty deltas.
    void setNonDirtyRootProperty(const juce::Identifier& id, const juce::var& value);

    // Derived library metadata mirrors into cleanSnapshot so background analysis stays non-dirty.
    bool mutateDerivedLibraryItem(const juce::String& itemId,
                                  const std::function<void(juce::ValueTree&)>& mutator);

    juce::ValueTree root;
    juce::ValueTree cleanSnapshot;
    juce::UndoManager undoManager;
    bool dirty{false};
    // Counter, not bool, so nested dirty-suppression scopes cannot unsuppress an outer scope.
    int suppressDirtyDepth{0};
    DirtyChangedCallback onDirtyChanged;

    // RAII keeps dirty-suppression exception-safe and nest-safe.
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

    // Central identifiers make property typos link-time failures.
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
    static const juce::Identifier kReversed;
    static const juce::Identifier kViewPxPerSecond;
    static const juce::Identifier kViewScrollX;
    static const juce::Identifier kViewSelectedTrack;
    static const juce::Identifier kViewFxPanelOpen;
    static const juce::Identifier kPlayheadMs;
    static const juce::Identifier kBpm;
    static const juce::Identifier kBpmSeeded;
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

    // Reused on saved-clip library items as copy-on-drop defaults.
    static const juce::Identifier kWarpEnabled;
    static const juce::Identifier kWarpMode;
    static const juce::Identifier kTempoRatio;
    static const juce::Identifier kSemitones;
    static const juce::Identifier kCents;
    static const juce::Identifier kPendingAutoWarp;

    // Sends persist only when non-zero.
    static const juce::Identifier kSendReverb;
    static const juce::Identifier kSendDelay;
    static const juce::Identifier kPan;

    // Tone defaults are suppressed for byte-equivalent legacy round-trips.
    static const juce::Identifier kToneBassDb;
    static const juce::Identifier kToneMidDb;
    static const juce::Identifier kToneTrebleDb;
    static const juce::Identifier kToneLowCut;
    static const juce::Identifier kToneHighCut;

    // Leveler is currently persisted as the user-facing amount knob.
    static const juce::Identifier kLevelerAmount;

    // Envelope stays one array property for atomic edits.
    static const juce::Identifier kEnvelopePoints;
    static const juce::Identifier kEnvelopeTimeMs;
    static const juce::Identifier kEnvelopeGain;

    // Transition overlap is derived, never stored.
    static const juce::Identifier kTransition;
    static const juce::Identifier kLeftClipId;
    static const juce::Identifier kRightClipId;
    static const juce::Identifier kRecipe;
    static const juce::Identifier kRecipeKind;

    // Phase 5 — project-shared Reverb bus. Scalars are 0..1 linear.
    static const juce::Identifier kReverbSize;
    static const juce::Identifier kReverbDecay;
    static const juce::Identifier kReverbTone;
    static const juce::Identifier kReverbMix;

    // Delay noteValue is a tempo-locked beat division; other values are 0..1.
    static const juce::Identifier kDelayNoteValue;
    static const juce::Identifier kDelayFeedback;
    static const juce::Identifier kDelayTone;
    static const juce::Identifier kDelayMix;
};

class AudioEngine;

// Clears clips with no transition so they stay on the null fast path.
void syncClipEdgeFades(AudioEngine& engine, const ProjectState& project);

} // namespace silverdaw
