// Bridge wire-protocol catalogue.
//
// Single source of truth for every JSON envelope crossing the WebSocket bridge
// between the renderer and the JUCE backend. Both directions are catalogued
// as discriminated unions so the renderer can exhaustively dispatch inbound
// messages and the type checker can prove every `send()` carries the right
// payload shape.
//
// Wire format (matches `backend/src/BridgeServer.cpp::broadcast` and
// `backend/src/BridgeServer.cpp::onIncoming`):
//
//     { "type": "<UPPER_SNAKE_CASE>", "payload": { ... } | undefined }
//
// ─── Port contract ──────────────────────────────────────────────────────────
// The bridge listens on `ws://127.0.0.1:<port>`. There is exactly one source
// of truth for `<port>`:
//
//   1. Electron **main** probes for a free loopback port at startup
//      (`findFreeBridgePort` in `frontend/src/main/index.ts`).
//   2. Main spawns the JUCE backend with `--port <N>`. The backend has no
//      default and refuses to start without `--port` — a missing `--port`
//      is always a configuration bug (see
//      `backend/src/Main.cpp::resolveBridgePort`).
//   3. Main exposes the same value to the renderer via the `bridge:getPort`
//      IPC. The renderer fetches it in `lib/bridgeService.ts::resolveBridgeConnection`
//      and dials `ws://127.0.0.1:<that>` from there.
//
// If you change the port-resolution rule on either end, update both sides
// AND this comment so the three processes stay in lockstep.
//
// ─── AUTH contract ──────────────────────────────────────────────────────────
// The first envelope a client sends MUST be `AUTH` with the per-session
// token from main (via `bridge:getToken` IPC + `SILVERDAW_BRIDGE_TOKEN`
// env var to the backend). Pre-AUTH socket activity is closed without
// reply. See `backend/src/BridgeServer.cpp::onIncomingFromClient`.

import { z } from 'zod'

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

// ─── Backend → Renderer (inbound) ───────────────────────────────────────────
//
// Inbound payloads are defined as `zod` schemas. The exported TypeScript
// types are derived via `z.infer<...>` so the schema is the single source
// of truth — there is no separate hand-written interface to drift away
// from the runtime guard. Each guard at the bottom of the file is a
// thin `safeParse(...).success` wrapper over the matching schema.

/** Discriminator for the per-clip warp processor mode. Mirrors the
 *  outbound `ClipWarpMode` union; defined here as its own schema so the
 *  inbound shapes don't import the outbound type alias. */
const clipWarpModeSchema = z.enum(['rhythmic', 'tonal', 'complex'])

export const ReadyPayloadSchema = z.object({
  version: z.string()
})
export type ReadyPayload = z.infer<typeof ReadyPayloadSchema>

export const PlayheadUpdatePayloadSchema = z.object({
  positionMs: z.number(),
  isPlaying: z.boolean()
})
export type PlayheadUpdatePayload = z.infer<typeof PlayheadUpdatePayloadSchema>

export const ClipAckPayloadSchema = z.object({
  trackId: z.string(),
  clipId: z.string(),
  libraryItemId: z.string(),
  ok: z.boolean(),
  /**
   * Backend-supplied error message. Present iff `ok === false`.
   * Surfaced through `notificationsStore.pushError(...)` in the renderer.
   */
  error: z.string().optional()
})
export type ClipAckPayload = z.infer<typeof ClipAckPayloadSchema>

/**
 * Backend ack for a prior `TRACK_ADD` envelope. `ok === false` means the
 * track id was unknown OR the payload was malformed; rare in practice
 * because the renderer generates the trackId locally and addTrack on
 * the backend is idempotent.
 */
export const TrackAddedPayloadSchema = z.object({
  trackId: z.string(),
  ok: z.boolean()
})
export type TrackAddedPayload = z.infer<typeof TrackAddedPayloadSchema>

/**
 * Backend ack for a prior `TRACK_REMOVE` envelope. `ok === false` means the
 * track id was unknown on the backend (i.e. the renderer's view drifted out
 * of sync). The renderer has already optimistically removed the row, so a
 * negative ack is logged but otherwise non-fatal.
 */
export const TrackRemovedPayloadSchema = z.object({
  trackId: z.string(),
  ok: z.boolean()
})
export type TrackRemovedPayload = z.infer<typeof TrackRemovedPayloadSchema>

/** Backend ack for `CLIP_REMOVE`. `ok=false` means the clip id was
 *  unknown to the project tree. The renderer logs but doesn't re-add
 *  the clip — local optimistic removal already happened. */
export const ClipRemovedPayloadSchema = z.object({
  clipId: z.string(),
  ok: z.boolean()
})
export type ClipRemovedPayload = z.infer<typeof ClipRemovedPayloadSchema>

/**
 * Backend ack for a prior `TRACK_GAIN` envelope, echoing the gain value
 * actually applied (clamped or quantised on the backend if needed) so the
 * renderer can verify the engine state matches local expectations. `ok ===
 * false` means the track id was unknown — gain mismatches are logged as a
 * warning, not surfaced to the user.
 */
export const TrackGainAppliedPayloadSchema = z.object({
  trackId: z.string(),
  /** Linear gain actually applied on the backend. */
  gain: z.number(),
  ok: z.boolean()
})
export type TrackGainAppliedPayload = z.infer<typeof TrackGainAppliedPayloadSchema>

/** Ack for `TRACK_MUTE` — echoes the muted flag the backend persisted. */
export const TrackMuteAppliedPayloadSchema = z.object({
  trackId: z.string(),
  muted: z.boolean(),
  ok: z.boolean()
})
export type TrackMuteAppliedPayload = z.infer<typeof TrackMuteAppliedPayloadSchema>

/** Ack for `TRACK_SOLO` — echoes the soloed flag the backend persisted. */
export const TrackSoloAppliedPayloadSchema = z.object({
  trackId: z.string(),
  soloed: z.boolean(),
  ok: z.boolean()
})
export type TrackSoloAppliedPayload = z.infer<typeof TrackSoloAppliedPayloadSchema>

/**
 * Ack for `TRACK_SET_SENDS` — echoes the clamped send levels the backend
 * persisted. `ok === false` means the track id was unknown.
 *
 * Mirrors the delta-ack pattern used by `TRACK_GAIN_APPLIED` so 60 Hz
 * fader streams don't trigger full `PROJECT_STATE` serialisations. The
 * renderer reconciles its mirror against this payload directly.
 */
export const TrackSendsAppliedPayloadSchema = z.object({
  trackId: z.string(),
  /** Project-Reverb send, 0..1 linear, after backend clamp. */
  reverbSend: z.number(),
  /** Project-Delay send, 0..1 linear, after backend clamp. */
  delaySend: z.number(),
  ok: z.boolean()
})
export type TrackSendsAppliedPayload = z.infer<typeof TrackSendsAppliedPayloadSchema>

/** Ack for `TRACK_SET_TONE`. Echoes the full Tone state after the
 *  backend has merged the partial update with the stored values, so
 *  the renderer doesn't have to track which fields it sent. */
