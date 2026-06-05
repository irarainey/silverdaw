// Renderer -> Backend (outbound) wire-protocol payloads.
//
// Part of the bridge protocol catalogue. Pure TypeScript declarations: every
// outbound envelope payload, the `BridgeOutboundMap` type->payload index, and
// the derived `send()` helper types. Re-exported through the stable
// `@shared/bridge-protocol` facade. See that module for the protocol overview.
//
// FILE-SIZE EXCEPTION (justified): this is a single cohesive catalogue of one
// wire direction (pure interfaces, no runtime logic). Splitting it by message
// domain would fragment a flat list whose own `BridgeOutboundMap` already acts
// as the index, adding file-hopping cost without a maintainability win.

// A couple of outbound payloads reference shared protocol vocabulary whose
// canonical (zod-derived) definition lives with the inbound schemas. These are
// type-only imports — outbound carries no runtime dependency on inbound.
import type { LibraryItemKind, TransitionRecipe } from './inbound'

// ─── Renderer → Backend (outbound) ──────────────────────────────────────────

export interface ClipAddPayload {
  trackId: string
  clipId: string
  /** Source library item the clip plays from. Clips reference their
   *  audio via the library — they never carry a filesystem path. */
  libraryItemId: string
  positionMs: number
  /** Optional trim window: where in the source file to start reading.
   *  Used by split / duplicate to mint clips that share the underlying
   *  audio with the original. Omit (or send 0) for a whole-file clip. */
  inMs?: number
  /** Optional trim window: how long this clip plays for, starting at
   *  `inMs` inside the source file. Omit (or send 0) to play to the
   *  natural end of the source. */
  durationMs?: number
  /** Optional 0..15 palette index. Omit to inherit the host track's
   *  colour. Used by duplicate / split so the copy carries the
   *  original's per-clip colour. */
  colorIndex?: number
}

export interface ClipMovePayload {
  clipId: string
  positionMs: number
  /** Optional cross-track move — when present and different from the
   *  clip's current host track, the backend re-parents the clip's
   *  ValueTree node under this track. The audio engine doesn't care
   *  about tracks (each clip is its own playable source) so there's no
   *  AudioEngine call; only ProjectState changes. */
  trackId?: string
  /** True on drag release. Lets the backend reset read-ahead before
   *  the next Play press instead of doing it synchronously on Play. */
  commit?: boolean
}

/** Atomic three-field trim update. Sent by edge-drag trim (and split,
 *  for the original clip). All three fields are required because a
 *  partial update would briefly let the audio thread observe an
 *  inconsistent `(start, in, duration)` triple. */
export interface ClipTrimPayload {
  clipId: string
  startMs: number
  inMs: number
  durationMs: number
}

/** Update a clip's per-clip colour override. A negative value clears
 *  the override so the clip re-inherits its track's palette colour. */
export interface ClipColorPayload {
  clipId: string
  colorIndex: number
}

/** Toggle a clip's lock flag. When `locked: true` the timeline UI
 *  prevents moving and trimming the clip; double-click to open in
 *  the editor still works. Lock is per-clip — locking one instance
 *  of a saved-clip does NOT propagate to siblings. Backend stores
 *  the flag on the clip's ValueTree (absent==unlocked). */
export interface ClipSetLockedPayload {
  clipId: string
  locked: boolean
}

/** Remove a clip from its track. The backend tears down the clip's
 *  audio source and drops it from the project ValueTree; the renderer
 *  optimistically removes it from the store on send. */
export interface ClipRemovePayload {
  clipId: string
}

/** Relink a library item to a new source file. All clips that
 *  reference the item pick up the new file automatically; the user
 *  doesn't need to relink each clip individually. */
export interface LibraryItemRelinkPayload {
  itemId: string
  filePath: string
}

/** User-facing display-name override for a single clip. Empty string
 *  clears the override and the clip falls back to its library item /
 *  filename for display. Used by the inline rename on the timeline,
 *  and propagated to saved-clip library items if the clip is saved. */
