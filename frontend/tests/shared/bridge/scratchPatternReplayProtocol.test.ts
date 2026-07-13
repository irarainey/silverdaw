import { describe, expect, it } from 'vitest'
import {
  SCRATCH_PROTOCOL_VERSION,
  ScratchPatternApplyPayloadSchema,
  ScratchPatternRemovePayloadSchema,
  ScratchPatternReplayStartPayloadSchema,
  ScratchPatternReplayStopPayloadSchema
} from '@shared/bridge-protocol'

describe('ScratchPatternApplyPayload schema', () => {
  it('accepts a valid apply payload', () => {
    const result = ScratchPatternApplyPayloadSchema.safeParse({
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      clipId: 'clip-1',
      patternId: 'sp-1'
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing clipId', () => {
    const result = ScratchPatternApplyPayloadSchema.safeParse({
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      patternId: 'sp-1'
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing patternId', () => {
    const result = ScratchPatternApplyPayloadSchema.safeParse({
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      clipId: 'clip-1'
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty clipId', () => {
    const result = ScratchPatternApplyPayloadSchema.safeParse({
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      clipId: '',
      patternId: 'sp-1'
    })
    expect(result.success).toBe(false)
  })
})

describe('ScratchPatternRemovePayload schema', () => {
  it('accepts a valid remove payload', () => {
    const result = ScratchPatternRemovePayloadSchema.safeParse({
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      clipId: 'clip-1'
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing clipId', () => {
    const result = ScratchPatternRemovePayloadSchema.safeParse({
      protocolVersion: SCRATCH_PROTOCOL_VERSION
    })
    expect(result.success).toBe(false)
  })
})

describe('ScratchPatternReplayStartPayload schema', () => {
  it('accepts a valid replay start payload', () => {
    const result = ScratchPatternReplayStartPayloadSchema.safeParse({
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      patternId: 'sp-1'
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing patternId', () => {
    const result = ScratchPatternReplayStartPayloadSchema.safeParse({
      protocolVersion: SCRATCH_PROTOCOL_VERSION
    })
    expect(result.success).toBe(false)
  })
})

describe('ScratchPatternReplayStopPayload schema', () => {
  it('accepts a valid replay stop payload', () => {
    const result = ScratchPatternReplayStopPayloadSchema.safeParse({
      protocolVersion: SCRATCH_PROTOCOL_VERSION
    })
    expect(result.success).toBe(true)
  })

  it('rejects wrong protocol version', () => {
    const result = ScratchPatternReplayStopPayloadSchema.safeParse({
      protocolVersion: 999
    })
    expect(result.success).toBe(false)
  })
})