export const TrackToneAppliedPayloadSchema = z.object({
  trackId: z.string(),
  bassDb: z.number(),
  midDb: z.number(),
  trebleDb: z.number(),
  lowCut: z.boolean(),
  highCut: z.boolean(),
  ok: z.boolean()
})
export type TrackToneAppliedPayload = z.infer<typeof TrackToneAppliedPayloadSchema>

/** Ack for `TRACK_SET_LEVELER` — echoes the clamped amount. */
export const TrackLevelerAppliedPayloadSchema = z.object({
  trackId: z.string(),
  amount: z.number(),
  ok: z.boolean()
})
export type TrackLevelerAppliedPayload = z.infer<typeof TrackLevelerAppliedPayloadSchema>

/** Ack for `TRACK_SET_PAN` — echoes the clamped signed pan in `[-1, 1]`.
 *  `ok === false` means the track id was unknown. Mirrors the delta-ack
 *  pattern used by `TRACK_SENDS_APPLIED` so 60 Hz pan drags don't trigger
 *  full `PROJECT_STATE` serialisations. */
export const TrackPanAppliedPayloadSchema = z.object({
  trackId: z.string(),
  pan: z.number(),
  ok: z.boolean()
})
export type TrackPanAppliedPayload = z.infer<typeof TrackPanAppliedPayloadSchema>

const ClipEnvelopePointSchema = z.object({
  timeMs: z.number().nonnegative(),
  gain: z.number().min(0).max(4)
})
export type ClipEnvelopePointAck = z.infer<typeof ClipEnvelopePointSchema>

/** Ack for `CLIP_SET_ENVELOPE` — echoes the persisted (sorted, clamped)
 *  point array. An empty array indicates the envelope is cleared. */
export const ClipEnvelopeAppliedPayloadSchema = z.object({
  clipId: z.string(),
  points: z.array(ClipEnvelopePointSchema),
  ok: z.boolean()
})
export type ClipEnvelopeAppliedPayload = z.infer<typeof ClipEnvelopeAppliedPayloadSchema>

/** Ack for `PROJECT_SET_REVERB` — echoes the full clamped reverb state. */
export const ProjectReverbAppliedPayloadSchema = z.object({
  size: z.number().min(0).max(1),
  decay: z.number().min(0).max(1),
  tone: z.number().min(0).max(1),
  mix: z.number().min(0).max(1),
  ok: z.boolean()
})
export type ProjectReverbAppliedPayload = z.infer<typeof ProjectReverbAppliedPayloadSchema>

/** Ack for `PROJECT_SET_DELAY` — echoes the full clamped delay state. */
export const ProjectDelayAppliedPayloadSchema = z.object({
  noteValue: z.enum(['1/4', '1/8', '1/8T', '1/16']),
  feedback: z.number().min(0).max(1),
  tone: z.number().min(0).max(1),
  mix: z.number().min(0).max(1),
  ok: z.boolean()
})
export type ProjectDelayAppliedPayload = z.infer<typeof ProjectDelayAppliedPayloadSchema>

export const ProjectViewStateSavedPayloadSchema = z.object({
  filePath: z.string(),
  ok: z.boolean(),
  error: z.string().optional()
})
export type ProjectViewStateSavedPayload = z.infer<typeof ProjectViewStateSavedPayloadSchema>

/** Ack for `PROJECT_AUTOSAVE`. Carries no `PROJECT_STATE` or
 *  `PROJECT_DIRTY` follow-up: autosave is deliberately invisible to the
 *  user-facing project lifecycle. */
export const ProjectAutosavedPayloadSchema = z.object({
  filePath: z.string(),
  ok: z.boolean(),
  error: z.string().optional()
})
export type ProjectAutosavedPayload = z.infer<typeof ProjectAutosavedPayloadSchema>

/**
 * Initial backend-authoritative project snapshot sent by the bridge
 * immediately after a successful AUTH handshake. The renderer treats
 * itself as a mirror of this state — see `projectStore.applyProjectStateSnapshot`.
 *
 * Tracks and clips contain only the structural / audio-meaningful fields
 * the backend owns. Render-only metadata (fileName, peaks, sampleRate,
 * channelCount) stays with the renderer's existing optimistic state; on
 * reconnect any clips known only to the backend will appear in the
 * payload but won't render until backend-supplied peaks arrive (Phase 1
 * todo: backend-waveform-data).
 */
export const ProjectStateClipSchema = z.object({
  id: z.string(),
  /** Library item this clip plays from. Source-of-truth for the
   *  underlying audio file; the renderer resolves filePath / fileName /
   *  peaks through the library. */
  libraryItemId: z.string(),
  offsetMs: z.number(),
  /** Backend-authoritative timeline/output duration after warp. */
  effectiveDurationMs: z.number().optional(),
  /** Backend-authoritative tempo ratio used for timing. */
  effectiveTempoRatio: z.number().optional(),
  /** True when tempo warp changes the timeline/output duration. */
  effectiveWarpActive: z.boolean().optional(),
  durationMs: z.number(),
  /** Where in the source file this clip starts reading (trim offset).
   *  Optional: omitted on un-trimmed clips; the renderer falls back to 0. */
  inMs: z.number().optional(),
  /** Per-clip palette index override (0..15). Absent means the clip
   *  inherits the host track's colour. */
  colorIndex: z.number().optional(),
  /** Per-clip lock flag. When true, the timeline UI suppresses move
   *  and trim gestures. Absent/false = unlocked. Per-clip — not
   *  propagated across linked saved-clip siblings. */
  locked: z.boolean().optional(),
  /** User-facing display name override (set via inline rename on the
   *  timeline). Absent means use the library item title / filename. */
  name: z.string().optional(),
  /** True when the library item's source file no longer exists on
   *  disk. Renderer renders the clip greyed-out and surfaces a
   *  "Locate files…" toast; engine playback skips it. */
  unresolved: z.boolean().optional(),
  /** Per-clip warp + pitch settings. All five fields are optional and
   *  default to the no-warp identity (`warpEnabled=false`,
   *  `tempoRatio=1`, `semitones=0`, `cents=0`). Omitted on clips that
   *  have never had warp touched so older project files round-trip
   *  unchanged. See `ClipSetWarpPayload` for the semantics of each
   *  field. */
  warpEnabled: z.boolean().optional(),
  warpMode: clipWarpModeSchema.optional(),
  tempoRatio: z.number().optional(),
  semitones: z.number().optional(),
  cents: z.number().optional(),
  /** Renderer-bookkeeping flag: clip was dropped before its source
   *  BPM was detected. Cleared by the backend's `LIBRARY_ITEM_ANALYSIS`
   *  handler when it auto-flips warp on, or by any explicit
   *  `CLIP_SET_WARP` from the user. */
  pendingAutoWarp: z.boolean().optional(),
  // ─── Phase 5 per-clip volume tailoring. Stored flat on the CLIP node
  //     to match ValueTree storage. `envelopePoints` is a `juce::var`
  //     ARRAY property; an empty array (or absent property) means the
  //     envelope is unused.
  /** Volume-envelope breakpoints. Stored sorted ascending by `timeMs`. */
  envelopePoints: z
    .array(
      z.object({
        timeMs: z.number().nonnegative(),
        gain: z.number().min(0).max(4)
      })
    )
    .optional()
})
export type ProjectStateClip = z.infer<typeof ProjectStateClipSchema>

