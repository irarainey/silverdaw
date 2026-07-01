// Renderer -> Backend (outbound) wire-protocol payloads, the BridgeOutboundMap
// type->payload index, and the derived send() helper types. Re-exported via the
// @shared/bridge-protocol facade.
//
// FILE-SIZE EXCEPTION (justified): a single cohesive catalogue of one wire direction
// (pure interfaces, no logic); BridgeOutboundMap is its own index, so splitting it
// by domain would only add file-hopping cost.

// Type-only imports of shared vocabulary whose canonical zod definition lives with inbound.
import type { LibraryItemKind, StemName, TransitionRecipe } from './inbound'

// ─── Renderer → Backend (outbound) ──────────────────────────────────────────

export interface ClipAddPayload {
  trackId: string
  clipId: string
  /** Source library item; clips reference audio via the library, never a path. */
  libraryItemId: string
  positionMs: number
  /** Trim-window start in the source file; omit/0 for a whole-file clip. */
  inMs?: number
  /** Trim-window length from `inMs`; omit/0 to play to the source end. */
  durationMs?: number
  /** Palette index 0..15; omit to inherit the track colour. */
  colorIndex?: number
}

export interface ClipMovePayload {
  clipId: string
  positionMs: number
  /** Optional cross-track move; backend re-parents the clip's ValueTree node (ProjectState only). */
  trackId?: string
  /** True on drag release; lets the backend reset read-ahead before the next Play. */
  commit?: boolean
}

/** Atomic three-field trim update; all three required so the audio thread never sees
 *  an inconsistent (start, in, duration) triple. */
export interface ClipTrimPayload {
  clipId: string
  startMs: number
  inMs: number
  durationMs: number
}

/** Update a clip's colour override; a negative value clears it (re-inherits the track colour). */
export interface ClipColorPayload {
  clipId: string
  colorIndex: number
}

/** Toggle a clip's lock flag (blocks move/trim; editor still opens). Per-clip; not shared across siblings. */
export interface ClipSetLockedPayload {
  clipId: string
  locked: boolean
}

/** Play a clip's window backwards (non-destructive). Propagated across library-clip siblings. */
export interface ClipSetReversedPayload {
  clipId: string
  reversed: boolean
}

/** Apply a turntable brake (record-stop) at the clip's end; `on` toggles it. */
export interface ClipSetBrakePayload {
  clipId: string
  on: boolean
}

/** Apply a turntable backspin (reverse rewind) at the clip's end; `on` toggles it.
 *  Mutually exclusive with the brake. */
export interface ClipSetBackspinPayload {
  clipId: string
  on: boolean
}

/** Remove a clip; backend tears down its audio source. Renderer removes optimistically on send. */
export interface ClipRemovePayload {
  clipId: string
}

/** Relink a library item to a new source file; all clips referencing it update automatically. */
export interface LibraryItemRelinkPayload {
  itemId: string
  filePath: string
}

/** Clip display-name override; empty string clears it (falls back to library item/filename). */
export interface ClipRenamePayload {
  clipId: string
  name: string
}

/** Rebind a clip to a new parent library item (used by "Save clip to library"). */
export interface ClipRebindPayload {
  clipId: string
  libraryItemId: string
}

/** Request high-res peaks at `peaksPerSecond` for the Clip Editor's deep zoom; backend caches to disk. */
export interface ClipEditorPeaksRequestPayload {
  libraryItemId: string
  peaksPerSecond: number
}

/** Register a library item so its durable fields persist; volatile data (peaks, URLs) is rebuilt on demand. */
export interface LibraryAddPayload {
  itemId: string
  filePath: string
  kind?: LibraryItemKind
  name?: string
  fileName?: string
  durationMs?: number
  sampleRate?: number
  channelCount?: number
  playbackFilePath?: string
  key?: string
  /** Media GUID minted at first import; the key into the project's metadata/covers store.
   *  Carried over to every derived stem/sample so they share the source's cover art + tags. */
  mediaId?: string
  sourceItemId?: string
  sourceClipId?: string
  sourceInMs?: number
  sourceDurationMs?: number
  /** True when the source's library-clip list is collapsed in the library panel. */
  collapsed?: boolean
  /** Saved-clip default warp (kind === 'clip'); copied onto a clip on drop (not a live link). */
  warpEnabled?: boolean
  warpMode?: ClipWarpMode
  tempoRatio?: number
  semitones?: number
  cents?: number
}

/** Drop a library item from the persisted catalogue. */
export interface LibraryRemovePayload {
  itemId: string
  /** True when the item's generated file is being deleted from disk ("clean up project
   *  files"). The backend then removes the item without marking the project dirty or
   *  recording an undo step, because the removal is irreversible. */
  cleanup?: boolean
}

/** Delete a removed library item's generated stem/sample files and prune the
 *  per-source folder any last file left empty. The backend confines every path to
 *  the project's stems/samples artifact trees, so a user's original imported source
 *  can never be deleted. Sent only when the "clean up project files" preference is on. */
export interface LibraryDeleteArtifactsPayload {
  paths: string[]
}

/** Force a full analysis refresh: backend rebuilds its decoded-WAV cache and reruns BPM/beat detection. */
export interface LibraryReanalysePayload {
  itemId: string
  filePath: string
  fileName?: string
  durationMs?: number
  sampleRate?: number
  channelCount?: number
  playbackFilePath?: string
  /** Empty string explicitly clears a previous key when detection is inconclusive. */
  key?: string
}

/** User classification override: 'simple'/'music' persist; 'auto' clears it (falls back to lowConfidence). */
export interface LibraryItemSetAudioTypePayload {
  itemId: string
  audioType: 'simple' | 'music' | 'auto'
}

/** Hide (or restore) a library item's cover art on its tile without deleting the shared
 *  media-store image. A per-item display flag persisted in the project. */
