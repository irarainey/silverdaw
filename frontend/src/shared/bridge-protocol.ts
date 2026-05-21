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
  /** Linear gain (0 = silent, 1 = unity). */
  gain: number
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
  CLIP_REMOVE: ClipRemovePayload
  LIBRARY_ITEM_RELINK: LibraryItemRelinkPayload
  CLIP_RENAME: ClipRenamePayload
  LIBRARY_ADD: LibraryAddPayload
  LIBRARY_REMOVE: LibraryRemovePayload
  LIBRARY_REANALYSE: LibraryReanalysePayload
  TRACK_ADD: TrackAddPayload
  TRACK_REMOVE: TrackRemovePayload
  TRACK_RENAME: TrackRenamePayload
  TRACK_GAIN: TrackGainPayload
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
  PROJECT_MARKER_ADD: ProjectMarkerAddPayload
  PROJECT_MARKER_MOVE: ProjectMarkerMovePayload
  PROJECT_MARKER_REMOVE: ProjectMarkerRemovePayload
  PREVIEW_LOAD: PreviewLoadPayload
  PREVIEW_UNLOAD: undefined
  PREVIEW_PLAY: undefined
  PREVIEW_PAUSE: undefined
  PREVIEW_STOP: undefined
  PREVIEW_SEEK: PreviewSeekPayload
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
}

/** Tempo edit. Marks the project dirty on the backend. */
export interface ProjectSetBpmPayload {
  bpm: number
}