export const ProjectStateTrackSchema = z.object({
  id: z.string(),
  /** Persisted user-facing track name. Optional for projects saved before this field existed. */
  name: z.string().optional(),
  gain: z.number(),
  /** Persisted muted / soloed flags. Both default to false and are
   *  only present in the JSON when true. Round-trip through save /
   *  load so the user's mute / solo state is restored on reopen. */
  muted: z.boolean().optional(),
  soloed: z.boolean().optional(),
  /** Persisted row height in CSS pixels. Optional for projects saved
   *  before per-track height existed (and for tracks that have never
   *  been resized — the renderer falls back to its default). */
  heightPx: z.number().optional(),
  // ─── Phase 5 per-track FX (all flat to match the backend ValueTree
  //     property layout — ValueTreeJson serialises every property at the
  //     top level of the TRACK node, no nested objects). Each is
  //     suppressed-when-default so legacy projects round-trip unchanged.
  /** Send to the project Reverb bus, 0..1 linear. */
  sendReverb: z.number().optional(),
  /** Send to the project Delay bus, 0..1 linear. */
  sendDelay: z.number().optional(),
  /** Per-track Tone — fixed 3-band EQ, dB in `[-15, +15]`. */
  toneBassDb: z.number().optional(),
  toneMidDb: z.number().optional(),
  toneTrebleDb: z.number().optional(),
  /** Per-track fixed high-pass low-cut filter engage flag. */
  toneLowCut: z.boolean().optional(),
  /** Per-track fixed low-pass high-cut filter engage flag. */
  toneHighCut: z.boolean().optional(),
  /** Per-track Leveler amount, 0..1 (Advanced controls land later). */
  levelerAmount: z.number().optional(),
  /** Per-track equal-power pan, signed `[-1, 1]` (0 = centre). */
  pan: z.number().optional(),
  clips: z.array(ProjectStateClipSchema)
})
export type ProjectStateTrack = z.infer<typeof ProjectStateTrackSchema>

export const ProjectStateMarkerSchema = z.object({
  id: z.string(),
  positionMs: z.number()
})
export type ProjectStateMarker = z.infer<typeof ProjectStateMarkerSchema>

export type LibraryItemKind = 'audio-file' | 'saved-clip'
const libraryItemKindSchema = z.enum(['audio-file', 'saved-clip'])

export const ProjectStateLibraryItemSchema = z
  .object({
    id: z.string(),
    filePath: z.string(),
    /** Library item kind. Older projects omit this and are treated as whole audio files. */
    kind: libraryItemKindSchema.optional(),
    /** User-facing name. Saved clips use this for their reusable clip name. */
    name: z.string().optional(),
    /** Display file name captured when the item entered the library. */
    fileName: z.string().optional(),
    /** Source duration in milliseconds. Optional for older saved projects. */
    durationMs: z.number().optional(),
    /** Source sample rate. Optional for older saved projects. */
    sampleRate: z.number().optional(),
    /** Source channel count. Optional for older saved projects. */
    channelCount: z.number().optional(),
    /** Detected musical key, e.g. `C minor`. Optional when detection is inconclusive. */
    key: z.string().optional(),
    /** Detected BPM (rounded to 2 d.p. on disk). Absent until the
     *  backend's BPM detection job finishes for this file. */
    bpm: z.number().optional(),
    /** Detected beat positions in seconds from the start of the source
     *  file. Absent for items without BPM detection results yet. */
    beats: z.array(z.number()).optional(),
    /** Regression-derived "ideal beat 0" anchor (seconds; can be
     *  negative). Used with `bpm` to lay out the synthesised marker
     *  grid robustly against per-beat jitter. */
    beatAnchorSec: z.number().optional(),
    /** Cache path the backend has decoded this source into. Future
     *  clips of this file should use this path so the audio engine
     *  reads cheap PCM instead of decoding the original. */
    playbackFilePath: z.string().optional(),
    /** True when BTrack's running tempo estimate fluctuated by more than
     *  ~2 % over the analysis window — the project-BPM seeder skips
     *  these and the library tile shows a "variable" badge. */
    variableTempo: z.boolean().optional(),
    /** Backend's auto-classification hint persisted into the library
     *  ValueTree. Mirrors the field on `LIBRARY_ITEM_ANALYSIS`. */
    lowConfidence: z.boolean().optional(),
    /** User's explicit classification override for the library item.
     *  `'sample'` forces non-musical treatment (hide BPM/key/beats,
     *  skip auto-warp on drop), `'music'` forces musical treatment.
     *  Absent means "auto" — fall back to `lowConfidence`. */
    sampleMode: z.enum(['sample', 'music']).optional(),
    /** Parent source library item for saved clips. */
    sourceItemId: z.string().optional(),
    /** Timeline clip that originally produced this saved clip, when known. */
    sourceClipId: z.string().optional(),
    /** Start of the saved clip window inside the source file. */
    sourceInMs: z.number().optional(),
    /** Duration of the saved clip window inside the source file. */
    sourceDurationMs: z.number().optional(),
    /** Source-group disclosure state. True when the user has collapsed
     *  the source's saved-clip list in the library panel. */
    collapsed: z.boolean().optional(),
    unresolved: z.boolean().optional(),
    /** **Saved-clip default warp settings.** Copied onto a fresh timeline
     *  clip when the saved-clip tile is dragged in (copy-on-drop, not
     *  live link — changing these later does NOT propagate to existing
     *  timeline instances). Only meaningful when `kind === 'saved-clip'`;
     *  ignored on audio-file items. See `ClipSetWarpPayload` for field
     *  semantics. */
    warpEnabled: z.boolean().optional(),
    warpMode: clipWarpModeSchema.optional(),
    tempoRatio: z.number().optional(),
    semitones: z.number().optional(),
    cents: z.number().optional()
  })
  // Saved-clip items must carry their window pointers. The original
  // hand-written guard enforced this via an extra branch; `superRefine`
  // expresses it at runtime without complicating the inferred type
  // (the renderer treats the window fields as optional on the type
  // because audio-file items legitimately omit them).
  .superRefine((item, ctx) => {
    if (item.kind === 'saved-clip') {
      if (typeof item.sourceInMs !== 'number') {
        ctx.addIssue({ code: 'custom', path: ['sourceInMs'], message: 'required when kind === saved-clip' })
      }
      if (typeof item.sourceDurationMs !== 'number') {
        ctx.addIssue({ code: 'custom', path: ['sourceDurationMs'], message: 'required when kind === saved-clip' })
      }
    }
  })
export type ProjectStateLibraryItem = z.infer<typeof ProjectStateLibraryItemSchema>