export interface LibraryItemSetCoverHiddenPayload {
  itemId: string
  hidden: boolean
}

/** Point a library item at a per-item custom cover image (the basename of a file copied
 *  into the project's covers dir). Empty `coverFile` clears the override. */
export interface LibraryItemSetCoverOverridePayload {
  itemId: string
  coverFile: string
}

/**
 * Manual tempo override for a source item. Sets a confident BPM + grid phase
 * anchor (seconds), replacing any auto-detected tempo. The backend builds a
 * rigid metronome grid and clears the variable / low-confidence flags, then
 * broadcasts `LIBRARY_ITEM_ANALYSIS`. Used by the clip-editor manual-tempo
 * fallback (set BPM + slide the grid to align it to the waveform).
 */
export interface LibraryItemSetManualTempoPayload {
  itemId: string
  bpm: number
  beatAnchorSec: number
}

export interface TrackAddPayload {
  trackId: string
  /** Initial display name for new tracks. Optional for older clients. */
  name?: string
  /** Palette colour persisted so inherited clip colours stay stable across reloads. */
  colorIndex?: number
}

export interface TrackRemovePayload {
  trackId: string
}

export interface TrackRenamePayload {
  trackId: string
  name: string
}

export interface TrackGainPayload {
  trackId: string
  /** User volume, linear gain 0..~1.9953 (+6 dB). Pre-mute/solo; backend derives audible gain. */
  gain: number
}

/** Toggle a track's mute flag; backend recomputes audible gain. Echoed via TRACK_MUTE_APPLIED. */
export interface TrackMutePayload {
  trackId: string
  muted: boolean
}

/** Toggle a track's solo flag; backend re-pushes effective gain for the whole project. */
export interface TrackSoloPayload {
  trackId: string
  soloed: boolean
}

/** Persist a track row height; sent once on pointerup (drag motion stays renderer-local). */
export interface TrackSetHeightPayload {
  trackId: string
  /** Row height (CSS px); backend clamps to a min/max so a hostile payload can't break layout. */
  heightPx: number
}

/** Reorder a track; `newIndex` is the desired 0-based position (backend clamps). One undo step. */
export interface TrackReorderPayload {
  trackId: string
  newIndex: number
}

/**
 * Time-stretch + pitch-shift mode: 'rhythmic' (light, percussive; auto-warp default),
 * 'tonal' (melodic/vocal), 'complex' (highest quality/CPU; export and user-escalated clips).
 */
export type ClipWarpMode = 'rhythmic' | 'tonal' | 'complex'

/**
 * Per-clip warp + pitch settings. Partial-update: only the fields present are mutated.
 * `tempoRatio` = projectBpm / sourceBpm (2.0 = double speed); absent = derive live from
 * project BPM, present = pinned override. `semitones` ±12, `cents` ±100; pitch scale
 * 2^((semitones + cents/100) / 12), independent of tempo. Undoable; collision-checked
 * against neighbouring clips when the effective duration changes.
 */
export interface ClipSetWarpPayload {
  clipId: string
  warpEnabled?: boolean
  warpMode?: ClipWarpMode
  tempoRatio?: number | null
  semitones?: number
  cents?: number
  /** Clip is waiting on LIBRARY_ITEM_ANALYSIS for a source BPM; cleared by any later CLIP_SET_WARP. */
  pendingAutoWarp?: boolean
}

export interface ClipSaveAsSamplePayload {
  clipId: string
  itemId: string
  sampleName: string
  /** 'music' inherits the source bpm/beats/key (warps on drop); 'simple' is a
   *  bare one-shot with no musical metadata (never auto-warps on drop). */
  audioType?: 'simple' | 'music'
}

export interface ClipSliceToSamplesPayload {
  clipId: string
  /** See ClipSaveAsSamplePayload.audioType. */
  audioType?: 'simple' | 'music'
  /** Ascending source-time windows; each is written as its own library sample. */
  slices: ReadonlyArray<{ itemId: string; inMs: number; durationMs: number }>
}

// ─── Effects envelopes (Bass / Mid / Treble / Leveler / Sends / shared FX) ──
//
// Mutation envelopes optionally carry `gestureId` + `gestureEnd` so the backend
// coalesces a drag stream into one undo step (falling back to a 500 ms window when
// absent). Handlers ack with a dedicated `*_APPLIED` envelope, not a full PROJECT_STATE,
// so 60 Hz fader streams stay cheap on the wire.

/** Optional drag-coalesce hints. Shared by every Phase 5 mutation envelope. */
export interface GestureHints {
  /** Stable per-drag id (pointerdown→pointerup); backend coalesces on (messageType, targetId, gestureId). */
  gestureId?: string
  /** Marks the last event in a drag; applied in the same transaction, then the coalesce state resets. */
  gestureEnd?: boolean
}

/** Per-track Reverb / Delay send levels. Both default to 0 (no send). */
export interface TrackSetSendsPayload extends GestureHints {
  trackId: string
  /** Send to the project Reverb bus, 0..1 linear. Default 0. */
  reverbSend: number
  /** Send to the project Delay bus, 0..1 linear. Default 0. */
  delaySend: number
}

/** Per-track equal-power pan, signed [-1,1] (0 = centre). Default 0. */
export interface TrackSetPanPayload extends GestureHints {
  trackId: string
  pan: number
}

/** Per-track Tone — 3-band shelving EQ (dB [-15,+15]) plus a bipolar DJ-style
 *  Filter sweep (`filter` in [-1,+1]: <0 low-pass / High Cut, >0 high-pass /
 *  Low Cut, 0 = off). Partial-update; backend fills missing fields from
 *  persisted state. */
export interface TrackSetTonePayload extends GestureHints {
  trackId: string
  bassDb?: number
  midDb?: number
  trebleDb?: number
  filter?: number
}