export interface ClipRenamePayload {
  clipId: string
  name: string
}

/** Change a timeline clip's parent library item. Used by "Save clip
 *  to library", which promotes a clip's trim window to a reusable
 *  saved-clip entry — the originating timeline clip is then rebound
 *  to point at the new saved-clip so the project file records the
 *  correct parent relationship. */
export interface ClipRebindPayload {
  clipId: string
  libraryItemId: string
}

/** Ask the backend to compute high-resolution peaks for the given
 *  library item's source file at `peaksPerSecond` (typically much
 *  higher than the default 500). Used by the Clip Editor when the
 *  user zooms in past the point where the default peaks resolution
 *  blocks out into chunky rectangles. Backend caches the result on
 *  disk so subsequent dialog opens for the same source are instant. */
export interface ClipEditorPeaksRequestPayload {
  libraryItemId: string
  peaksPerSecond: number
}

/** Register a library item with the backend so its durable fields are
 *  persisted with the project. Volatile renderer-only data such as
 *  waveform peaks and object URLs is rebuilt on demand. */
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
  sourceItemId?: string
  sourceClipId?: string
  sourceInMs?: number
  sourceDurationMs?: number
  /** Source-group disclosure state. True when the user has collapsed
   *  the source's saved-clip list in the library panel. */
  collapsed?: boolean
  /** Saved-clip default warp settings — only meaningful when
   *  `kind === 'saved-clip'`. Copied onto a fresh timeline clip when
   *  the saved-clip tile is dragged in (copy-on-drop, not live link). */
  warpEnabled?: boolean
  warpMode?: ClipWarpMode
  tempoRatio?: number
  semitones?: number
  cents?: number
}

/** Drop a library item from the persisted catalogue. */
export interface LibraryRemovePayload {
  itemId: string
}

/** Force a full analysis refresh for a library item. The backend
 *  recreates its decoded-WAV cache and reruns BPM/beat detection; the
 *  renderer supplies the freshly redetected key and decoded source details. */
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

/** Set the user-override classification on a library item.
 *  `'sample'` / `'music'` are persistent overrides; `'auto'` clears
 *  the override so the renderer falls back to the backend's
 *  `lowConfidence` flag. */
export interface LibraryItemSetSampleModePayload {
  itemId: string
  mode: 'sample' | 'music' | 'auto'
}

export interface TrackAddPayload {
  trackId: string
  /** Initial display name for new tracks. Optional for older clients. */
  name?: string
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
  /** User volume (slider position) — linear gain, 0..~1.9953 (+6 dB
   *  ceiling), NOT post-mute / post-solo effective gain. The backend
   *  derives the audible gain from this plus the track's persisted
   *  muted / soloed flags. */
  gain: number
}

/** Toggle a track's mute flag. Persists with the project; the backend
 *  derives the effective audible gain (`gain × audible(...)`) and pushes
 *  it to the AudioEngine. Mute state is mirrored back on PROJECT_STATE
 *  and via `TRACK_MUTE_APPLIED`. */
export interface TrackMutePayload {
  trackId: string
  muted: boolean
}

/** Toggle a track's solo flag. Solo affects audibility of every other
 *  track, so the backend re-pushes effective gain for the whole
 *  project. */
export interface TrackSoloPayload {
  trackId: string
  soloed: boolean
}

/**
 * Persist a per-track row height. Sent once on `pointerup` after a
 * resize-handle drag in TrackHeaderPanel; the backend stores it on the
 * Track ValueTree (so it round-trips through save/load and joins the
 * undo history) and echoes the new value via a fresh `PROJECT_STATE`.
 * Coalesced 60Hz drag motion is kept renderer-local via
 * `projectStore.setTrackHeightLocal` so the bridge only sees the
 * committed value.
 */
export interface TrackSetHeightPayload {
  trackId: string
  /** Row height in CSS pixels. The backend clamps to a project-wide
   *  min/max so a hostile payload can't make rows invisible or
   *  push every sibling off-screen. */
  heightPx: number
}