export const ProjectStatePayloadSchema = z.object({
  /** Absolute path to the current `.silverdaw` file, or `null` for an unsaved project. */
  filePath: z.string().nullable(),
  /** User-facing project name. `Untitled` for a freshly-created project. */
  name: z.string(),
  /**
   * Renderer hint — when true, wipe optimistic local state (tracks, clips,
   * library, selection, transport) before applying this snapshot. Sent on
   * `PROJECT_LOAD` and `PROJECT_NEW`; absent / false on the connect path
   * where the renderer treats the snapshot as additive (see
   * `projectStore.applyProjectStateSnapshot`).
   */
  reset: z.boolean().optional(),
  /**
   * Authoritative-reconcile hint used by Undo/Redo: replace tracks /
   * clips / library / markers wholesale (so things that disappeared
   * actually disappear) but do NOT mark the project clean, rotate the
   * `projectId`, or clear clipboard / selection. The dirty state is
   * communicated separately by the backend via `PROJECT_DIRTY` and the
   * undo / redo handler explicitly resends it after the snapshot.
   */
  softReplace: z.boolean().optional(),
  /**
   * Horizontal zoom level (px-per-second) persisted with the project.
   * Optional: omitted on a snapshot for a project that hasn't yet set a
   * zoom (the renderer keeps its current zoom in that case).
   */
  viewPxPerSecond: z.number().optional(),
  /** Horizontal scroll position (px) persisted with the project. */
  viewScrollX: z.number().optional(),
  /** Id of the selected track persisted with the project (empty string =
   *  none). Restores the timeline selection + Track FX panel target. */
  viewSelectedTrack: z.string().optional(),
  /** Whether the bottom panel shows the Track FX view, persisted with the
   *  project. */
  viewFxPanelOpen: z.boolean().optional(),
  /** Last playhead position (ms) persisted with the project. */
  playheadMs: z.number().optional(),
  /** Project tempo (BPM) persisted with the project. */
  bpm: z.number().optional(),
  /** User-set project length (ms) persisted with the project. */
  projectLengthMs: z.number().optional(),
  /**
   * Per-project preferred audio output device. Both fields are
   * optional and nullable. `null` / absent means "no project-level
   * preference"; the renderer's load-time reconcile then leaves the
   * live device on whatever the user-scope `preferences.json` selected
   * at backend startup.
   */
  audioOutputTypeName: z.string().nullable().optional(),
  audioOutputDeviceName: z.string().nullable().optional(),
  /**
   * Per-project target sample rate (Hz). Drives the playback-cache
   * rebuild so every clip's audio is at this rate on disk. Today
   * only 44 100 and 48 000 are accepted; absent means "fall back to
   * the user-scope `audio.defaultProjectSampleRate` preference, then
   * 44 100".
   */
  targetSampleRate: z.number().optional(),
  /**
   * Opaque JSON blob persisting the last-used export-dialog settings
   * (format, bit depth, tail seconds, loudness preset, file-level
   * tags, …). Renderer owns the schema (`{ version: 1, … }`); the
   * backend just round-trips the string. Absent on fresh projects;
   * empty string clears it.
   */
  exportSettingsJson: z.string().optional().nullable(),
  masterVolume: z.number().min(0).max(1).optional(),
  // ─── Phase 5 project-shared FX bus parameters. All flat on PROJECT.
  //     Each scalar is 0..1 linear and suppressed when at default. The
  //     `delayNoteValue` default is "1/8"; values are restricted to the
  //     tempo-locked beat-division whitelist on both ends of the wire.
  reverbSize: z.number().min(0).max(1).optional(),
  reverbDecay: z.number().min(0).max(1).optional(),
  reverbTone: z.number().min(0).max(1).optional(),
  reverbMix: z.number().min(0).max(1).optional(),
  delayNoteValue: z.enum(['1/4', '1/8', '1/8T', '1/16']).optional(),
  delayFeedback: z.number().min(0).max(1).optional(),
  delayTone: z.number().min(0).max(1).optional(),
  delayMix: z.number().min(0).max(1).optional(),
  /** User-created timeline markers. */
  markers: z.array(ProjectStateMarkerSchema).optional(),
  /**
   * Library catalogue persisted with the project. Each entry is the
   * `(id, filePath)` pair the renderer originally created the item
   * with, plus decoded duration and an optional `unresolved` flag
   * mirroring the clip path — set when the file is no longer on disk.
   * Cover art / ID3 metadata is NOT in here; the renderer re-fetches
   * it on load via the existing `audio:readMetadata` IPC.
   */
  library: z.array(ProjectStateLibraryItemSchema).optional(),
  tracks: z.array(ProjectStateTrackSchema)
})
export type ProjectStatePayload = z.infer<typeof ProjectStatePayloadSchema>

export const ProjectSavedPayloadSchema = z.object({
  filePath: z.string(),
  ok: z.boolean(),
  error: z.string().optional()
})
export type ProjectSavedPayload = z.infer<typeof ProjectSavedPayloadSchema>

export const ProjectLoadFailedPayloadSchema = z.object({
  filePath: z.string(),
  error: z.string()
})
export type ProjectLoadFailedPayload = z.infer<typeof ProjectLoadFailedPayloadSchema>

export interface ProjectRenamePayload {
  name: string
}

export const ProjectRenamedPayloadSchema = z.object({
  name: z.string(),
  ok: z.boolean()
})
export type ProjectRenamedPayload = z.infer<typeof ProjectRenamedPayloadSchema>

/** Backend notification that the project's dirty flag has transitioned. */
export const ProjectDirtyPayloadSchema = z.object({
  dirty: z.boolean()
})
export type ProjectDirtyPayload = z.infer<typeof ProjectDirtyPayloadSchema>

/**
 * Backend notification that a fresh on-disk peaks cache file is ready
 * for `clipId`. The renderer reads the file directly via main's
 * `readPeaksCacheFile` IPC — peaks bytes are NOT streamed over the
 * WebSocket (that approach hit recurring IXWebSocket I/O-loop
 * starvation issues with concurrent peak deliveries). The cache file
 * layout is fixed: a 24-byte header followed by `peakCount * 2`
 * little-endian float32 peak values (`min, max, min, max, …`).
 */
export const WaveformReadyPayloadSchema = z.object({
  clipId: z.string(),
  /** Absolute path of the cache file under `%APPDATA%/Silverdaw/peaks/`. */
  cachePath: z.string(),
  /** Number of (min, max) pairs in the file (NOT bytes, NOT individual floats). */
  peakCount: z.number(),
  peaksPerSecond: z.number(),
  sampleRate: z.number()
})
export type WaveformReadyPayload = z.infer<typeof WaveformReadyPayloadSchema>

/** Backend notification that a Clip Editor high-resolution peaks job
 *  has completed. Same disk-cache layout as `WAVEFORM_READY`, just
 *  keyed against the library item rather than a specific timeline
 *  clip (because every saved-clip sharing this source can reuse the
 *  same peaks file). */
export const ClipEditorPeaksReadyPayloadSchema = z.object({
  libraryItemId: z.string(),
  cachePath: z.string(),
  peakCount: z.number(),
  peaksPerSecond: z.number(),
  sampleRate: z.number()
})
export type ClipEditorPeaksReadyPayload = z.infer<typeof ClipEditorPeaksReadyPayloadSchema>