/** Per-track Leveler — single "amount" knob in [0,1]. */
export interface TrackSetLevelerPayload extends GestureHints {
  trackId: string
  amount: number
}

/** One breakpoint on a track automation curve. */
export interface AutomationPoint {
  /** Timeline-absolute ms (>= 0). */
  timeMs: number
  /** Value in the parameter's native unit (dB, signed position, 0..1, …). */
  value: number
}

/** Automatable track parameters (must match the backend `AutomationParam`). */
export type AutomationParamId =
  | 'filter'
  | 'pan'
  | 'toneBass'
  | 'toneMid'
  | 'toneTreble'
  | 'reverbSend'
  | 'delaySend'
  | 'leveler'
  | 'level'

/** Per-track effect automation curve for one parameter (one atomic mutation per
 *  drag); backend sorts/clamps/dedupes. Fewer than two points clears the lane. */
export interface TrackSetAutomationPayload extends GestureHints {
  trackId: string
  paramId: AutomationParamId
  points: AutomationPoint[]
}

/** One breakpoint on a clip volume envelope. */
export interface ClipEnvelopePoint {
  /** Clip-local post-warp ms in `[0, clipDuration]`. */
  timeMs: number
  /** Linear gain in `[0, 4]` (~`-∞ .. +12 dB`). `1.0` is unity. */
  gain: number
}

/** Per-clip volume envelope (one atomic mutation per drag); backend sorts/clamps/dedupes. Empty = cleared. */
export interface ClipSetEnvelopePayload extends GestureHints {
  clipId: string
  points: ClipEnvelopePoint[]
}

// ─── Clip transitions (§12.1) ───────────────────────────────────────────────
//
// Discrete user actions (not drag streams): each is one undoable transaction that
// mutates both partner clips' edge-fades atomically and re-publishes PROJECT_STATE
// (which also carries reconciliation — no bespoke *_APPLIED ack).

/**
 * Create a transition over the overlap of two adjacent clips. `leftClipId` = earlier (fade-out),
 * `rightClipId` = later (fade-in). Backend validates adjacency/overlap and rejects otherwise.
 * `recipe` defaults to the equal-power `smooth` crossfade.
 */
export interface TransitionCreatePayload {
  trackId: string
  leftClipId: string
  rightClipId: string
  recipe?: TransitionRecipe
}

/** Delete a transition by id; partner clips keep their volume envelopes (only the edge-fade is removed). */
export interface TransitionDeletePayload {
  trackId: string
  transitionId: string
}

/** Swap the recipe on an existing transition in place. */
export interface TransitionSetRecipePayload {
  trackId: string
  transitionId: string
  recipe: TransitionRecipe
}

/** Project-shared Reverb bus. Scalars linear [0,1]; all optional (partial-update). */
export interface ProjectSetReverbPayload extends GestureHints {
  size?: number
  decay?: number
  tone?: number
  mix?: number
}

/** Legal tempo-locked beat divisions for the shared echo. */
export type DelayNoteValue = '1/4' | '1/8' | '1/8T' | '1/16'

/** Project-shared Delay bus. `noteValue` must exactly match a legal beat division or the backend drops it. */
export interface ProjectSetDelayPayload extends GestureHints {
  noteValue?: DelayNoteValue
  feedback?: number
  tone?: number
  mix?: number
}

export interface LibraryItemSaveAsSamplePayload {
  libraryItemId: string
  itemId: string
  sampleName: string
  /** See ClipSaveAsSamplePayload.audioType. */
  audioType?: 'simple' | 'music'
}

export interface TransportSeekPayload {
  positionMs: number
}

/**
 * Per-session AUTH handshake — MUST be the first envelope on every socket;
 * the backend closes the socket on any other first message or token mismatch.
 * Token comes from main (SILVERDAW_BRIDGE_TOKEN); see backend/src/BridgeServer.h.
 */
export interface AuthPayload {
  token: string
}

/**
 * Map of outbound envelope `type` → payload type. Payload-less envelopes
 * (TRANSPORT_PLAY etc.) map to `undefined`.
 */