/**
 * Reorder a track within the project. Sent once on drop after the user
 * drags a track header to a new position. `newIndex` is the desired
 * 0-based position in the track list; the backend clamps it to the
 * current track count and emits a fresh PROJECT_STATE reflecting the
 * new order. Joins the undo history as a single "Reorder track" step.
 */
export interface TrackReorderPayload {
  trackId: string
  newIndex: number
}

/**
 * Rubber Band time-stretch + pitch-shift mode for a clip.
 *
 *   - `'rhythmic'` — R2 / Faster, optimised for drums and percussive
 *     material. Default for auto-warp because it's the lightest mode
 *     and most general-purpose; user can escalate per-clip.
 *   - `'tonal'`    — R2 with formant-preservation friendly options;
 *     better for melodic / vocal material.
 *   - `'complex'`  — R3 / Finer, highest quality, highest CPU cost.
 *     Reserved for export and for clips the user has explicitly
 *     escalated via the Warp settings dialog.
 */
export type ClipWarpMode = 'rhythmic' | 'tonal' | 'complex'

/**
 * Per-clip warp + pitch-shift settings. Sent as a partial-update from
 * the renderer — every field is optional and only the fields present in
 * a single envelope are mutated on the backend. The handler skips
 * properties that aren't included so the renderer can drive a single
 * field (e.g. just `semitones`) without having to echo the rest.
 *
 * Semantics of the numeric fields:
 *   - `tempoRatio` is `projectBpm / sourceBpm` — i.e. "how many times
 *     faster than its native rate this clip should play". `2.0` plays
 *     at double speed; `0.5` plays at half speed; `1.0` is no
 *     stretching. When `tempoRatio` is **absent** the backend derives
 *     it live from the active project BPM and the library item's
 *     detected BPM (so the clip follows project BPM changes); when
 *     **present** it's a pinned override that survives BPM changes.
 *   - `semitones` ranges ±12; `cents` ±100. Combined pitch scale is
 *     `2^((semitones + cents/100) / 12)`. Pitch is independent of
 *     tempo — changing one does not affect the other.
 *
 * The backend treats this envelope as undoable and collision-checks
 * any change that would alter the effective timeline duration of the
 * clip against neighbouring clips on the same track.
 */
export interface ClipSetWarpPayload {
  clipId: string
  warpEnabled?: boolean
  warpMode?: ClipWarpMode
  tempoRatio?: number | null
  semitones?: number
  cents?: number
  /**
   * Renderer-bookkeeping flag — when `true` the backend records that
   * this clip is waiting on `LIBRARY_ITEM_ANALYSIS` to deliver a
   * source BPM before warp can actually engage. Cleared automatically
   * by any subsequent `CLIP_SET_WARP` (including the analysis-time
   * auto-flip) and by an undoable manual edit, so a user who opts out
   * of warp before analysis arrives isn't second-guessed afterwards.
   */
  pendingAutoWarp?: boolean
}

export interface ClipSaveAsSamplePayload {
  clipId: string
  itemId: string
  sampleName: string
  outputDir: string
}

// ─── Phase 5 effects envelopes (Bass / Mid / Treble / Leveler / Sends / shared FX) ──
//
// All Phase 5 mutation envelopes optionally carry `gestureId` + `gestureEnd`
// so the backend can coalesce a drag stream (knob turn, slider drag) into
// one undo step regardless of event rate. When `gestureId` is absent the
// backend falls back to the existing 500 ms time window. `gestureEnd === true`
// is included in the same coalesced transaction and clears the coalesce
// state so the NEXT gesture opens fresh.
//
// The handlers persist into the ProjectState ValueTree and ack with a
// dedicated `*_APPLIED` envelope (NOT a full `PROJECT_STATE`) so 60 Hz
// fader streams stay cheap on the wire. Real DSP is wired by the per-
// feature todos that follow this schema-foundation step.