// SAMPLE_SAVED has two shapes depending on `ok`: a failure ack carries
// only `itemId`/`ok`/`error`, while a success ack carries the full
// baked-sample metadata. Modelling this as a discriminated union both
// captures the runtime invariant AND lets `z.infer` express the
// conditional in TypeScript.
const SampleSavedFailureSchema = z.object({
  clipId: z.string().optional(),
  libraryItemId: z.string().optional(),
  itemId: z.string(),
  ok: z.literal(false),
  error: z.string().optional()
})
const SampleSavedSuccessSchema = z.object({
  clipId: z.string().optional(),
  libraryItemId: z.string().optional(),
  itemId: z.string(),
  ok: z.literal(true),
  filePath: z.string(),
  fileName: z.string(),
  name: z.string(),
  durationMs: z.number(),
  sampleRate: z.number(),
  channelCount: z.number(),
  cachePath: z.string(),
  peakCount: z.number(),
  peaksPerSecond: z.number(),
  error: z.string().optional()
})
export const SampleSavedPayloadSchema = z.discriminatedUnion('ok', [
  SampleSavedSuccessSchema,
  SampleSavedFailureSchema
])
export type SampleSavedPayload = z.infer<typeof SampleSavedPayloadSchema>

/** Backend notification that BPM + beat-position detection has completed
 *  for a library item. `beats` is an array of times (in seconds from
 *  the start of the source file) at which BTrack detected a beat;
 *  `variableTempo` is `true` when the running tempo estimate fluctuated
 *  enough over the analysis window to make a single project-BPM seed
 *  misleading. */
export const LibraryItemAnalysisPayloadSchema = z.object({
  itemId: z.string(),
  bpm: z.number(),
  /** Regression-derived "ideal beat 0" anchor (seconds, may be
   *  negative). Renderer-side beat-marker grid uses this for
   *  phase. */
  beatAnchorSec: z.number(),
  beats: z.array(z.number()),
  variableTempo: z.boolean(),
  /** Backend's auto-classification hint: `true` when the BPM/beat fit
   *  is too loose to plausibly reflect a real groove. Drives the
   *  default sample-vs-music decision in the renderer; the user can
   *  always override via `sampleMode`. */
  lowConfidence: z.boolean().optional(),
  /** Path to the decoded-WAV cache the backend has written for this
   *  source file. Future clip adds should use this path so the
   *  audio engine reads cheap PCM instead of decoding MP3 / WMA on
   *  the read-ahead thread. */
  playbackFilePath: z.string().optional()
})
export type LibraryItemAnalysisPayload = z.infer<typeof LibraryItemAnalysisPayloadSchema>

/** Backend notification that it just seeded the project BPM (e.g. from
 *  the first import on an empty project). The renderer updates its
 *  `projectStore.bpm` mirror without re-broadcasting `PROJECT_SET_BPM`. */
export const ProjectBpmAppliedPayloadSchema = z.object({
  bpm: z.number()
})
export type ProjectBpmAppliedPayload = z.infer<typeof ProjectBpmAppliedPayloadSchema>

/** Backend notification that a clip's warp settings changed
 *  server-side (e.g. late auto-warp once source BPM analysis lands). */
export const ClipWarpAppliedPayloadSchema = z.object({
  clipId: z.string(),
  warpEnabled: z.boolean().optional(),
  warpMode: clipWarpModeSchema.optional(),
  /** `null` clears the pinned override; absent means "no change". */
  tempoRatio: z.number().nullable().optional(),
  semitones: z.number().optional(),
  cents: z.number().optional(),
  pendingAutoWarp: z.boolean().optional(),
  effectiveDurationMs: z.number().optional(),
  effectiveTempoRatio: z.number().optional(),
  effectiveWarpActive: z.boolean().optional()
})
export type ClipWarpAppliedPayload = z.infer<typeof ClipWarpAppliedPayloadSchema>

/** Broadcast on every preview load/play/pause/stop/unload transition. */
export const PreviewStatePayloadSchema = z.object({
  /** Echoed back from the most recent PREVIEW_LOAD; absent on unload. */
  libraryItemId: z.string().optional(),
  isPlaying: z.boolean(),
  isLoaded: z.boolean(),
  durationMs: z.number(),
  /** Monotonic counter. Increments on every load/unload; the renderer
   *  uses it to discard stale state for a preview the user has already
   *  closed. */
  generation: z.number()
})
export type PreviewStatePayload = z.infer<typeof PreviewStatePayloadSchema>

/** Preview-position tick while the preview transport is playing. */
export const PreviewPositionPayloadSchema = z.object({
  positionMs: z.number(),
  isPlaying: z.boolean(),
  generation: z.number()
})
export type PreviewPositionPayload = z.infer<typeof PreviewPositionPayloadSchema>

/** Broadcast when the preview reaches the end of its selection window. */
export const PreviewEndedPayloadSchema = z.object({
  generation: z.number()
})
export type PreviewEndedPayload = z.infer<typeof PreviewEndedPayloadSchema>

/** One device-type group inside `AudioDevicesListPayload`. */
export const AudioDeviceTypeListingSchema = z.object({
  /** Backend-side type name as JUCE reports it ("Windows Audio",
   *  "DirectSound", "ASIO", …). Used as the discriminator when
   *  picking a device with `AUDIO_DEVICE_SELECT`. */
  name: z.string(),
  /** Output device names available under this type. May be empty
   *  (e.g. ASIO type is present but no ASIO drivers installed). */
  devices: z.array(z.string())
})
export type AudioDeviceTypeListing = z.infer<typeof AudioDeviceTypeListingSchema>

/**
 * Snapshot of available audio output devices plus the currently
 * active selection. Broadcast immediately after AUTH, after every
 * successful device switch, and after JUCE's `audioDeviceListChanged`
 * fires (USB plug / unplug, Windows audio-config reload).
 */
export const AudioDevicesListPayloadSchema = z.object({
  types: z.array(AudioDeviceTypeListingSchema),
  /** Active device type, or null when the backend has no device open. */
  currentTypeName: z.string().nullable(),
  /** Active output device name, or null when the backend has no device
   *  open. Empty string is treated the same as null. */
  currentDeviceName: z.string().nullable(),
  currentSampleRate: z.number().optional(),
  currentBufferSize: z.number().optional(),
  /** Total effective output latency in ms — what the backend will
   *  subtract from the broadcast playhead while playing. Sum of the
   *  driver's own report + the Bluetooth heuristic baseline. Absent
   *  / 0 means "negligible, no compensation applied". */
  outputLatencyMs: z.number().optional(),
  /** Just the Bluetooth-heuristic component, in ms. Non-zero means
   *  "the driver under-reports and we've added a baseline guess for
   *  the radio/headset pipeline". Surfaces a small "BT" hint next to
   *  the latency readout. */
  heuristicExtraLatencyMs: z.number().optional(),
  /** True iff the backend tried to honour a persisted device preference
   *  on startup but the saved device wasn't available — useful for the
   *  renderer to pop a one-shot "your saved device wasn't connected;
   *  using default" toast. Cleared by the backend on the next switch. */
  fellBackToDefault: z.boolean().optional(),
  /** True when this snapshot is the partial pre-scan list broadcast
   *  during boot, while the full device scan is still pending. The
   *  renderer surfaces a small "Scanning audio devices…" hint on the
   *  startup overlay until the follow-up snapshot arrives with the
   *  flag absent / false. */
  scanInProgress: z.boolean().optional()
})
export type AudioDevicesListPayload = z.infer<typeof AudioDevicesListPayloadSchema>