export interface BridgeOutboundMap {
  AUTH: AuthPayload
  CLIP_ADD: ClipAddPayload
  CLIP_MOVE: ClipMovePayload
  CLIP_TRIM: ClipTrimPayload
  CLIP_COLOR: ClipColorPayload
  CLIP_SET_LOCKED: ClipSetLockedPayload
  CLIP_SET_REVERSED: ClipSetReversedPayload
  CLIP_SET_BRAKE: ClipSetBrakePayload
  CLIP_SET_BACKSPIN: ClipSetBackspinPayload
  CLIP_REMOVE: ClipRemovePayload
  LIBRARY_ITEM_RELINK: LibraryItemRelinkPayload
  CLIP_RENAME: ClipRenamePayload
  CLIP_REBIND: ClipRebindPayload
  CLIP_SET_WARP: ClipSetWarpPayload
  CLIP_SAVE_AS_SAMPLE: ClipSaveAsSamplePayload
  CLIP_SLICE_TO_SAMPLES: ClipSliceToSamplesPayload
  LIBRARY_ITEM_SAVE_AS_SAMPLE: LibraryItemSaveAsSamplePayload
  CLIP_EDITOR_PEAKS_REQUEST: ClipEditorPeaksRequestPayload
  LIBRARY_ADD: LibraryAddPayload
  LIBRARY_REMOVE: LibraryRemovePayload
  LIBRARY_DELETE_ARTIFACTS: LibraryDeleteArtifactsPayload
  LIBRARY_REANALYSE: LibraryReanalysePayload
  LIBRARY_ITEM_SET_AUDIO_TYPE: LibraryItemSetAudioTypePayload
  LIBRARY_ITEM_SET_COVER_HIDDEN: LibraryItemSetCoverHiddenPayload
  LIBRARY_ITEM_SET_COVER_OVERRIDE: LibraryItemSetCoverOverridePayload
  LIBRARY_ITEM_SET_MANUAL_TEMPO: LibraryItemSetManualTempoPayload
  TRACK_ADD: TrackAddPayload
  TRACK_REMOVE: TrackRemovePayload
  TRACK_RENAME: TrackRenamePayload
  TRACK_GAIN: TrackGainPayload
  TRACK_MUTE: TrackMutePayload
  TRACK_SOLO: TrackSoloPayload
  TRACK_SET_HEIGHT: TrackSetHeightPayload
  TRACK_REORDER: TrackReorderPayload
  TRACK_SET_SENDS: TrackSetSendsPayload
  TRACK_SET_TONE: TrackSetTonePayload
  TRACK_SET_LEVELER: TrackSetLevelerPayload
  TRACK_SET_PAN: TrackSetPanPayload
  TRACK_SET_AUTOMATION: TrackSetAutomationPayload
  CLIP_SET_ENVELOPE: ClipSetEnvelopePayload
  TRANSITION_CREATE: TransitionCreatePayload
  TRANSITION_DELETE: TransitionDeletePayload
  TRANSITION_SET_RECIPE: TransitionSetRecipePayload
  PROJECT_SET_REVERB: ProjectSetReverbPayload
  PROJECT_SET_DELAY: ProjectSetDelayPayload
  TRANSPORT_PLAY: undefined
  TRANSPORT_PAUSE: undefined
  TRANSPORT_STOP: undefined
  TRANSPORT_SEEK: TransportSeekPayload
  WAVEFORM_REQUEST: WaveformRequestPayload
  PROJECT_NEW: undefined
  PROJECT_SAVE: ProjectSavePayload
  PROJECT_SAVE_AS: ProjectSaveAsPayload
  PROJECT_SAVE_VIEW_STATE: ProjectSaveViewStatePayload
  PROJECT_LOAD: ProjectLoadPayload
  PROJECT_LOAD_RECOVERY: ProjectLoadRecoveryPayload
  PROJECT_AUTOSAVE: ProjectAutosavePayload
  PROJECT_RENAME: ProjectRenamePayload
  PROJECT_SET_VIEW: ProjectSetViewPayload
  PROJECT_SET_BPM: ProjectSetBpmPayload
  PROJECT_SET_LENGTH: ProjectSetLengthPayload
  PROJECT_SET_AUDIO_OUTPUT: ProjectSetAudioOutputPayload
  PROJECT_SET_TARGET_SAMPLE_RATE: ProjectSetTargetSampleRatePayload
  PROJECT_SET_EXPORT_SETTINGS: ProjectSetExportSettingsPayload
  PROJECT_SET_MASTER_VOLUME: ProjectSetMasterVolumePayload
  PROJECT_SET_BAR_COUNTER_START: ProjectSetBarCounterStartPayload
  PROJECT_SET_MIXDOWN_START_BAR: ProjectSetMixdownStartBarPayload
  PROJECT_SET_METRONOME: ProjectSetMetronomePayload
  AUDIO_FILE_PROBE: AudioFileProbePayload
  MIXDOWN_START: MixdownStartPayload
  MIXDOWN_CANCEL: undefined
  STEM_SEPARATE: StemSeparatePayload
  STEM_SEPARATE_CANCEL: StemSeparateCancelPayload
  PROJECT_MARKER_ADD: ProjectMarkerAddPayload
  PROJECT_MARKER_MOVE: ProjectMarkerMovePayload
  PROJECT_MARKER_REMOVE: ProjectMarkerRemovePayload
  PREVIEW_LOAD: PreviewLoadPayload
  PREVIEW_UNLOAD: undefined
  PREVIEW_PLAY: undefined
  PREVIEW_PAUSE: undefined
  PREVIEW_STOP: undefined
  PREVIEW_SEEK: PreviewSeekPayload
  PREVIEW_SET_WARP: PreviewSetWarpPayload
  PREVIEW_SET_ENVELOPE: PreviewSetEnvelopePayload
  PREVIEW_SET_REVERSED: PreviewSetReversedPayload
  PREVIEW_SET_BRAKE: PreviewSetBrakePayload
  PREVIEW_SET_BACKSPIN: PreviewSetBackspinPayload
  AUDIO_DEVICES_REQUEST: AudioDevicesRequestPayload
  AUDIO_DEVICE_SELECT: AudioDeviceSelectPayload
  AUDIO_KEEP_AWAKE_SET: AudioKeepAwakeSetPayload
  BRAKE_SETTINGS_SET: BrakeSettingsSetPayload
  BACKSPIN_SETTINGS_SET: BackspinSettingsSetPayload
  EDIT_UNDO: undefined
  EDIT_REDO: undefined
  EDIT_GROUP_BEGIN: EditGroupBeginPayload
  EDIT_GROUP_END: undefined
  PING: PingPayload
}

/**
 * Idle-watchdog liveness probe. Backend replies PONG { id } on the JUCE message
 * thread, proving the engine thread (not just the socket) is responsive.
 * `id` is a rising nonce so the renderer can ignore stale replies.
 */
export interface PingPayload {
  id: number
}

export interface WaveformRequestPayload {
  clipId: string
}

/** Save the project; omit `filePath` to use the loaded path. First save needs PROJECT_SAVE_AS. */
export interface ProjectSavePayload {
  filePath?: string
  /** Latest horizontal scroll position from the renderer, flushed before save. */
  viewScrollX?: number
  /** Latest horizontal zoom (px/sec) from the renderer, flushed before save. */
  viewPxPerSecond?: number
}

export interface ProjectSaveAsPayload {
  filePath: string
  /** Latest horizontal scroll position from the renderer, flushed before save. */
  viewScrollX?: number
  /** Latest horizontal zoom (px/sec) from the renderer, flushed before save. */
  viewPxPerSecond?: number
}