/** Optional drag-coalesce hints. Shared by every Phase 5 mutation envelope. */
export interface GestureHints {
  /** Stable per-drag identifier. The renderer mints one at pointerdown
   *  and re-uses it for every coalesced sample until pointerup. When
   *  present, the backend coalesces on `(messageType, targetId,
   *  gestureId)` regardless of elapsed time. */
  gestureId?: string
  /** Marks the LAST event in a drag gesture. The mutation still applies
   *  inside the same coalesced transaction; afterwards the backend
   *  clears the coalesce state so the next gesture starts a fresh
   *  undo step. */
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

/** Per-track equal-power pan. Signed `[-1, 1]` (`-1` = hard left, `0` =
 *  centre, `+1` = hard right). Default 0 (centre). */
export interface TrackSetPanPayload extends GestureHints {
  trackId: string
  pan: number
}

/**
 * Per-track Tone — fixed 3-band shelving EQ + low-cut + high-cut. All gain
 * fields are dB in `[-15, +15]`; `lowCut` engages a fixed high-pass and
 * `highCut` a fixed low-pass when true. Every field is optional so the
 * renderer can drive one knob without echoing the rest — the backend
 * fills missing values from the current persisted state.
 */
export interface TrackSetTonePayload extends GestureHints {
  trackId: string
  bassDb?: number
  midDb?: number
  trebleDb?: number
  lowCut?: boolean
  highCut?: boolean
}

/**
 * Per-track Leveler — single user-facing "amount" knob in `[0, 1]`.
 * Compressor DSP and Advanced controls land in a later todo; for now
 * this is pure persistence + ack.
 */
export interface TrackSetLevelerPayload extends GestureHints {
  trackId: string
  amount: number
}

/** One breakpoint on a clip volume envelope. */
export interface ClipEnvelopePoint {
  /** Clip-local post-warp ms in `[0, clipDuration]`. */
  timeMs: number
  /** Linear gain in `[0, 4]` (~`-∞ .. +12 dB`). `1.0` is unity. */
  gain: number
}

/**
 * Per-clip volume envelope — one atomic mutation per drag. The backend
 * normalises (sorts ascending by `timeMs`, clamps, rejects duplicate
 * times). An empty array clears the envelope entirely (property
 * removed so legacy projects round-trip byte-equivalent).
 */
export interface ClipSetEnvelopePayload extends GestureHints {
  clipId: string
  points: ClipEnvelopePoint[]
}

// ─── Clip transitions (§12.1) ───────────────────────────────────────────────
//
// Transition mutations are discrete user actions (not 60 Hz drag streams), so
// each one is a single undoable backend transaction that mutates BOTH partner
// clips' derived edge-fade atomically and re-publishes the authoritative
// `PROJECT_STATE`. That re-publish is also how backend-side reconciliation
// (auto-deleting invalidated transitions) reaches the renderer — there is no
// bespoke `*_APPLIED` ack. `TransitionRecipe` is imported from the
// project-state block above so the wire payload can never drift from the guard.

/**
 * Create a transition over the sanctioned overlap of two adjacent clips on
 * `trackId`. `leftClipId` is the earlier (fade-out) clip, `rightClipId` the
 * later (fade-in) clip. The backend validates adjacency / single-neighbour
 * overlap and rejects the request (no state change) if the invariants don't
 * hold. `recipe` defaults to the equal-power `smooth` crossfade when omitted.
 */
export interface TransitionCreatePayload {
  trackId: string
  leftClipId: string
  rightClipId: string
  recipe?: TransitionRecipe
}

/** Delete a transition by id. The partner clips keep their independent
 *  volume envelopes — only the derived edge-fade is removed. */
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

/**
 * Project-shared Reverb bus parameters. All scalars are `[0, 1]`
 * linear; every field is optional so the renderer can drive one knob
 * without echoing the others.
 */
export interface ProjectSetReverbPayload extends GestureHints {
  size?: number
  decay?: number
  tone?: number
  mix?: number
}

/** Legal tempo-locked beat divisions for the shared echo. */
export type DelayNoteValue = '1/4' | '1/8' | '1/8T' | '1/16'

/**
 * Project-shared Delay bus parameters. `noteValue` MUST match
 * one of the legal beat divisions exactly — whitespace / case
 * variants are rejected by the backend (the message is dropped).
 */
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
  outputDir: string
}

