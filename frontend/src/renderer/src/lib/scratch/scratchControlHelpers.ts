// Pure helpers for the Scratch Editor: visual angle derivation, pointer-to-turns
// conversion, crossfader value clamping, and typed SCRATCH_SESSION_CONTROL builders.
// All functions are stateless and allocation-free on the hot path.

import {
  SCRATCH_PROTOCOL_VERSION,
  MAX_SCRATCH_EVENT_DELTA_TURNS,
  type ScratchDeckSide,
  type ScratchSessionControlPayload
} from '@shared/bridge-protocol'

/** Virtual deck used by pointer-operated controls when no physical deck owns the session. */
export const VIRTUAL_DECK: ScratchDeckSide = 1

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
  deltaTurns: number
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
    deltaTurns: clamped
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

export function buildRecordStartPayload(sessionId: string): ScratchSessionControlPayload {
  return { protocolVersion: SCRATCH_PROTOCOL_VERSION, sessionId, action: 'recordStart' }
}

export function buildRecordStopPayload(sessionId: string): ScratchSessionControlPayload {
  return { protocolVersion: SCRATCH_PROTOCOL_VERSION, sessionId, action: 'recordStop' }
}