export interface ProjectSaveViewStatePayload {
  filePath: string
  viewScrollX: number
  /** Latest horizontal zoom (px/sec); omit to leave the saved value untouched. */
  viewPxPerSecond?: number
}

export interface ProjectLoadPayload {
  filePath: string
}

/**
 * Recover a project from an autosave. Unlike PROJECT_LOAD, the backend seeds the
 * current path to `originalPath` (empty when null) and leaves isDirty=true: with an
 * originalPath, Save overwrites it; without one, Save falls through to Save As.
 */
export interface ProjectLoadRecoveryPayload {
  /** Path to the autosave `.silverdaw` file inside `%APPDATA%/Silverdaw/autosave/<projectId>/`. */
  autosavePath: string
  /** Original project path the autosave came from, or null if untitled. */
  originalPath: string | null
}

/** Background autosave write; backend serialises the ValueTree to `filePath` without
 *  touching the current path or dirty flag. Playhead and scroll are captured. */
export interface ProjectAutosavePayload {
  filePath: string
  /** Horizontal scroll captured into the snapshot; omit to leave the saved value untouched. */
  viewScrollX?: number
  /** Horizontal zoom (px/sec) captured into the snapshot; omit to leave the saved value untouched. */
  viewPxPerSecond?: number
}

/** Persist horizontal zoom and/or scroll. Both optional; backend stores them without marking dirty. */
export interface ProjectSetViewPayload {
  pxPerSecond?: number
  scrollX?: number
  /** Selected track id, or null to clear. Persisted as non-dirty view state. */
  selectedTrackId?: string | null
  /** Bottom panel shows Track FX. Persisted as non-dirty view state. */
  fxPanelOpen?: boolean
}

/** Tempo edit. Marks the project dirty on the backend. */
export interface ProjectSetBpmPayload {
  bpm: number
}

/** Project-length edit (ms). Marks the project dirty on the backend. */
export interface ProjectSetLengthPayload {
  lengthMs: number
}

/**
 * Per-project preferred output device; null/null clears it (global preferences.json wins).
 * Saved on the project file; the live device is switched separately via AUDIO_DEVICE_SELECT.
 */
export interface ProjectSetAudioOutputPayload {
  typeName: string | null
  deviceName: string | null
}

/**
 * Target sample rate (Hz) driving playback caches so the audio thread never resamples
 * per-clip. Only 44100/48000 accepted; higher rates are capped at 48000 on import.
 */
export interface ProjectSetTargetSampleRatePayload {
  sampleRate: number
}

/**
 * Persists the last-used export-dialog settings (opaque renderer-owned JSON; empty clears).
 * Backend stores it verbatim, rejects payloads > 64 KB, and round-trips via `.silverdaw` save/load.
 */
export interface ProjectSetExportSettingsPayload {
  json: string
}

/**
 * Master output volume (linear, clamped [0,1]). Backend applies it block-ramped to the live
 * mix bus and to the export render. Round-tripped via PROJECT_STATE; absent when at unity.
 */
export interface ProjectSetMasterVolumePayload {
  gain: number
}

/**
 * Ruler bar-label offset. 0 (default) labels the first bar "1"; -1 labels it "0" so a
 * lead-in bar can sit before bar one. Persisted with the project; undoable on the backend.
 */
export interface ProjectSetBarCounterStartPayload {
  barCounterStart: number
}

/**
 * Displayed bar marker a mixdown begins from (independent of the bar-counter offset).
 * 0 (default) starts at the project origin. Persisted with the project; undoable.
 */
export interface ProjectSetMixdownStartBarPayload {
  mixdownStartBar: number
}

/**
 * Toggle the monitoring metronome click (an audible tick in time with the project BPM).
 * Default off. Persisted with the project but applied SILENTLY on the backend — it never marks the
 * project dirty and is not undoable.
 */
export interface ProjectSetMetronomePayload {
  enabled: boolean
}

/**
 * File-rate probe used by import to detect sample-rate mismatches before adding a file.
 * Backend reads rate/channels/duration from the header and acks via AUDIO_FILE_PROBED.
 * `requestId` is renderer-allocated so concurrent probes don't collide.
 */
export interface AudioFileProbePayload {
  requestId: string
  filePath: string
}

/**
 * Start an offline mixdown render. Backend renders all clips (trim/warp/pitch/gain) into one
 * stereo file; the live transport is parked and TRANSPORT_PLAY rejected for the duration.
 * `lengthMode`: 'trim-to-last-clip' truncates at the latest-ending clip; 'fixed-duration'
 * honours `lengthMs` exactly (truncating or padding with silence).
 */
export interface MixdownStartPayload {
  outputPath: string
  sampleRate: 44100 | 48000
  format: 'wav' | 'mp3' | 'flac' | 'aiff'
  /** Output bit-depth (default 16). wav: 16/24/32f; flac/aiff: 16/24; mp3: ignored. */
  bitDepth?: 16 | 24 | 32
  /** TPDF dither before integer quantisation; only affects 16-bit output. Default true. */
  dither?: boolean
  /** Extra silence-tail after the timeline (s), range [0,60]. Default 0. */
  tailSeconds?: number
  /** BS.1770-4 loudness. 'off' = no analysis; 'analyze' = measure LUFS+true-peak (reported on
   *  MIXDOWN_DONE); 'normalize' = two-pass gain to `targetLufs`, capped at `ceilingDbtp - 0.2 dB`.
   *  `targetLufs` required for 'normalize'; fields clamped to [-30,-6] and [-9,0]. */
  loudness?: {
    mode: 'off' | 'analyze' | 'normalize'
    targetLufs?: number
    ceilingDbtp?: number
  }
  /** MP3 only: target bitrate in kbps. Ignored for WAV / FLAC / AIFF. */
  bitrateKbps?: 128 | 192 | 320
  lengthMode: 'trim-to-last-clip' | 'fixed-duration'
  /** Required when `lengthMode === 'fixed-duration'`. Ignored otherwise. */
  lengthMs?: number
  /** Project-time offset (ms) to begin rendering from. Earlier audio is rendered then
   *  discarded so clip positions and FX tails stay correct. Default 0 (project origin). */
  startMs?: number
  /** Optional file-level tags; backend maps them per-format (ID3 / RIFF INFO / VORBIS_COMMENT / AIFF chunks). */
  metadata?: {
    title?: string
    artist?: string
    album?: string
    year?: string
    genre?: string
    comment?: string
  }
}