export interface TransportSeekPayload {
  positionMs: number
}

/**
 * Per-session AUTH handshake. MUST be the first envelope the renderer
 * sends on every new WebSocket connection — the backend rejects (closes)
 * the socket on any other initial message or on a token mismatch. The
 * token value comes from main via `window.silverdaw.getBridgeToken()`; main
 * passes the same value to the spawned backend through the
 * `SILVERDAW_BRIDGE_TOKEN` env var. See `backend/src/BridgeServer.h` for the
 * server side of the contract.
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
  CLIP_REMOVE: ClipRemovePayload
  LIBRARY_ITEM_RELINK: LibraryItemRelinkPayload
  CLIP_RENAME: ClipRenamePayload
  CLIP_REBIND: ClipRebindPayload
  CLIP_SET_WARP: ClipSetWarpPayload
  CLIP_SAVE_AS_SAMPLE: ClipSaveAsSamplePayload
  LIBRARY_ITEM_SAVE_AS_SAMPLE: LibraryItemSaveAsSamplePayload
  CLIP_EDITOR_PEAKS_REQUEST: ClipEditorPeaksRequestPayload
  LIBRARY_ADD: LibraryAddPayload
  LIBRARY_REMOVE: LibraryRemovePayload
  LIBRARY_REANALYSE: LibraryReanalysePayload
  LIBRARY_ITEM_SET_SAMPLE_MODE: LibraryItemSetSampleModePayload
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
  AUDIO_FILE_PROBE: AudioFileProbePayload
  MIXDOWN_START: MixdownStartPayload
  MIXDOWN_CANCEL: undefined
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
  AUDIO_DEVICES_REQUEST: AudioDevicesRequestPayload
  AUDIO_DEVICE_SELECT: AudioDeviceSelectPayload
  EDIT_UNDO: undefined
  EDIT_REDO: undefined
  PING: PingPayload
}

/**
 * Liveness probe sent by the renderer's idle watchdog. The backend
 * answers with a matching `PONG { id }` ON the JUCE message thread, so a
 * round-trip proves the engine command thread itself is responsive — not
 * merely that the socket is open. `id` is an opaque monotonically-rising
 * nonce the renderer uses to ignore stale replies.
 */
export interface PingPayload {
  id: number
}

export interface WaveformRequestPayload {
  clipId: string
}

/**
 * Save the project. When `filePath` is omitted (or empty), the backend
 * saves to the currently-loaded project path. The first save of a new
 * project must use `PROJECT_SAVE_AS` to seed that path.
 */
export interface ProjectSavePayload {
  filePath?: string
  /** Latest horizontal scroll position from the renderer, flushed before save. */
  viewScrollX?: number
}

export interface ProjectSaveAsPayload {
  filePath: string
  /** Latest horizontal scroll position from the renderer, flushed before save. */
  viewScrollX?: number
}

export interface ProjectSaveViewStatePayload {
  filePath: string
  viewScrollX: number
}

export interface ProjectLoadPayload {
  filePath: string
}

/**
 * Recover a project from an autosave file. Differs from PROJECT_LOAD in
 * that the backend deliberately seeds the project's "current file path"
 * to `originalPath` (or empty when null) instead of `autosavePath`, and
 * leaves `isDirty` set to `true` so Ctrl+S behaves the way the user
 * expects after a recovery:
 *
 *   - With `originalPath`: the autosave is overlaid on top of the
 *     original; File > Save overwrites the original.
 *   - Without `originalPath` (the project was untitled when it crashed):
 *     File > Save falls through to Save As so the user is forced to
 *     pick a permanent home for their recovered work.
 *
 * The backend rebuilds the engine from the autosave just like
 * PROJECT_LOAD, broadcasts a `reset=true` PROJECT_STATE with the
 * adjusted `filePath`, then broadcasts `PROJECT_DIRTY { dirty: true }`.
 */