/** Ack for an `AUDIO_DEVICE_SELECT`. On `ok: true` it's followed by a
 *  refreshed `AUDIO_DEVICES_LIST`; on `ok: false` the backend rolled
 *  the device setup back to whatever was active before the request. */
export const AudioDeviceChangedPayloadSchema = z.object({
  typeName: z.string().nullable(),
  deviceName: z.string().nullable(),
  ok: z.boolean(),
  error: z.string().optional()
})
export type AudioDeviceChangedPayload = z.infer<typeof AudioDeviceChangedPayloadSchema>

/**
 * Mirror of the backend's `juce::UndoManager` head state. Broadcast on
 * AUTH-connect right after the first `PROJECT_STATE`, after every
 * project-mutating envelope, and after `EDIT_UNDO` / `EDIT_REDO`. The
 * renderer surfaces the boolean flags on the Edit menu (Undo / Redo
 * grey out when their respective flag is false) and the label fields
 * power optional menu hints like "Undo Move clip".
 */
export const EditUndoStatePayloadSchema = z.object({
  canUndo: z.boolean(),
  canRedo: z.boolean(),
  /** Description of the transaction that would be undone next, or
   *  absent when `canUndo === false`. */
  undoLabel: z.string().optional(),
  /** Description of the transaction that would be redone next, or
   *  absent when `canRedo === false`. */
  redoLabel: z.string().optional()
})
export type EditUndoStatePayload = z.infer<typeof EditUndoStatePayloadSchema>

/**
 * Backend response to a renderer-issued `AUDIO_FILE_PROBE`. Carries
 * the file's true sample rate / channel count / duration (read from
 * the format header by JUCE's `AudioFormatManager`). `ok: false`
 * means the file couldn't be opened (missing, unsupported format,
 * corrupted); `error` carries a short reason. `requestId` echoes
 * the renderer's allocated id so concurrent probes don't collide.
 */
const AudioFileProbedSuccessSchema = z.object({
  requestId: z.string(),
  ok: z.literal(true),
  filePath: z.string(),
  sampleRate: z.number(),
  channelCount: z.number(),
  durationMs: z.number()
})
const AudioFileProbedFailureSchema = z.object({
  requestId: z.string(),
  ok: z.literal(false),
  filePath: z.string(),
  error: z.string()
})
export const AudioFileProbedPayloadSchema = z.discriminatedUnion('ok', [
  AudioFileProbedSuccessSchema,
  AudioFileProbedFailureSchema
])
export type AudioFileProbedPayload = z.infer<typeof AudioFileProbedPayloadSchema>

/** Progress tick for an in-progress mixdown render. Emitted by the
 *  backend roughly every 50 ms while rendering or encoding. `percent`
 *  is `0..100` and is monotonically non-decreasing across a single
 *  render. `stage` lets the UI surface the current weighted phase. */
export const MixdownProgressPayloadSchema = z.object({
  percent: z.number(),
  stage: z.enum([
    'prepare',
    'render',
    'finalize',
    'encode',
    'analyze',
    'normalize-pass1',
    'normalize-pass2'
  ])
})
export type MixdownProgressPayload = z.infer<typeof MixdownProgressPayloadSchema>

/** Success ack — mixdown finished and the file is at `filePath`.
 *  When the export ran with a loudness mode other than `off` the
 *  `loudness` block carries the post-render measurement (after gain
 *  has been applied in normalize mode). `integratedLufs` and
 *  `truePeakDbtp` are `null` for silent / unmeasurable programs
 *  because JSON cannot encode -Infinity. */
export const MixdownDonePayloadSchema = z.object({
  filePath: z.string(),
  durationMs: z.number(),
  loudness: z.optional(z.object({
    integratedLufs: z.union([z.number(), z.null()]),
    truePeakDbtp: z.union([z.number(), z.null()]),
    silent: z.boolean(),
    unmeasurable: z.boolean(),
    gatedBlockCount: z.number(),
    appliedGainDb: z.number(),
    limitedByTruePeak: z.boolean(),
    pass2ClippedSamples: z.number(),
    pass2PostGainPeak: z.number()
  }))
})
export type MixdownDonePayload = z.infer<typeof MixdownDonePayloadSchema>

/** Failure ack — `code` lets the UI distinguish intentional cancel
 *  ('cancelled') from real errors so the progress dialog can dismiss
 *  quietly vs. surfacing the error toast. */
export const MixdownFailedPayloadSchema = z.object({
  code: z.enum(['cancelled', 'io', 'decode', 'encode', 'invalid']),
  error: z.string()
})
export type MixdownFailedPayload = z.infer<typeof MixdownFailedPayloadSchema>

/** Per-channel master output peaks, sampled by the backend audio thread
 *  POST master-gain and drained by the broadcaster at ~60 Hz. Each lane
 *  is the maximum sample magnitude observed since the last broadcast
 *  (lock-free "max since last read" atomic on the audio side). Values
 *  are linear scalars and can exceed 1.0 when tracks sum hot — the UI
 *  is responsible for converting to dB and rendering any over-zero
 *  "clip" indicator. The backend gates broadcasts on activity so a
 *  long silent stretch stops emitting; one trailing zero is sent on
 *  the transition to silence so the UI's hold/decay can finish. */
export const MasterLevelPayloadSchema = z.object({
  peakL: z.number().nonnegative(),
  peakR: z.number().nonnegative()
})
export type MasterLevelPayload = z.infer<typeof MasterLevelPayloadSchema>

/** Per-track peak meter. Same lifecycle and gating rules as
 *  `MASTER_LEVEL`: backend taps the post-chain peak in each
 *  `TrackRuntime`, drains them on the broadcaster tick (~60 Hz),
 *  and emits this envelope only when at least one track has
 *  non-trivial signal (with one trailing zero so the renderer's
 *  hold/decay can finish). The renderer fans out the array by
 *  `id` to the matching per-track meter component. Tracks with
 *  no clips (and therefore no runtime) are simply absent from
 *  the array — the renderer treats them as silent. */
export const TrackLevelEntrySchema = z.object({
  id: z.string().min(1),
  peakL: z.number().nonnegative(),
  peakR: z.number().nonnegative()
})
export type TrackLevelEntry = z.infer<typeof TrackLevelEntrySchema>
export const TrackLevelsPayloadSchema = z.object({
  tracks: z.array(TrackLevelEntrySchema)
})
export type TrackLevelsPayload = z.infer<typeof TrackLevelsPayloadSchema>