/** Cancel an in-progress mixdown; backend deletes the partial file and emits MIXDOWN_FAILED{cancelled}. */
export type MixdownCancelPayload = undefined

/**
 * Separate a source's audio into the chosen stems (any of vocals/drums/bass/other) with the
 * htdemucs-ft ONNX model. Non-destructive: stems are written to disk and imported as new library
 * items; the source is untouched. `sourceItemId` is the resolved top-level source library item
 * to separate. When `clipId` is present (timeline separation), each stem is placed on a new track
 * aligned to that clip; when absent (library-source separation), stems are imported to the library
 * only. `modelDir` is the resolved model directory (renderer obtains it from main via IPC after
 * ensuring the weights are downloaded). Backend streams STEM_PROGRESS then STEM_READY / STEM_FAILED,
 * correlated by `jobId`.
 */
/** Quality preset trading separation speed against seam smoothness. Maps to the
 *  backend inference window overlap (fast = less overlap/faster). */
export type StemQuality = 'fast' | 'balanced' | 'best'

/** How hard an optional post-separation stem cleanup leans on the stem. Maps to
 *  the backend enhancers (high-pass corner + downward-expander amount). */
export type StemEnhanceStrength = 'light' | 'medium' | 'strong'
/** Vocal-cleanup intensity (alias of {@link StemEnhanceStrength}). */
export type VocalEnhanceStrength = StemEnhanceStrength
/** Drum-cleanup intensity (alias of {@link StemEnhanceStrength}). */
export type DrumEnhanceStrength = StemEnhanceStrength
/** Bass-cleanup intensity (alias of {@link StemEnhanceStrength}). */
export type BassEnhanceStrength = StemEnhanceStrength
/** Other/residual-cleanup intensity (alias of {@link StemEnhanceStrength}). */
export type OtherEnhanceStrength = StemEnhanceStrength

export interface StemSeparatePayload {
  jobId: string
  /** Resolved top-level source library item to separate. */
  sourceItemId: string
  /** Source clip for timeline placement; omit for library-source separation. */
  clipId?: string
  modelDir: string
  /**
   * Optional Mel-Band RoFormer ("Vocal Quality Pack") core `.onnx` path. When
   * present (the pack is installed and the user enabled it), the backend
   * produces the VOCALS stem with this higher-quality model instead of the
   * htdemucs vocal specialist; drums/bass still come from htdemucs and `other`
   * stays the residual. Resolved by main from the pack's install directory.
   */
  roformerModelPath?: string
  /**
   * Optional 4-stem BS-RoFormer ("Rhythm Quality Pack") core `.onnx` path. When
   * present (the pack is installed and the user enabled it), the backend
   * produces the DRUMS and BASS stems with this higher-quality model (one run,
   * both extracted) instead of the htdemucs drums/bass specialists; vocals and
   * `other` are unaffected. Resolved by main from the pack's install directory.
   */
  rhythmModelPath?: string
  /** Friendly source name used for the stem WAV filenames and track names. */
  sourceName: string
  /** Stems the user chose to extract (non-empty). */
  stems: StemName[]
  /** Quality preset; backend defaults to 'balanced' when omitted. */
  quality: StemQuality
  /**
   * Run inference on the GPU when the backend was built with a hardware-
   * accelerated ONNX Runtime; the backend falls back to the CPU automatically
   * when no accelerated engine is present. Resolved from the persisted
   * `stems.useGpu` preference, gated by GPU detection.
   */
  useGpu: boolean
  /**
   * Apply post-separation cleanup to the VOCALS stem only (sub-bass high-pass +
   * gentle downward expander to tame inter-phrase bleed). Off by default;
   * resolved from the persisted `stems.enhanceVocals` preference. Other stems
   * are always written untouched.
   */
  enhanceVocals?: boolean
  /** Cleanup intensity; backend defaults to 'medium' when omitted. */
  vocalEnhanceStrength?: VocalEnhanceStrength
  /**
   * Apply post-separation cleanup to the DRUMS stem only (subsonic high-pass +
   * percentile-anchored downward expander that tames inter-hit bleed and
   * self-bypasses on dense/continuous material). Off by default; resolved from
   * the persisted `stems.enhanceDrums` preference. Other stems are always
   * written untouched.
   */
  enhanceDrums?: boolean
  /** Drum-cleanup intensity; backend defaults to 'medium' when omitted. */
  drumEnhanceStrength?: DrumEnhanceStrength
  /**
   * Apply post-separation cleanup to the BASS stem only (subsonic high-pass +
   * low-passed-detector downward expander that tames high-frequency bleed in the
   * gaps between notes and self-bypasses on sustained material). Off by default;
   * resolved from the persisted `stems.enhanceBass` preference. Other stems are
   * always written untouched.
   */
  enhanceBass?: boolean
  /** Bass-cleanup intensity; backend defaults to 'medium' when omitted. */
  bassEnhanceStrength?: BassEnhanceStrength
  /**
   * Apply post-separation cleanup to the OTHER/residual stem only (subsonic
   * high-pass + a shallow STFT spectral cleanup that eases the low-level
   * musical-noise and bleed the separation leaves behind while protecting
   * sustained instruments, and self-bypasses when the change would be
   * inaudible). Off by default; resolved from the persisted `stems.enhanceOther`
   * preference. Other stems are always written untouched.
   */
  enhanceOther?: boolean
  /** Other-cleanup intensity; backend defaults to 'medium' when omitted. */
  otherEnhanceStrength?: OtherEnhanceStrength
}
export interface StemSeparateCancelPayload {
  jobId: string
}