/** Project-length edit (ms). Marks the project dirty on the backend. */
export interface ProjectSetLengthPayload {
  lengthMs: number
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

/** Start a preview voice on a library item, optionally windowed to a
 *  selection. `inMs` and `durationMs` are in milliseconds relative to the
 *  source file; `durationMs = 0` (or omitted) plays from `inMs` to the
 *  end of the source. */
export interface PreviewLoadPayload {
  libraryItemId: string
  inMs?: number
  durationMs?: number
}

/** Seek within the currently loaded preview window. `positionMs` is
 *  relative to the window start (0..durationMs). */
export interface PreviewSeekPayload {
  positionMs: number
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

export interface ReadyPayload {
  version: string
}

export interface PlayheadUpdatePayload {
  positionMs: number
  isPlaying: boolean
}

export interface ClipAckPayload {
  trackId: string
  clipId: string
  libraryItemId: string
  ok: boolean
  /**
   * Backend-supplied error message. Present iff `ok === false`.
   * Surfaced through `notificationsStore.pushError(...)` in the renderer.
   */
  error?: string
}

/**
 * Backend ack for a prior `TRACK_ADD` envelope. `ok === false` means the
 * track id was unknown OR the payload was malformed; rare in practice
 * because the renderer generates the trackId locally and addTrack on
 * the backend is idempotent.
 */
export interface TrackAddedPayload {
  trackId: string
  ok: boolean
}

/**
 * Backend ack for a prior `TRACK_REMOVE` envelope. `ok === false` means the
 * track id was unknown on the backend (i.e. the renderer's view drifted out
 * of sync). The renderer has already optimistically removed the row, so a
 * negative ack is logged but otherwise non-fatal.
 */
export interface TrackRemovedPayload {
  trackId: string
  ok: boolean
}

/** Backend ack for `CLIP_REMOVE`. `ok=false` means the clip id was
 *  unknown to the project tree. The renderer logs but doesn't re-add
 *  the clip — local optimistic removal already happened. */
export interface ClipRemovedPayload {
  clipId: string
  ok: boolean
}

/**
 * Backend ack for a prior `TRACK_GAIN` envelope, echoing the gain value
 * actually applied (clamped or quantised on the backend if needed) so the
 * renderer can verify the engine state matches local expectations. `ok ===
 * false` means the track id was unknown — gain mismatches are logged as a
 * warning, not surfaced to the user.
 */
export interface TrackGainAppliedPayload {
  trackId: string
  /** Linear gain actually applied on the backend. */
  gain: number
  ok: boolean
}

export interface ProjectViewStateSavedPayload {
  filePath: string
  ok: boolean
  error?: string
}

/** Ack for `PROJECT_AUTOSAVE`. Carries no `PROJECT_STATE` or
 *  `PROJECT_DIRTY` follow-up: autosave is deliberately invisible to the
 *  user-facing project lifecycle. */
export interface ProjectAutosavedPayload {
  filePath: string
  ok: boolean
  error?: string
}

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
export interface ProjectStateClip {
  id: string
  /** Library item this clip plays from. Source-of-truth for the
   *  underlying audio file; the renderer resolves filePath / fileName /
   *  peaks through the library. */
  libraryItemId: string
  offsetMs: number
  durationMs: number
  /** Where in the source file this clip starts reading (trim offset).
   *  Optional: omitted on un-trimmed clips; the renderer falls back to 0. */
  inMs?: number
  /** Per-clip palette index override (0..15). Absent means the clip
   *  inherits the host track's colour. */
  colorIndex?: number
  /** User-facing display name override (set via inline rename on the
   *  timeline). Absent means use the library item title / filename. */
  name?: string
  /** True when the library item's source file no longer exists on
   *  disk. Renderer renders the clip greyed-out and surfaces a
   *  "Locate files…" toast; engine playback skips it. */
  unresolved?: boolean
}

export interface ProjectStateTrack {
  id: string
  /** Persisted user-facing track name. Optional for projects saved before this field existed. */
  name?: string
  gain: number
  clips: ProjectStateClip[]
}

export interface ProjectStatePayload {
  /** Absolute path to the current `.silverdaw` file, or `null` for an unsaved project. */
  filePath: string | null
  /** User-facing project name. `Untitled` for a freshly-created project. */
  name: string
  /**
   * Renderer hint — when true, wipe optimistic local state (tracks, clips,
   * library, selection, transport) before applying this snapshot. Sent on
   * `PROJECT_LOAD` and `PROJECT_NEW`; absent / false on the connect path
   * where the renderer treats the snapshot as additive (see
   * `projectStore.applyProjectStateSnapshot`).
   */
  reset?: boolean
  /**
   * Horizontal zoom level (px-per-second) persisted with the project.
   * Optional: omitted on a snapshot for a project that hasn't yet set a
   * zoom (the renderer keeps its current zoom in that case).
   */
  viewPxPerSecond?: number
  /** Horizontal scroll position (px) persisted with the project. */
  viewScrollX?: number
  /** Last playhead position (ms) persisted with the project. */
  playheadMs?: number
  /** Project tempo (BPM) persisted with the project. */
  bpm?: number
  /** User-set project length (ms) persisted with the project. */
  projectLengthMs?: number
  /** User-created timeline markers. */
  markers?: ProjectStateMarker[]
  /**
   * Library catalogue persisted with the project. Each entry is the
   * `(id, filePath)` pair the renderer originally created the item
   * with, plus decoded duration and an optional `unresolved` flag
   * mirroring the clip path — set when the file is no longer on disk.
   * Cover art / ID3 metadata is NOT in here; the renderer re-fetches
   * it on load via the existing `audio:readMetadata` IPC.
   */
  library?: ProjectStateLibraryItem[]
  tracks: ProjectStateTrack[]
}

export interface ProjectStateMarker {
  id: string
  positionMs: number
}

export interface ProjectStateLibraryItem {
  id: string
  filePath: string
  /** Library item kind. Older projects omit this and are treated as whole audio files. */
  kind?: LibraryItemKind
  /** User-facing name. Saved clips use this for their reusable clip name. */
  name?: string
  /** Display file name captured when the item entered the library. */
  fileName?: string
  /** Source duration in milliseconds. Optional for older saved projects. */
  durationMs?: number
  /** Source sample rate. Optional for older saved projects. */
  sampleRate?: number
  /** Source channel count. Optional for older saved projects. */
  channelCount?: number
  /** Detected musical key, e.g. `C minor`. Optional when detection is inconclusive. */
  key?: string
  /** Detected BPM (rounded to 2 d.p. on disk). Absent until the
   *  backend's BPM detection job finishes for this file. */
  bpm?: number
  /** Detected beat positions in seconds from the start of the source
   *  file. Absent for items without BPM detection results yet. */
  beats?: number[]
  /** Regression-derived "ideal beat 0" anchor (seconds; can be
   *  negative). Used with `bpm` to lay out the synthesised marker
   *  grid robustly against per-beat jitter. */
  beatAnchorSec?: number
  /** Cache path the backend has decoded this source into. Future
   *  clips of this file should use this path so the audio engine
   *  reads cheap PCM instead of decoding the original. */
  playbackFilePath?: string
  /** True when BTrack's running tempo estimate fluctuated by more than
   *  ~2 % over the analysis window — the project-BPM seeder skips
   *  these and the library tile shows a "variable" badge. */
  variableTempo?: boolean
  /** Parent source library item for saved clips. */
  sourceItemId?: string
  /** Timeline clip that originally produced this saved clip, when known. */
  sourceClipId?: string
  /** Start of the saved clip window inside the source file. */
  sourceInMs?: number
  /** Duration of the saved clip window inside the source file. */
  sourceDurationMs?: number
  /** Source-group disclosure state. True when the user has collapsed
   *  the source's saved-clip list in the library panel. */
  collapsed?: boolean
  unresolved?: boolean
}

export type LibraryItemKind = 'audio-file' | 'saved-clip'

export interface ProjectSavedPayload {
  filePath: string
  ok: boolean
  error?: string
}

export interface ProjectLoadFailedPayload {
  filePath: string
  error: string
}

export interface ProjectRenamePayload {
  name: string
}

export interface ProjectRenamedPayload {
  name: string
  ok: boolean
}

/** Backend notification that the project's dirty flag has transitioned. */
export interface ProjectDirtyPayload {
  dirty: boolean
}

/**
 * Backend notification that a fresh on-disk peaks cache file is ready
 * for `clipId`. The renderer reads the file directly via main's
 * `readPeaksCacheFile` IPC — peaks bytes are NOT streamed over the
 * WebSocket (that approach hit recurring IXWebSocket I/O-loop
 * starvation issues with concurrent peak deliveries). The cache file
 * layout is fixed: a 24-byte header followed by `peakCount * 2`
 * little-endian float32 peak values (`min, max, min, max, …`).
 */
export interface WaveformReadyPayload {
  clipId: string
  /** Absolute path of the cache file under `%APPDATA%/Silverdaw/peaks/`. */
  cachePath: string
  /** Number of (min, max) pairs in the file (NOT bytes, NOT individual floats). */
  peakCount: number
  peaksPerSecond: number
  sampleRate: number
}

/** Backend notification that BPM + beat-position detection has completed
 *  for a library item. `beats` is an array of times (in seconds from
 *  the start of the source file) at which BTrack detected a beat;
 *  `variableTempo` is `true` when the running tempo estimate fluctuated
 *  enough over the analysis window to make a single project-BPM seed
 *  misleading. */
export interface LibraryItemAnalysisPayload {
  itemId: string
  bpm: number
  /** Regression-derived "ideal beat 0" anchor (seconds, may be
   *  negative). Renderer-side beat-marker grid uses this for
   *  phase. */
  beatAnchorSec: number
  beats: number[]
  variableTempo: boolean
  /** Path to the decoded-WAV cache the backend has written for this
   *  source file. Future clip adds should use this path so the
   *  audio engine reads cheap PCM instead of decoding MP3 / WMA on
   *  the read-ahead thread. */
  playbackFilePath?: string
}

/** Backend notification that it just seeded the project BPM (e.g. from
 *  the first import on an empty project). The renderer updates its
 *  `projectStore.bpm` mirror without re-broadcasting `PROJECT_SET_BPM`. */
export interface ProjectBpmAppliedPayload {
  bpm: number
}

/** Broadcast on every preview load/play/pause/stop/unload transition. */
export interface PreviewStatePayload {
  /** Echoed back from the most recent PREVIEW_LOAD; absent on unload. */
  libraryItemId?: string
  isPlaying: boolean
  isLoaded: boolean
  durationMs: number
  /** Monotonic counter. Increments on every load/unload; the renderer
   *  uses it to discard stale state for a preview the user has already
   *  closed. */
  generation: number
}

/** Preview-position tick while the preview transport is playing. */
export interface PreviewPositionPayload {
  positionMs: number
  isPlaying: boolean
  generation: number
}

/** Broadcast when the preview reaches the end of its selection window. */
export interface PreviewEndedPayload {
  generation: number
}

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
  PROJECT_SAVED: ProjectSavedPayload
  PROJECT_VIEW_STATE_SAVED: ProjectViewStateSavedPayload
  PROJECT_AUTOSAVED: ProjectAutosavedPayload
  PROJECT_LOAD_FAILED: ProjectLoadFailedPayload
  PROJECT_RENAMED: ProjectRenamedPayload
  PROJECT_DIRTY: ProjectDirtyPayload
  WAVEFORM_READY: WaveformReadyPayload
  LIBRARY_ITEM_ANALYSIS: LibraryItemAnalysisPayload
  PROJECT_BPM_APPLIED: ProjectBpmAppliedPayload
  PREVIEW_STATE: PreviewStatePayload
  PREVIEW_POSITION: PreviewPositionPayload
  PREVIEW_ENDED: PreviewEndedPayload
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
  'PROJECT_SAVED',
  'PROJECT_VIEW_STATE_SAVED',
  'PROJECT_AUTOSAVED',
  'PROJECT_LOAD_FAILED',
  'PROJECT_RENAMED',
  'PROJECT_DIRTY',
  'WAVEFORM_READY',
  'LIBRARY_ITEM_ANALYSIS',
  'PROJECT_BPM_APPLIED',
  'PREVIEW_STATE',
  'PREVIEW_POSITION',
  'PREVIEW_ENDED'
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow an unknown string to the inbound type union. */
export function isBridgeInboundType(value: unknown): value is BridgeInboundType {
  return typeof value === 'string' && INBOUND_TYPES.has(value as BridgeInboundType)
}

/** Guard for `ReadyPayload`. */
export function isReadyPayload(value: unknown): value is ReadyPayload {
  return isPlainObject(value) && typeof value.version === 'string'
}

/** Guard for `PlayheadUpdatePayload`. */
export function isPlayheadUpdatePayload(value: unknown): value is PlayheadUpdatePayload {
  return (
    isPlainObject(value) &&
    typeof value.positionMs === 'number' &&
    typeof value.isPlaying === 'boolean'
  )
}

/** Guard for `ClipAckPayload`. */
export function isClipAckPayload(value: unknown): value is ClipAckPayload {
  return (
    isPlainObject(value) &&
    typeof value.trackId === 'string' &&
    typeof value.clipId === 'string' &&
    typeof value.libraryItemId === 'string' &&
    typeof value.ok === 'boolean' &&
    (value.error === undefined || typeof value.error === 'string')
  )
}

/** Guard for `TrackAddedPayload`. */
export function isTrackAddedPayload(value: unknown): value is TrackAddedPayload {
  return isPlainObject(value) && typeof value.trackId === 'string' && typeof value.ok === 'boolean'
}

/** Guard for `ProjectStatePayload`. */
export function isProjectStatePayload(value: unknown): value is ProjectStatePayload {
  if (!isPlainObject(value)) return false
  if (value.filePath !== null && typeof value.filePath !== 'string') return false
  if (typeof value.name !== 'string') return false
  if (value.reset !== undefined && typeof value.reset !== 'boolean') return false
  if (value.viewPxPerSecond !== undefined && typeof value.viewPxPerSecond !== 'number') return false
  if (value.viewScrollX !== undefined && typeof value.viewScrollX !== 'number') return false
  if (value.playheadMs !== undefined && typeof value.playheadMs !== 'number') return false
  if (value.bpm !== undefined && typeof value.bpm !== 'number') return false
  if (value.projectLengthMs !== undefined && typeof value.projectLengthMs !== 'number') return false
  if (value.markers !== undefined) {
    if (!Array.isArray(value.markers)) return false
    for (const marker of value.markers) {
      if (!isPlainObject(marker)) return false
      if (typeof marker.id !== 'string' || typeof marker.positionMs !== 'number') return false
    }
  }
  if (value.library !== undefined) {
    if (!Array.isArray(value.library)) return false
    for (const item of value.library) {
      if (!isPlainObject(item)) return false
      if (typeof item.id !== 'string' || typeof item.filePath !== 'string') return false
      if (item.kind !== undefined && item.kind !== 'audio-file' && item.kind !== 'saved-clip') return false
      if (item.name !== undefined && typeof item.name !== 'string') return false
      if (item.fileName !== undefined && typeof item.fileName !== 'string') return false
      if (item.durationMs !== undefined && typeof item.durationMs !== 'number') return false
      if (item.sampleRate !== undefined && typeof item.sampleRate !== 'number') return false
      if (item.channelCount !== undefined && typeof item.channelCount !== 'number') return false
      if (item.key !== undefined && typeof item.key !== 'string') return false
      if (item.bpm !== undefined && typeof item.bpm !== 'number') return false
      if (item.beats !== undefined) {
        if (!Array.isArray(item.beats)) return false
        for (const b of item.beats) {
          if (typeof b !== 'number') return false
        }
      }
      if (item.beatAnchorSec !== undefined && typeof item.beatAnchorSec !== 'number') return false
      if (item.playbackFilePath !== undefined && typeof item.playbackFilePath !== 'string') return false
      if (item.variableTempo !== undefined && typeof item.variableTempo !== 'boolean') return false
      if (item.sourceItemId !== undefined && typeof item.sourceItemId !== 'string') return false
      if (item.sourceClipId !== undefined && typeof item.sourceClipId !== 'string') return false
      if (item.sourceInMs !== undefined && typeof item.sourceInMs !== 'number') return false
      if (item.sourceDurationMs !== undefined && typeof item.sourceDurationMs !== 'number') return false
      if (item.collapsed !== undefined && typeof item.collapsed !== 'boolean') return false
      if (item.unresolved !== undefined && typeof item.unresolved !== 'boolean') return false
      if (item.kind === 'saved-clip') {
        if (typeof item.sourceInMs !== 'number' || typeof item.sourceDurationMs !== 'number') return false
      }
    }
  }
  if (!Array.isArray(value.tracks)) return false
  for (const t of value.tracks) {
    if (!isPlainObject(t)) return false
    if (typeof t.id !== 'string' || typeof t.gain !== 'number') return false
    if (t.name !== undefined && typeof t.name !== 'string') return false
    if (!Array.isArray(t.clips)) return false
    for (const c of t.clips) {
      if (!isPlainObject(c)) return false
      if (
        typeof c.id !== 'string' ||
        typeof c.libraryItemId !== 'string' ||
        typeof c.offsetMs !== 'number' ||
        typeof c.durationMs !== 'number'
      ) {
        return false
      }
      if (c.inMs !== undefined && typeof c.inMs !== 'number') return false
      if (c.colorIndex !== undefined && typeof c.colorIndex !== 'number') return false
      if (c.name !== undefined && typeof c.name !== 'string') return false
      if (c.unresolved !== undefined && typeof c.unresolved !== 'boolean') return false
    }
  }
  return true
}

/** Guard for `ProjectSavedPayload`. */
export function isProjectSavedPayload(value: unknown): value is ProjectSavedPayload {
  return (
    isPlainObject(value) &&
    typeof value.filePath === 'string' &&
    typeof value.ok === 'boolean' &&
    (value.error === undefined || typeof value.error === 'string')
  )
}

export function isProjectViewStateSavedPayload(value: unknown): value is ProjectViewStateSavedPayload {
  return (
    isPlainObject(value) &&
    typeof value.filePath === 'string' &&
    typeof value.ok === 'boolean' &&
    (value.error === undefined || typeof value.error === 'string')
  )
}

/** Guard for `ProjectAutosavedPayload`. Shares its shape with the
 *  explicit-save ack; kept as a separate function so callers can
 *  document intent at the call site. */
export function isProjectAutosavedPayload(value: unknown): value is ProjectAutosavedPayload {
  return (
    isPlainObject(value) &&
    typeof value.filePath === 'string' &&
    typeof value.ok === 'boolean' &&
    (value.error === undefined || typeof value.error === 'string')
  )
}

/** Guard for `ProjectLoadFailedPayload`. */
export function isProjectLoadFailedPayload(value: unknown): value is ProjectLoadFailedPayload {
  return (
    isPlainObject(value) && typeof value.filePath === 'string' && typeof value.error === 'string'
  )
}

/** Guard for `ProjectRenamedPayload`. */
export function isProjectRenamedPayload(value: unknown): value is ProjectRenamedPayload {
  return isPlainObject(value) && typeof value.name === 'string' && typeof value.ok === 'boolean'
}

/** Guard for `ProjectDirtyPayload`. */
export function isProjectDirtyPayload(value: unknown): value is ProjectDirtyPayload {
  return isPlainObject(value) && typeof value.dirty === 'boolean'
}

/** Guard for `WaveformReadyPayload`. */
export function isWaveformReadyPayload(value: unknown): value is WaveformReadyPayload {
  return (
    isPlainObject(value) &&
    typeof value.clipId === 'string' &&
    typeof value.cachePath === 'string' &&
    typeof value.peakCount === 'number' &&
    typeof value.peaksPerSecond === 'number' &&
    typeof value.sampleRate === 'number'
  )
}

/** Guard for `TrackRemovedPayload`. */
export function isTrackRemovedPayload(value: unknown): value is TrackRemovedPayload {
  return isPlainObject(value) && typeof value.trackId === 'string' && typeof value.ok === 'boolean'
}

/** Guard for `ClipRemovedPayload`. */
export function isClipRemovedPayload(value: unknown): value is ClipRemovedPayload {
  return isPlainObject(value) && typeof value.clipId === 'string' && typeof value.ok === 'boolean'
}

/** Guard for `TrackGainAppliedPayload`. */
export function isTrackGainAppliedPayload(value: unknown): value is TrackGainAppliedPayload {
  return (
    isPlainObject(value) &&
    typeof value.trackId === 'string' &&
    typeof value.gain === 'number' &&
    typeof value.ok === 'boolean'
  )
}

/** Guard for `LibraryItemAnalysisPayload`. */
export function isLibraryItemAnalysisPayload(value: unknown): value is LibraryItemAnalysisPayload {
  if (!isPlainObject(value)) return false
  if (typeof value.itemId !== 'string' || typeof value.bpm !== 'number') return false
  if (typeof value.beatAnchorSec !== 'number') return false
  if (!Array.isArray(value.beats)) return false
  for (const b of value.beats) {
    if (typeof b !== 'number') return false
  }
  if (typeof value.variableTempo !== 'boolean') return false
  if (value.playbackFilePath !== undefined && typeof value.playbackFilePath !== 'string') return false
  return true
}

/** Guard for `ProjectBpmAppliedPayload`. */
export function isProjectBpmAppliedPayload(value: unknown): value is ProjectBpmAppliedPayload {
  return isPlainObject(value) && typeof value.bpm === 'number'
}

/** Guard for `PreviewStatePayload`. */
export function isPreviewStatePayload(value: unknown): value is PreviewStatePayload {
  if (!isPlainObject(value)) return false
  if (typeof value.isPlaying !== 'boolean') return false
  if (typeof value.isLoaded !== 'boolean') return false
  if (typeof value.durationMs !== 'number') return false
  if (typeof value.generation !== 'number') return false
  if (value.libraryItemId !== undefined && typeof value.libraryItemId !== 'string') return false
  return true
}

/** Guard for `PreviewPositionPayload`. */
export function isPreviewPositionPayload(value: unknown): value is PreviewPositionPayload {
  return (
    isPlainObject(value) &&
    typeof value.positionMs === 'number' &&
    typeof value.isPlaying === 'boolean' &&
    typeof value.generation === 'number'
  )
}

/** Guard for `PreviewEndedPayload`. */
export function isPreviewEndedPayload(value: unknown): value is PreviewEndedPayload {
  return isPlainObject(value) && typeof value.generation === 'number'
}
