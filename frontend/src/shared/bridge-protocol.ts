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
  filePath: string
  positionMs: number
}

export interface ClipMovePayload {
  trackId: string
  positionMs: number
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
 * token value comes from main via `window.rook.getBridgeToken()`; main
 * passes the same value to the spawned backend through the
 * `ROOK_BRIDGE_TOKEN` env var. See `backend/src/BridgeServer.h` for the
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
  TRACK_REMOVE: TrackRemovePayload
  TRACK_GAIN: TrackGainPayload
  TRANSPORT_PLAY: undefined
  TRANSPORT_PAUSE: undefined
  TRANSPORT_STOP: undefined
  TRANSPORT_SEEK: TransportSeekPayload
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
  filePath: string
  ok: boolean
  /**
   * Backend-supplied error message. Present iff `ok === false`.
   * Surfaced through `notificationsStore.pushError(...)` in the renderer.
   */
  error?: string
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

export interface BridgeInboundMap {
  READY: ReadyPayload
  PLAYHEAD_UPDATE: PlayheadUpdatePayload
  CLIP_ADDED: ClipAckPayload
  CLIP_ADD_FAILED: ClipAckPayload
  TRACK_REMOVED: TrackRemovedPayload
  TRACK_GAIN_APPLIED: TrackGainAppliedPayload
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
  'PLAYHEAD_UPDATE',
  'CLIP_ADDED',
  'CLIP_ADD_FAILED',
  'TRACK_REMOVED',
  'TRACK_GAIN_APPLIED'
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
    typeof value.filePath === 'string' &&
    typeof value.ok === 'boolean' &&
    (value.error === undefined || typeof value.error === 'string')
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
