// Pure helpers for the Scratch Editor: visual angle derivation, pointer-to-turns
// conversion, crossfader value clamping, and typed SCRATCH_SESSION_CONTROL builders.
// All functions are stateless and allocation-free on the hot path.

import {
  SCRATCH_PROTOCOL_VERSION,
  MAX_SCRATCH_EVENT_DELTA_TURNS,
  type ScratchDeckSide,
  type ScratchSessionControlPayload,
  type ScratchBackingPreparePayload,
  type ScratchBackingClearPayload,
  type ScratchBackingStartAnchor,
  type ScratchBackingDurationSec
} from '@shared/bridge-protocol'

/** Virtual deck used by pointer-operated controls when no physical deck owns the session. */
export const VIRTUAL_DECK: ScratchDeckSide = 1

/**
 * Horizontal/vertical trackpad travel, in CSS pixels, that maps to one full
 * platter revolution. Tunable: lower = more sensitive scratching.
 */
export const WHEEL_PIXELS_PER_TURN = 600
const TRACKPAD_DEAD_ZONE_PX = 1
const TRACKPAD_MAX_GAIN = 1.5

/** Angle in degrees [0, 360) derived from absolute platter turns modulo one revolution. */
export function platterAngleDeg(turns: number): number {
  return (((turns % 1) + 1) % 1) * 360
}

/**
 * Signed angular delta in turns from two consecutive pointer positions relative
 * to a center point. Normalized to (−0.5, 0.5] so direction is unambiguous
 * through a 180° traversal.
 */
export function pointerAngleDeltaTurns(
  prevX: number,
  prevY: number,
  nextX: number,
  nextY: number,
  cx: number,
  cy: number
): number {
  const prevAngle = Math.atan2(prevY - cy, prevX - cx)
  const nextAngle = Math.atan2(nextY - cy, nextX - cx)
  let delta = nextAngle - prevAngle
  if (delta > Math.PI) delta -= 2 * Math.PI
  if (delta < -Math.PI) delta += 2 * Math.PI
  return delta / (2 * Math.PI)
}

/** Crossfader value [0, 1] after applying a raw horizontal pixel delta over a track. */
export function crossfaderValueFromHorizontalDelta(
  current: number,
  deltaX: number,
  trackWidth: number
): number {
  if (trackWidth <= 0) return current
  return Math.max(0, Math.min(1, current + deltaX / trackWidth))
}

/**
 * Turns delta from a trackpad gesture. Ignores small pointer jitter, uses the
 * dominant axis, and increases the response for larger movements.
 */
export function wheelDeltaToTurns(deltaX: number, deltaY: number, pixelsPerTurn: number): number {
  if (pixelsPerTurn <= 0) return 0
  const dominant = Math.abs(deltaX) >= Math.abs(deltaY) ? deltaX : deltaY
  const magnitude = Math.abs(dominant)
  if (magnitude <= TRACKPAD_DEAD_ZONE_PX) return 0
  const normalized = (magnitude - TRACKPAD_DEAD_ZONE_PX) / pixelsPerTurn
  const gain = 1 + Math.min(1, normalized) * (TRACKPAD_MAX_GAIN - 1)
  return Math.sign(dominant) * normalized * gain
}

/**
 * Crossfader display value for the momentary cut key: open = the deck's audible
 * edge, closed = its silent edge (deck 1 audible at 0, deck 2 audible at 1).
 */
export function crossfaderCutValue(open: boolean, deck: ScratchDeckSide = VIRTUAL_DECK): number {
  const audibleEdge = deck === 1 ? 0 : 1
  return open ? audibleEdge : 1 - audibleEdge
}

/** Visual coordinate for a virtual keyboard cut, mirrored from its audio value. */
export function virtualKeyboardCutDisplayValue(value: number): number {
  return 1 - Math.max(0, Math.min(1, value))
}