export interface BridgeInboundMap {
  READY: ReadyPayload
  PROJECT_STATE: ProjectStatePayload
  PLAYHEAD_UPDATE: PlayheadUpdatePayload
  CLIP_ADDED: ClipAckPayload
  CLIP_ADD_FAILED: ClipAckPayload
  TRACK_ADDED: TrackAddedPayload
  TRACK_REMOVED: TrackRemovedPayload
  CLIP_REMOVED: ClipRemovedPayload
  TRACK_GAIN_APPLIED: TrackGainAppliedPayload
  TRACK_MUTE_APPLIED: TrackMuteAppliedPayload
  TRACK_SOLO_APPLIED: TrackSoloAppliedPayload
  TRACK_SENDS_APPLIED: TrackSendsAppliedPayload
  TRACK_TONE_APPLIED: TrackToneAppliedPayload
  TRACK_LEVELER_APPLIED: TrackLevelerAppliedPayload
  TRACK_PAN_APPLIED: TrackPanAppliedPayload
  CLIP_ENVELOPE_APPLIED: ClipEnvelopeAppliedPayload
  PROJECT_REVERB_APPLIED: ProjectReverbAppliedPayload
  PROJECT_DELAY_APPLIED: ProjectDelayAppliedPayload
  PROJECT_SAVED: ProjectSavedPayload
  PROJECT_VIEW_STATE_SAVED: ProjectViewStateSavedPayload
  PROJECT_AUTOSAVED: ProjectAutosavedPayload
  PROJECT_LOAD_FAILED: ProjectLoadFailedPayload
  PROJECT_RENAMED: ProjectRenamedPayload
  PROJECT_DIRTY: ProjectDirtyPayload
  WAVEFORM_READY: WaveformReadyPayload
  CLIP_EDITOR_PEAKS_READY: ClipEditorPeaksReadyPayload
  SAMPLE_SAVED: SampleSavedPayload
  LIBRARY_ITEM_ANALYSIS: LibraryItemAnalysisPayload
  CLIP_WARP_APPLIED: ClipWarpAppliedPayload
  PROJECT_BPM_APPLIED: ProjectBpmAppliedPayload
  PREVIEW_STATE: PreviewStatePayload
  PREVIEW_POSITION: PreviewPositionPayload
  PREVIEW_ENDED: PreviewEndedPayload
  AUDIO_DEVICES_LIST: AudioDevicesListPayload
  AUDIO_DEVICE_CHANGED: AudioDeviceChangedPayload
  EDIT_UNDO_STATE: EditUndoStatePayload
  AUDIO_FILE_PROBED: AudioFileProbedPayload
  MIXDOWN_PROGRESS: MixdownProgressPayload
  MIXDOWN_DONE: MixdownDonePayload
  MIXDOWN_FAILED: MixdownFailedPayload
  MASTER_LEVEL: MasterLevelPayload
  TRACK_LEVELS: TrackLevelsPayload
}

export type BridgeInboundType = keyof BridgeInboundMap

/**
 * Inbound envelope, discriminated on `type`. The dispatcher narrows to one
 * arm per case so the exhaustiveness check fires if a new arm is added to
 * `BridgeInboundMap` without a matching case.
 */
export type BridgeInboundMessage = {
  [K in BridgeInboundType]: { type: K; payload: BridgeInboundMap[K] }
}[BridgeInboundType]

/** Outbound envelope, discriminated on `type` (used when serialising). */
export type BridgeOutboundMessage = {
  [K in BridgeOutboundType]: BridgeOutboundMap[K] extends undefined
    ? { type: K }
    : { type: K; payload: BridgeOutboundMap[K] }
}[BridgeOutboundType]

// ─── Runtime validation ─────────────────────────────────────────────────────

/** Every legal inbound envelope `type`. Kept in lockstep with `BridgeInboundMap`. */
const INBOUND_TYPES: ReadonlySet<BridgeInboundType> = new Set<BridgeInboundType>([
  'READY',
  'PROJECT_STATE',
  'PLAYHEAD_UPDATE',
  'CLIP_ADDED',
  'CLIP_ADD_FAILED',
  'TRACK_ADDED',
  'TRACK_REMOVED',
  'CLIP_REMOVED',
  'TRACK_GAIN_APPLIED',
  'TRACK_MUTE_APPLIED',
  'TRACK_SOLO_APPLIED',
  'TRACK_SENDS_APPLIED',
  'TRACK_TONE_APPLIED',
  'TRACK_LEVELER_APPLIED',
  'TRACK_PAN_APPLIED',
  'CLIP_ENVELOPE_APPLIED',
  'PROJECT_REVERB_APPLIED',
  'PROJECT_DELAY_APPLIED',
  'PROJECT_SAVED',
  'PROJECT_VIEW_STATE_SAVED',
  'PROJECT_AUTOSAVED',
  'PROJECT_LOAD_FAILED',
  'PROJECT_RENAMED',
  'PROJECT_DIRTY',
  'WAVEFORM_READY',
  'CLIP_EDITOR_PEAKS_READY',
  'SAMPLE_SAVED',
  'LIBRARY_ITEM_ANALYSIS',
  'CLIP_WARP_APPLIED',
  'PROJECT_BPM_APPLIED',
  'PREVIEW_STATE',
  'PREVIEW_POSITION',
  'PREVIEW_ENDED',
  'AUDIO_DEVICES_LIST',
  'AUDIO_DEVICE_CHANGED',
  'EDIT_UNDO_STATE',
  'AUDIO_FILE_PROBED',
  'MIXDOWN_PROGRESS',
  'MIXDOWN_DONE',
  'MIXDOWN_FAILED',
  'MASTER_LEVEL',
  'TRACK_LEVELS'
])

/** Narrow an unknown string to the inbound type union. */
export function isBridgeInboundType(value: unknown): value is BridgeInboundType {
  return typeof value === 'string' && INBOUND_TYPES.has(value as BridgeInboundType)
}

// Each guard delegates to its matching zod schema. `safeParse(...).success`
// returns a boolean and acts as the type predicate; the schema is the
// single source of truth for what a valid payload looks like.

/** Guard for `ReadyPayload`. */
export function isReadyPayload(value: unknown): value is ReadyPayload {
  return ReadyPayloadSchema.safeParse(value).success
}

/** Guard for `PlayheadUpdatePayload`. */
export function isPlayheadUpdatePayload(value: unknown): value is PlayheadUpdatePayload {
  return PlayheadUpdatePayloadSchema.safeParse(value).success
}

/** Guard for `ClipAckPayload`. */
export function isClipAckPayload(value: unknown): value is ClipAckPayload {
  return ClipAckPayloadSchema.safeParse(value).success
}

/** Guard for `TrackAddedPayload`. */
export function isTrackAddedPayload(value: unknown): value is TrackAddedPayload {
  return TrackAddedPayloadSchema.safeParse(value).success
}

/** Guard for `ProjectStatePayload`. */
export function isProjectStatePayload(value: unknown): value is ProjectStatePayload {
  return ProjectStatePayloadSchema.safeParse(value).success
}

/** Guard for `ProjectSavedPayload`. */
export function isProjectSavedPayload(value: unknown): value is ProjectSavedPayload {
  return ProjectSavedPayloadSchema.safeParse(value).success
}

/** Guard for `ProjectViewStateSavedPayload`. */
export function isProjectViewStateSavedPayload(value: unknown): value is ProjectViewStateSavedPayload {
  return ProjectViewStateSavedPayloadSchema.safeParse(value).success
}

/** Guard for `ProjectAutosavedPayload`. Shares its shape with the
 *  explicit-save ack; kept as a separate function so callers can
 *  document intent at the call site. */
export function isProjectAutosavedPayload(value: unknown): value is ProjectAutosavedPayload {
  return ProjectAutosavedPayloadSchema.safeParse(value).success
}

/** Guard for `ProjectLoadFailedPayload`. */
export function isProjectLoadFailedPayload(value: unknown): value is ProjectLoadFailedPayload {
  return ProjectLoadFailedPayloadSchema.safeParse(value).success
}