export interface ProjectLoadRecoveryPayload {
  /** Path to the autosave `.silverdaw` file inside `%APPDATA%/Silverdaw/autosave/<projectId>/`. */
  autosavePath: string
  /** Original backing project path the autosave came from, or `null`
   *  if the project was untitled. */
  originalPath: string | null
}

/** Background autosave write request from the renderer. The backend
 *  serializes the current ValueTree to `filePath` without touching
 *  `session.currentPath` or the dirty flag — autosave is invisible to
 *  the user-facing project lifecycle. Playhead position IS captured
 *  (the setter is dirty-suppressed), so a recovered autosave reopens at
 *  the right point in time. View-state scroll is also captured when the
 *  renderer supplies it. */
export interface ProjectAutosavePayload {
  filePath: string
  /** Latest horizontal scroll position from the renderer, captured into
   *  the autosave snapshot. Optional — omit for "don't touch the saved
   *  scroll value". */
  viewScrollX?: number
}

/** Push the renderer's current horizontal zoom (in pixels-per-second)
 *  and/or current scroll position to the backend so they can be
 *  persisted as part of the project. Either field is optional — the
 *  scroll-position sender debounces independently from the zoom sender.
 *  The backend stores both values on the project root but does NOT mark
 *  the project dirty — view state is not a meaningful edit. */