/** Formats a microsecond position as `M:SS.mmm` or `S.mmms` for transport display. */
export function formatUsTime(us: number): string {
  const totalMs = Math.max(0, us) / 1000
  const minutes = Math.floor(totalMs / 60_000)
  const seconds = Math.floor((totalMs % 60_000) / 1000)
  const ms = Math.floor(totalMs % 1000)
  if (minutes > 0) {
    return `${minutes}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
  }
  return `${seconds}.${String(ms).padStart(3, '0')}s`
}

export function buildPlatterMovePayload(
  sessionId: string,
  deck: ScratchDeckSide,
  deltaTurns: number,
  clientTimeMs?: number
): ScratchSessionControlPayload {
  const clamped = Math.max(
    -MAX_SCRATCH_EVENT_DELTA_TURNS,
    Math.min(MAX_SCRATCH_EVENT_DELTA_TURNS, deltaTurns)
  )
  return {
    protocolVersion: SCRATCH_PROTOCOL_VERSION,
    sessionId,
    action: 'platterMove',
    deck,
    deltaTurns: clamped,
    ...(clientTimeMs !== undefined && Number.isFinite(clientTimeMs) && clientTimeMs >= 0
      ? { clientTimeMs }
      : {})
  }
}

export function buildPlatterTouchPayload(
  sessionId: string,
  deck: ScratchDeckSide,
  touched: boolean
): ScratchSessionControlPayload {
  return { protocolVersion: SCRATCH_PROTOCOL_VERSION, sessionId, action: 'platterTouch', deck, touched }
}

export function buildCrossfaderPayload(
  sessionId: string,
  value: number
): ScratchSessionControlPayload {
  return {
    protocolVersion: SCRATCH_PROTOCOL_VERSION,
    sessionId,
    action: 'crossfader',
    value: Math.max(0, Math.min(1, value))
  }
}

export function buildBackingGainPayload(
  sessionId: string,
  value: number
): ScratchSessionControlPayload {
  return {
    protocolVersion: SCRATCH_PROTOCOL_VERSION,
    sessionId,
    action: 'backingGain',
    value: Math.max(0, Math.min(1, value))
  }
}

export function buildScratchGainPayload(
  sessionId: string,
  value: number
): ScratchSessionControlPayload {
  return {
    protocolVersion: SCRATCH_PROTOCOL_VERSION,
    sessionId,
    action: 'scratchGain',
    value: Math.max(0, Math.min(1, value))
  }
}

export function buildBackingLoopPayload(
  sessionId: string,
  enabled: boolean
): ScratchSessionControlPayload {
  return { protocolVersion: SCRATCH_PROTOCOL_VERSION, sessionId, action: 'backingLoop', enabled }
}

export function buildSeekPayload(
  sessionId: string,
  positionUs: number
): ScratchSessionControlPayload {
  return {
    protocolVersion: SCRATCH_PROTOCOL_VERSION,
    sessionId,
    action: 'seek',
    positionUs: Math.max(0, Math.round(positionUs))
  }
}

export function buildRecordStartPayload(sessionId: string): ScratchSessionControlPayload {
  return { protocolVersion: SCRATCH_PROTOCOL_VERSION, sessionId, action: 'recordStart' }
}

export function buildRecordStopPayload(sessionId: string): ScratchSessionControlPayload {
  return { protocolVersion: SCRATCH_PROTOCOL_VERSION, sessionId, action: 'recordStop' }
}

export function buildBackingPreparePayload(
  sessionId: string,
  trackIds: readonly string[],
  startAnchor: ScratchBackingStartAnchor,
  durationSec: ScratchBackingDurationSec
): ScratchBackingPreparePayload {
  return {
    protocolVersion: SCRATCH_PROTOCOL_VERSION,
    sessionId,
    trackIds: [...trackIds],
    startAnchor,
    durationSec
  }
}

export function buildBackingClearPayload(sessionId: string): ScratchBackingClearPayload {
  return { protocolVersion: SCRATCH_PROTOCOL_VERSION, sessionId }
}
