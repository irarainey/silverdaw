import { describe, expect, it } from 'vitest'
import {
  isBridgeInboundType,
  isClipAckPayload,
  isPlayheadUpdatePayload,
  isReadyPayload,
  isTrackGainAppliedPayload,
  isTrackRemovedPayload
} from './bridge-protocol'

describe('isBridgeInboundType', () => {
  it('accepts every inbound type', () => {
    for (const t of [
      'READY',
      'PLAYHEAD_UPDATE',
      'CLIP_ADDED',
      'CLIP_ADD_FAILED',
      'TRACK_REMOVED',
      'TRACK_GAIN_APPLIED'
    ]) {
      expect(isBridgeInboundType(t)).toBe(true)
    }
  })

  it('rejects unknown strings', () => {
    expect(isBridgeInboundType('NOT_REAL')).toBe(false)
  })

  it('rejects non-strings', () => {
    expect(isBridgeInboundType(42)).toBe(false)
    expect(isBridgeInboundType(null)).toBe(false)
    expect(isBridgeInboundType(undefined)).toBe(false)
  })
})

describe('isReadyPayload', () => {
  it('accepts a well-shaped payload', () => {
    expect(isReadyPayload({ version: '0.1.0' })).toBe(true)
  })

  it('rejects missing or wrong-typed version', () => {
    expect(isReadyPayload({})).toBe(false)
    expect(isReadyPayload({ version: 1 })).toBe(false)
  })
})

describe('isPlayheadUpdatePayload', () => {
  it('accepts a well-shaped payload', () => {
    expect(isPlayheadUpdatePayload({ positionMs: 0, isPlaying: false })).toBe(true)
  })

  it('rejects missing fields', () => {
    expect(isPlayheadUpdatePayload({ positionMs: 0 })).toBe(false)
    expect(isPlayheadUpdatePayload({ isPlaying: false })).toBe(false)
  })

  it('rejects wrong-typed fields', () => {
    expect(isPlayheadUpdatePayload({ positionMs: '0', isPlaying: false })).toBe(false)
  })
})

describe('isClipAckPayload', () => {
  it('accepts a success ack (no error field)', () => {
    expect(isClipAckPayload({ trackId: 't1', filePath: '/p', ok: true })).toBe(true)
  })

  it('accepts a failure ack with an error string', () => {
    expect(isClipAckPayload({ trackId: 't1', filePath: '/p', ok: false, error: 'boom' })).toBe(true)
  })

  it('rejects an ack with a non-string error', () => {
    expect(isClipAckPayload({ trackId: 't1', filePath: '/p', ok: false, error: 42 })).toBe(false)
  })

  it('rejects missing required fields', () => {
    expect(isClipAckPayload({ filePath: '/p', ok: true })).toBe(false)
    expect(isClipAckPayload({ trackId: 't1', ok: true })).toBe(false)
    expect(isClipAckPayload({ trackId: 't1', filePath: '/p' })).toBe(false)
  })
})

describe('isTrackRemovedPayload', () => {
  it('accepts a well-shaped payload', () => {
    expect(isTrackRemovedPayload({ trackId: 't1', ok: true })).toBe(true)
    expect(isTrackRemovedPayload({ trackId: 't1', ok: false })).toBe(true)
  })

  it('rejects missing or wrong-typed fields', () => {
    expect(isTrackRemovedPayload({ trackId: 't1' })).toBe(false)
    expect(isTrackRemovedPayload({ ok: true })).toBe(false)
    expect(isTrackRemovedPayload({ trackId: 1, ok: true })).toBe(false)
    expect(isTrackRemovedPayload({ trackId: 't1', ok: 'yes' })).toBe(false)
  })
})

describe('isTrackGainAppliedPayload', () => {
  it('accepts a well-shaped payload', () => {
    expect(isTrackGainAppliedPayload({ trackId: 't1', gain: 0.5, ok: true })).toBe(true)
    expect(isTrackGainAppliedPayload({ trackId: 't1', gain: 0, ok: false })).toBe(true)
  })

  it('rejects missing or wrong-typed fields', () => {
    expect(isTrackGainAppliedPayload({ trackId: 't1', gain: 0.5 })).toBe(false)
    expect(isTrackGainAppliedPayload({ trackId: 't1', ok: true })).toBe(false)
    expect(isTrackGainAppliedPayload({ gain: 0.5, ok: true })).toBe(false)
    expect(isTrackGainAppliedPayload({ trackId: 't1', gain: '0.5', ok: true })).toBe(false)
  })
})