/** Add a timeline marker at an absolute project position in milliseconds. */
export interface ProjectMarkerAddPayload {
  markerId: string
  positionMs: number
}

/** Move an existing timeline marker to a new absolute project position. */
export interface ProjectMarkerMovePayload {
  markerId: string
  positionMs: number
}

/** Remove an existing timeline marker. */
export interface ProjectMarkerRemovePayload {
  markerId: string
}

/** Start a preview voice, optionally windowed (`inMs`/`durationMs` rel. to source; 0 = to end).
 *  Initial warp is applied atomically before PREVIEW_STATE so the first Play can't run un-warped. */
export interface PreviewLoadPayload extends PreviewSetWarpPayload {
  libraryItemId: string
  inMs?: number
  durationMs?: number
}

/** Seek within the preview window; `positionMs` is relative to the window start (0..durationMs). */
export interface PreviewSeekPayload {
  positionMs: number
}

/** Configure warp on the preview voice; mirrors ClipSetWarpPayload (partial-update, tempoRatio:null clears the pin). */
export interface PreviewSetWarpPayload {
  warpEnabled?: boolean
  warpMode?: ClipWarpMode
  tempoRatio?: number | null
  semitones?: number
  cents?: number
}

/** Configure the preview voice's volume envelope; `points` post-warp ms + linear gain (empty clears). No ack. */
export interface PreviewSetEnvelopePayload {
  points: ClipEnvelopePoint[]
}

/** Toggle the preview voice's non-destructive reverse playback. No ack. */
export interface PreviewSetReversedPayload {
  reversed: boolean
}

/** Apply a turntable brake to the preview voice; `on` toggles it. No ack. */
export interface PreviewSetBrakePayload {
  on: boolean
}

/** Apply a turntable backspin to the preview voice; `on` toggles it. No ack. */
export interface PreviewSetBackspinPayload {
  on: boolean
}

/**
 * Switch the audio output device. Both fields null = revert to system default; otherwise
 * both `typeName` and `deviceName` are required (JUCE resolves device names within their type).
 * Backend acks AUDIO_DEVICE_CHANGED and, on success, broadcasts a fresh AUDIO_DEVICES_LIST.
 */
export interface AudioDeviceSelectPayload {
  typeName: string | null
  deviceName: string | null
}

/** Ask the backend to rescan available devices (on explicit refresh or a detected plug/unplug). */
export interface AudioDevicesRequestPayload {
  /** True = rescan every type before responding (ASIO scans ~10ms); omit to resend the cached snapshot. */
  refresh?: boolean
}

/**
 * Enable or disable the output keep-awake for the current device (the inaudible dither +
 * first-play wake burst that holds a sleep-prone USB DAC awake). A per-device on/off toggle,
 * off by default; the renderer resolves the open device's setting and pushes it here.
 */
export interface AudioKeepAwakeSetPayload {
  enabled: boolean
}

/** Global default parameters for the turntable-brake effect, pushed from the app
 *  preference. `seconds` is the platter stop time; `curve` is the rate-curve power
 *  (1 = linear/constant deceleration, higher = more curved). Applied to new brakes,
 *  to all currently-braked clips, and to mixdown export. No ack. */
export interface BrakeSettingsSetPayload {
  seconds: number
  curve: number
}

/** Global default parameters for the turntable-backspin effect, pushed from the app
 *  preference. `seconds` is the spin duration; `speed` is the peak reverse rate (x
 *  normal speed); `curve` is the momentum-decay power. Applied to new backspins, to
 *  all currently-spun clips, and to mixdown export. No ack. */
export interface BackspinSettingsSetPayload {
  seconds: number
  speed: number
  curve: number
}

/**
 * Open an explicit undo group. Every undoable mutation sent before the matching `EDIT_GROUP_END`
 * folds into ONE backend UndoManager transaction, so a compound action (split, duplicate, paste, a
 * clip-editor save that touches every linked clip, …) is a single Undo step. Groups nest.
 * `label` names the transaction for the Undo/Redo menu (e.g. "Split clip").
 */
export interface EditGroupBeginPayload {
  label: string
}

export type BridgeOutboundType = keyof BridgeOutboundMap

/** Whether a given outbound type carries a payload, derived from the map so it
 *  cannot drift from the catalogue. */
export type BridgeOutboundPayloadKind<K extends BridgeOutboundType> =
  BridgeOutboundMap[K] extends undefined ? 'none' : 'payload'

/**
 * Runtime registry of every outbound type to whether it carries a payload.
 *
 * The mapped-type annotation makes this exhaustive and self-correcting: adding a
 * type to `BridgeOutboundMap`, or marking the wrong payload kind, fails the
 * build until this entry matches. It is the runtime counterpart of the
 * compile-time map, used by `validateOutboundEnvelope` to guard the send
 * boundary without a hand-maintained parallel list.
 */