export interface ProjectSetViewPayload {
  pxPerSecond?: number
  scrollX?: number
  /** Id of the selected track, or `null` to clear. Persisted view state
   *  (non-dirty) so reopening restores the Track FX panel's target. */
  selectedTrackId?: string | null
  /** Whether the bottom panel shows the Track FX view. Persisted view
   *  state (non-dirty). */
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
 * Per-project preferred audio output device. `null` / `null` clears the
 * project's preference so the user's global `preferences.json` device
 * becomes the effective choice on next load. Saved on the project file
 * itself; the live `juce::AudioDeviceManager` is updated separately via
 * `AUDIO_DEVICE_SELECT` so the renderer can choose whether to push the
 * live switch (Project Properties dialog: yes; PROJECT_STATE
 * reconciliation on load: yes, but without touching `preferences.json`).
 */
export interface ProjectSetAudioOutputPayload {
  typeName: string | null
  deviceName: string | null
}

/**
 * Per-project target sample rate (Hz). Drives the project's playback
 * caches: every clip's audio is converted to this rate so the audio
 * engine doesn't have to resample on the audio thread for every clip
 * individually. Only 44 100 and 48 000 Hz are accepted today; higher
 * rates are silently capped at 48 000 on the import path.
 */
export interface ProjectSetTargetSampleRatePayload {
  sampleRate: number
}

/**
 * Persists the last-used export-dialog settings on the project root.
 * `json` is an opaque renderer-owned string (schema: `{ version: 1, … }`);
 * pass an empty string to clear. Backend stores it verbatim, rejects
 * payloads larger than 64 KB, and round-trips it via `.silverdaw` save/load.
 */
export interface ProjectSetExportSettingsPayload {
  json: string
}

/**
 * Master output volume (linear, clamped to [0, 1]). Backend applies it
 * to the live mix bus via `juce::AudioSourcePlayer::setGain` (block-rate
 * ramped; safe during playback) and to the export render so the file
 * matches what the user hears. Round-tripped through the PROJECT_STATE
 * snapshot; absent from the snapshot when at unity.
 */
export interface ProjectSetMasterVolumePayload {
  gain: number
}

/**
 * Synchronous-ish file-rate probe used by the import flow to detect
 * sample-rate mismatches before adding a file to the library. The
 * backend opens the file via its `AudioFormatManager`, reads the
 * sample rate / channel count / duration from the file's header, and
 * acks via `AUDIO_FILE_PROBED`. `requestId` is renderer-allocated so
 * concurrent probes don't collide.
 */
export interface AudioFileProbePayload {
  requestId: string
  filePath: string
}

/**
 * Start an offline mixdown render. The backend renders every track's
 * clips (honouring trim window, warp, pitch and track gain) into a
 * single stereo file at the requested sample rate and format. The
 * live transport is forced to pause-and-park before the render begins
 * and `TRANSPORT_PLAY` is rejected for the duration so audio playback
 * can't audibly interleave with the offline render.
 *
 * `lengthMode = 'trim-to-last-clip'` truncates the output at the end
 * of the latest-ending clip (using each clip's effective timeline
 * duration). `lengthMode = 'fixed-duration'` honours `lengthMs`
 * exactly — clips that extend past that point are truncated mid-clip,
 * clips that end before are padded with silence.
 *
 * The format-specific tail (`bitrateKbps`) is ignored
 * when `format` is `'wav'` or `'flac'`. `bitDepth` is ignored when
 * `format` is `'mp3'`. `metadata` applies to all three formats
 * (mapped to ID3 for MP3, RIFF INFO for WAV, VORBIS_COMMENT for FLAC).
 */
export interface MixdownStartPayload {
  outputPath: string
  sampleRate: 44100 | 48000
  format: 'wav' | 'mp3' | 'flac' | 'aiff'
  /** Output bit-depth.
   *  - `'wav'`: 16 / 24 (PCM) or 32 (IEEE float).
   *  - `'flac'`: 16 / 24.
   *  - `'aiff'`: 16 / 24.
   *  - `'mp3'`: ignored.
   *  Defaults to 16 if omitted. */
  bitDepth?: 16 | 24 | 32
  /** Apply TPDF dither immediately before integer quantisation.
   *  Only meaningful when the target container is 16-bit integer
   *  (WAV-16 / FLAC-16). Ignored for 24-bit (noise floor below
   *  audibility) and 32-float (no quantisation step). Default
   *  `true`. */
  dither?: boolean
  /** Extra silence-tail appended after the timeline, in seconds.
   *  Range [0, 60]. Independent of, and additive on top of, any
   *  per-clip processor tail (e.g. reverb decay). Defaults to 0. */
  tailSeconds?: number
  /** ITU-R BS.1770-4 loudness measurement and / or two-pass
   *  normalization. Only valid when `sampleRate` is 44100 or 48000.
   *  Optional — when absent the export runs in `off` mode and the
   *  output matches the existing un-analyzed pipeline byte-for-byte.
   *
   *  - `off`        no analysis, no gain, no metering.
   *  - `analyze`    single-pass render measures integrated LUFS +
   *                 true-peak; reports them on `MIXDOWN_DONE.loudness`.
   *                 Output bytes are identical to `off`.
   *  - `normalize`  two-pass render: pass 1 measures the program +
   *                 writes a 32-float intermediate; pass 2 applies
   *                 the linear gain needed to hit `targetLufs`,
   *                 backed off if necessary so the post-gain true
   *                 peak doesn't exceed `ceilingDbtp - 0.2 dB`.
   *
   *  `targetLufs` is required when `mode === 'normalize'`. Both
   *  numeric fields are clamped to [-30, -6] and [-9, 0] respectively. */
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
  /** File-level tags written into the output container.
   *  All fields are optional; absent / empty fields aren't written.
   *  Mapped per-format by the backend:
 *    - MP3  → ID3v2 frames (TIT2 / TPE1 / TALB / TYER / TCON / COMM).
 *    - WAV  → RIFF INFO chunk (INAM / IART / IPRD / ICRD / IGNR / ICMT).
 *    - FLAC → VORBIS_COMMENT block (TITLE / ARTIST / ALBUM / DATE / GENRE / COMMENT).
 *    - AIFF → NAME / AUTH / (c) / ANNO text chunks (year + genre folded into ANNO). */
  metadata?: {
    title?: string
    artist?: string
    album?: string
    year?: string
    genre?: string
    comment?: string
  }
}

/** Request cancellation of an in-progress mixdown render. The backend
 *  finalises (deletes the partial temp file) and emits
 *  `MIXDOWN_FAILED { code: 'cancelled' }`. No-op if no render is
 *  active. */
export type MixdownCancelPayload = undefined

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

/** Start a preview voice on a library item, optionally windowed to a
 *  selection. `inMs` and `durationMs` are in milliseconds relative to the
 *  source file; `durationMs = 0` (or omitted) plays from `inMs` to the
 *  end of the source. Initial warp fields are applied atomically before
 *  the backend broadcasts `PREVIEW_STATE`, so the first Play press cannot
 *  briefly run at the source tempo. */
export interface PreviewLoadPayload extends PreviewSetWarpPayload {
  libraryItemId: string
  inMs?: number
  durationMs?: number
}

/** Seek within the currently loaded preview window. `positionMs` is
 *  relative to the window start (0..durationMs). */
export interface PreviewSeekPayload {
  positionMs: number
}

/**
 * Configure the warp engine on the currently-loaded preview voice.
 * Mirrors `ClipSetWarpPayload` exactly — partial-update, every field
 * optional, `tempoRatio: null` clears the pin. Used by the Clip
 * Editor to keep the preview audio in sync with the saved-clip's
 * warp defaults (so what the user previews matches what the
 * timeline will play once the clip is dragged in).
 */
export interface PreviewSetWarpPayload {
  warpEnabled?: boolean
  warpMode?: ClipWarpMode
  tempoRatio?: number | null
  semitones?: number
  cents?: number
}

/**
 * Configure the volume shape (gain envelope) on the currently-loaded
 * preview voice. `points` are clip-local post-warp milliseconds + linear
 * gain (same units as `ClipSetEnvelopePayload`); an empty array clears
 * the envelope. Sent live by the Clip Editor while the user edits the
 * volume-shape curve — the backend installs a compiled snapshot onto the
 * preview's `OffsetSource` atomically so the next audio block already
 * reflects it. No ack: matches `PREVIEW_SET_WARP`.
 */
export interface PreviewSetEnvelopePayload {
  points: ClipEnvelopePoint[]
}

/**
 * Switch the audio output device. Both fields null = "revert to system
 * default" (the backend re-runs JUCE's default-device init). Otherwise
 * both `typeName` (e.g. "Windows Audio") and `deviceName` (e.g.
 * "Speakers (Realtek HD Audio)") must be supplied — JUCE's
 * `AudioDeviceManager::setAudioDeviceSetup` resolves device names
 * within their type, so picking a device from one type without
 * switching to that type first won't take effect.
 *
 * The backend acks with `AUDIO_DEVICE_CHANGED { ok, error? }` and, on
 * success, broadcasts a fresh `AUDIO_DEVICES_LIST` so every connected
 * client sees the new current selection.
 */
export interface AudioDeviceSelectPayload {
  typeName: string | null
  deviceName: string | null
}

/** Force the backend to rescan every device type's available devices.
 *  Renderer fires this when the user explicitly clicks a "refresh"
 *  button or right after a plug / unplug it noticed elsewhere. */
export interface AudioDevicesRequestPayload {
  /** When true, the backend calls `scanForDevices()` on every type
   *  before responding. Cheap-but-not-free on Windows (ASIO scans
   *  can take ~10ms); omit for a "just resend the cached snapshot". */
  refresh?: boolean
}

export type BridgeOutboundType = keyof BridgeOutboundMap

/**
 * Tuple-encoded argument list for the typed `send()` helper. Lets callers
 * write `send('TRANSPORT_PLAY')` for payload-less envelopes and
 * `send('CLIP_ADD', { ... })` for the rest, with full inference.
 */
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
