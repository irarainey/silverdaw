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
  filePath: string
  positionMs: number
}

export interface ClipMovePayload {
  clipId: string
  positionMs: number
}

export interface TrackAddPayload {
  trackId: string
}

export interface TrackRemovePayload {
  trackId: string
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
  TRACK_ADD: TrackAddPayload
  TRACK_REMOVE: TrackRemovePayload
  TRACK_GAIN: TrackGainPayload
  TRANSPORT_PLAY: undefined
  TRANSPORT_PAUSE: undefined
  TRANSPORT_STOP: undefined
  TRANSPORT_SEEK: TransportSeekPayload
  WAVEFORM_REQUEST: WaveformRequestPayload
  PROJECT_NEW: undefined
  PROJECT_SAVE: ProjectSavePayload
  PROJECT_SAVE_AS: ProjectSaveAsPayload
  PROJECT_LOAD: ProjectLoadPayload
  PROJECT_RENAME: ProjectRenamePayload
  PROJECT_SET_VIEW: ProjectSetViewPayload
  PROJECT_SET_BPM: ProjectSetBpmPayload
  PROJECT_SET_LENGTH: ProjectSetLengthPayload
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
}

export interface ProjectSaveAsPayload {
  filePath: string
}

export interface ProjectLoadPayload {
  filePath: string
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
  filePath: string
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
  filePath: string
  offsetMs: number
  durationMs: number
}

export interface ProjectStateTrack {
  id: string
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
  tracks: ProjectStateTrack[]
}

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

export interface BridgeInboundMap {
  READY: ReadyPayload
  PROJECT_STATE: ProjectStatePayload
  PLAYHEAD_UPDATE: PlayheadUpdatePayload
  CLIP_ADDED: ClipAckPayload
  CLIP_ADD_FAILED: ClipAckPayload
  TRACK_ADDED: TrackAddedPayload
  TRACK_REMOVED: TrackRemovedPayload
  TRACK_GAIN_APPLIED: TrackGainAppliedPayload
  PROJECT_SAVED: ProjectSavedPayload
  PROJECT_LOAD_FAILED: ProjectLoadFailedPayload
  PROJECT_RENAMED: ProjectRenamedPayload
  PROJECT_DIRTY: ProjectDirtyPayload
  WAVEFORM_READY: WaveformReadyPayload
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
  'TRACK_GAIN_APPLIED',
  'PROJECT_SAVED',
  'PROJECT_LOAD_FAILED',
  'PROJECT_RENAMED',
  'PROJECT_DIRTY',
  'WAVEFORM_READY'
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
    typeof value.filePath === 'string' &&
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
  if (!Array.isArray(value.tracks)) return false
  for (const t of value.tracks) {
    if (!isPlainObject(t)) return false
    if (typeof t.id !== 'string' || typeof t.gain !== 'number') return false
    if (!Array.isArray(t.clips)) return false
    for (const c of t.clips) {
      if (!isPlainObject(c)) return false
      if (
        typeof c.id !== 'string' ||
        typeof c.filePath !== 'string' ||
        typeof c.offsetMs !== 'number' ||
        typeof c.durationMs !== 'number'
      ) {
        return false
      }
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

/** Guard for `TrackGainAppliedPayload`. */
export function isTrackGainAppliedPayload(value: unknown): value is TrackGainAppliedPayload {
  return (
    isPlainObject(value) &&
    typeof value.trackId === 'string' &&
    typeof value.gain === 'number' &&
    typeof value.ok === 'boolean'
  )
}