export const bridgeOutboundPayloadKinds: {
  readonly [K in BridgeOutboundType]: BridgeOutboundPayloadKind<K>
} = {
  AUTH: 'payload',
  CLIP_ADD: 'payload',
  CLIP_MOVE: 'payload',
  CLIP_TRIM: 'payload',
  CLIP_COLOR: 'payload',
  CLIP_SET_LOCKED: 'payload',
  CLIP_SET_REVERSED: 'payload',
  CLIP_SET_BRAKE: 'payload',
  CLIP_SET_BACKSPIN: 'payload',
  CLIP_REMOVE: 'payload',
  LIBRARY_ITEM_RELINK: 'payload',
  CLIP_RENAME: 'payload',
  CLIP_REBIND: 'payload',
  CLIP_SET_WARP: 'payload',
  CLIP_SAVE_AS_SAMPLE: 'payload',
  CLIP_SLICE_TO_SAMPLES: 'payload',
  LIBRARY_ITEM_SAVE_AS_SAMPLE: 'payload',
  CLIP_EDITOR_PEAKS_REQUEST: 'payload',
  LIBRARY_ADD: 'payload',
  LIBRARY_REMOVE: 'payload',
  LIBRARY_DELETE_ARTIFACTS: 'payload',
  LIBRARY_REANALYSE: 'payload',
  LIBRARY_ITEM_SET_AUDIO_TYPE: 'payload',
  LIBRARY_ITEM_SET_COVER_HIDDEN: 'payload',
  LIBRARY_ITEM_SET_COVER_OVERRIDE: 'payload',
  LIBRARY_ITEM_SET_MANUAL_TEMPO: 'payload',
  TRACK_ADD: 'payload',
  TRACK_REMOVE: 'payload',
  TRACK_RENAME: 'payload',
  TRACK_GAIN: 'payload',
  TRACK_MUTE: 'payload',
  TRACK_SOLO: 'payload',
  TRACK_SET_HEIGHT: 'payload',
  TRACK_REORDER: 'payload',
  TRACK_SET_SENDS: 'payload',
  TRACK_SET_TONE: 'payload',
  TRACK_SET_LEVELER: 'payload',
  TRACK_SET_PAN: 'payload',
  TRACK_SET_AUTOMATION: 'payload',
  CLIP_SET_ENVELOPE: 'payload',
  TRANSITION_CREATE: 'payload',
  TRANSITION_DELETE: 'payload',
  TRANSITION_SET_RECIPE: 'payload',
  PROJECT_SET_REVERB: 'payload',
  PROJECT_SET_DELAY: 'payload',
  TRANSPORT_PLAY: 'none',
  TRANSPORT_PAUSE: 'none',
  TRANSPORT_STOP: 'none',
  TRANSPORT_SEEK: 'payload',
  WAVEFORM_REQUEST: 'payload',
  PROJECT_NEW: 'none',
  PROJECT_SAVE: 'payload',
  PROJECT_SAVE_AS: 'payload',
  PROJECT_SAVE_VIEW_STATE: 'payload',
  PROJECT_LOAD: 'payload',
  PROJECT_LOAD_RECOVERY: 'payload',
  PROJECT_AUTOSAVE: 'payload',
  PROJECT_RENAME: 'payload',
  PROJECT_SET_VIEW: 'payload',
  PROJECT_SET_BPM: 'payload',
  PROJECT_SET_LENGTH: 'payload',
  PROJECT_SET_AUDIO_OUTPUT: 'payload',
  PROJECT_SET_TARGET_SAMPLE_RATE: 'payload',
  PROJECT_SET_EXPORT_SETTINGS: 'payload',
  PROJECT_SET_MASTER_VOLUME: 'payload',
  PROJECT_SET_BAR_COUNTER_START: 'payload',
  PROJECT_SET_MIXDOWN_START_BAR: 'payload',
  PROJECT_SET_METRONOME: 'payload',
  AUDIO_FILE_PROBE: 'payload',
  MIXDOWN_START: 'payload',
  MIXDOWN_CANCEL: 'none',
  STEM_SEPARATE: 'payload',
  STEM_SEPARATE_CANCEL: 'payload',
  PROJECT_MARKER_ADD: 'payload',
  PROJECT_MARKER_MOVE: 'payload',
  PROJECT_MARKER_REMOVE: 'payload',
  PREVIEW_LOAD: 'payload',
  PREVIEW_UNLOAD: 'none',
  PREVIEW_PLAY: 'none',
  PREVIEW_PAUSE: 'none',
  PREVIEW_STOP: 'none',
  PREVIEW_SEEK: 'payload',
  PREVIEW_SET_WARP: 'payload',
  PREVIEW_SET_ENVELOPE: 'payload',
  PREVIEW_SET_REVERSED: 'payload',
  PREVIEW_SET_BRAKE: 'payload',
  PREVIEW_SET_BACKSPIN: 'payload',
  AUDIO_DEVICES_REQUEST: 'payload',
  AUDIO_DEVICE_SELECT: 'payload',
  AUDIO_KEEP_AWAKE_SET: 'payload',
  BRAKE_SETTINGS_SET: 'payload',
  BACKSPIN_SETTINGS_SET: 'payload',
  EDIT_UNDO: 'none',
  EDIT_REDO: 'none',
  EDIT_GROUP_BEGIN: 'payload',
  EDIT_GROUP_END: 'none',
  PING: 'payload'
}

/** Narrow an unknown value to a known outbound type. */
export function isBridgeOutboundType(value: unknown): value is BridgeOutboundType {
  return typeof value === 'string' && value in bridgeOutboundPayloadKinds
}

/** Tuple args for the typed `send()` helper: `send('TRANSPORT_PLAY')` or `send('CLIP_ADD', {...})`. */
export type BridgeOutboundArgs<K extends BridgeOutboundType> =
  BridgeOutboundMap[K] extends undefined ? [type: K] : [type: K, payload: BridgeOutboundMap[K]]

export interface ProjectRenamePayload {
  name: string
}

/** Outbound envelope, discriminated on `type` (used when serialising). */
export type BridgeOutboundMessage = {
  [K in BridgeOutboundType]: BridgeOutboundMap[K] extends undefined
    ? { type: K }
    : { type: K; payload: BridgeOutboundMap[K] }
}[BridgeOutboundType]