/** Guard for `ProjectRenamedPayload`. */
export function isProjectRenamedPayload(value: unknown): value is ProjectRenamedPayload {
  return ProjectRenamedPayloadSchema.safeParse(value).success
}

/** Guard for `ProjectDirtyPayload`. */
export function isProjectDirtyPayload(value: unknown): value is ProjectDirtyPayload {
  return ProjectDirtyPayloadSchema.safeParse(value).success
}

/** Guard for `WaveformReadyPayload`. */
export function isWaveformReadyPayload(value: unknown): value is WaveformReadyPayload {
  return WaveformReadyPayloadSchema.safeParse(value).success
}

/** Guard for `ClipEditorPeaksReadyPayload`. */
export function isClipEditorPeaksReadyPayload(value: unknown): value is ClipEditorPeaksReadyPayload {
  return ClipEditorPeaksReadyPayloadSchema.safeParse(value).success
}

/** Guard for `SampleSavedPayload`. */
export function isSampleSavedPayload(value: unknown): value is SampleSavedPayload {
  return SampleSavedPayloadSchema.safeParse(value).success
}

/** Guard for `TrackRemovedPayload`. */
export function isTrackRemovedPayload(value: unknown): value is TrackRemovedPayload {
  return TrackRemovedPayloadSchema.safeParse(value).success
}

/** Guard for `ClipRemovedPayload`. */
export function isClipRemovedPayload(value: unknown): value is ClipRemovedPayload {
  return ClipRemovedPayloadSchema.safeParse(value).success
}

/** Guard for `TrackGainAppliedPayload`. */
export function isTrackGainAppliedPayload(value: unknown): value is TrackGainAppliedPayload {
  return TrackGainAppliedPayloadSchema.safeParse(value).success
}

/** Guard for `TrackMuteAppliedPayload`. */
export function isTrackMuteAppliedPayload(value: unknown): value is TrackMuteAppliedPayload {
  return TrackMuteAppliedPayloadSchema.safeParse(value).success
}

/** Guard for `TrackSoloAppliedPayload`. */
export function isTrackSoloAppliedPayload(value: unknown): value is TrackSoloAppliedPayload {
  return TrackSoloAppliedPayloadSchema.safeParse(value).success
}

/** Guard for `TrackSendsAppliedPayload`. */
export function isTrackSendsAppliedPayload(value: unknown): value is TrackSendsAppliedPayload {
  return TrackSendsAppliedPayloadSchema.safeParse(value).success
}

/** Guard for `TrackToneAppliedPayload`. */
export function isTrackToneAppliedPayload(value: unknown): value is TrackToneAppliedPayload {
  return TrackToneAppliedPayloadSchema.safeParse(value).success
}

/** Guard for `TrackLevelerAppliedPayload`. */
export function isTrackLevelerAppliedPayload(value: unknown): value is TrackLevelerAppliedPayload {
  return TrackLevelerAppliedPayloadSchema.safeParse(value).success
}

/** Guard for `TrackPanAppliedPayload`. */
export function isTrackPanAppliedPayload(value: unknown): value is TrackPanAppliedPayload {
  return TrackPanAppliedPayloadSchema.safeParse(value).success
}

/** Guard for `ClipEnvelopeAppliedPayload`. */
export function isClipEnvelopeAppliedPayload(value: unknown): value is ClipEnvelopeAppliedPayload {
  return ClipEnvelopeAppliedPayloadSchema.safeParse(value).success
}

/** Guard for `ProjectReverbAppliedPayload`. */
export function isProjectReverbAppliedPayload(value: unknown): value is ProjectReverbAppliedPayload {
  return ProjectReverbAppliedPayloadSchema.safeParse(value).success
}

/** Guard for `ProjectDelayAppliedPayload`. */
export function isProjectDelayAppliedPayload(value: unknown): value is ProjectDelayAppliedPayload {
  return ProjectDelayAppliedPayloadSchema.safeParse(value).success
}

/** Guard for `LibraryItemAnalysisPayload`. */
export function isLibraryItemAnalysisPayload(value: unknown): value is LibraryItemAnalysisPayload {
  return LibraryItemAnalysisPayloadSchema.safeParse(value).success
}

/** Guard for `ProjectBpmAppliedPayload`. */
export function isProjectBpmAppliedPayload(value: unknown): value is ProjectBpmAppliedPayload {
  return ProjectBpmAppliedPayloadSchema.safeParse(value).success
}

/** Guard for `ClipWarpAppliedPayload`. */
export function isClipWarpAppliedPayload(value: unknown): value is ClipWarpAppliedPayload {
  return ClipWarpAppliedPayloadSchema.safeParse(value).success
}

/** Guard for `PreviewStatePayload`. */
export function isPreviewStatePayload(value: unknown): value is PreviewStatePayload {
  return PreviewStatePayloadSchema.safeParse(value).success
}

/** Guard for `PreviewPositionPayload`. */
export function isPreviewPositionPayload(value: unknown): value is PreviewPositionPayload {
  return PreviewPositionPayloadSchema.safeParse(value).success
}

/** Guard for `PreviewEndedPayload`. */
export function isPreviewEndedPayload(value: unknown): value is PreviewEndedPayload {
  return PreviewEndedPayloadSchema.safeParse(value).success
}

/** Guard for `AudioDevicesListPayload`. */
export function isAudioDevicesListPayload(value: unknown): value is AudioDevicesListPayload {
  return AudioDevicesListPayloadSchema.safeParse(value).success
}

/** Guard for `AudioDeviceChangedPayload`. */
export function isAudioDeviceChangedPayload(value: unknown): value is AudioDeviceChangedPayload {
  return AudioDeviceChangedPayloadSchema.safeParse(value).success
}

/** Guard for `EditUndoStatePayload`. */
export function isEditUndoStatePayload(value: unknown): value is EditUndoStatePayload {
  return EditUndoStatePayloadSchema.safeParse(value).success
}

/** Guard for `AudioFileProbedPayload`. */
export function isAudioFileProbedPayload(value: unknown): value is AudioFileProbedPayload {
  return AudioFileProbedPayloadSchema.safeParse(value).success
}

/** Guard for `MixdownProgressPayload`. */
export function isMixdownProgressPayload(value: unknown): value is MixdownProgressPayload {
  return MixdownProgressPayloadSchema.safeParse(value).success
}

/** Guard for `MixdownDonePayload`. */
export function isMixdownDonePayload(value: unknown): value is MixdownDonePayload {
  return MixdownDonePayloadSchema.safeParse(value).success
}

/** Guard for `MixdownFailedPayload`. */
export function isMixdownFailedPayload(value: unknown): value is MixdownFailedPayload {
  return MixdownFailedPayloadSchema.safeParse(value).success
}

/** Guard for `MasterLevelPayload`. */
export function isMasterLevelPayload(value: unknown): value is MasterLevelPayload {
  return MasterLevelPayloadSchema.safeParse(value).success
}

/** Guard for `TrackLevelsPayload`. */
export function isTrackLevelsPayload(value: unknown): value is TrackLevelsPayload {
  return TrackLevelsPayloadSchema.safeParse(value).success
}