import { describe, expect, it } from 'vitest'
import {
  SCRATCH_PROTOCOL_VERSION,
  SCRATCH_PATTERN_VERSION,
  SCRATCH_CROSSFADER_CURVE_VERSION,
  ScratchPatternSavePayloadSchema,
  ScratchPatternDeletePayloadSchema,
  ScratchPatternRenamePayloadSchema
} from '@shared/bridge-protocol'

function makePattern() {
  return {
    id: 'sp-1',
    name: 'Test',
    version: SCRATCH_PATTERN_VERSION,
    durationUs: 1_000_000,
    cropStartUs: 0,
    cropEndUs: 1_000_000,
    sourceOffsetTurns: 0,
    ownerDeck: 1 as const,
    crossfaderCurve: SCRATCH_CROSSFADER_CURVE_VERSION,
    platter: [
      { timeUs: 0, turns: 0, touched: true },
      { timeUs: 1_000_000, turns: 1, touched: false }
    ],
    crossfader: [
      { timeUs: 0, value: 0 },
      { timeUs: 1_000_000, value: 1 }
    ]
  }
}

describe('ScratchPatternSavePayload schema', () => {
  it('accepts a valid save payload', () => {
    const result = ScratchPatternSavePayloadSchema.safeParse({
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      sessionId: 'session-1',
      pattern: makePattern()
    })
    expect(result.success).toBe(true)
  })

  it('rejects when protocolVersion is wrong', () => {
    const result = ScratchPatternSavePayloadSchema.safeParse({
      protocolVersion: 2,
      sessionId: 'session-1',
      pattern: makePattern()
    })
    expect(result.success).toBe(false)
  })

  it('rejects when sessionId is empty', () => {
    const result = ScratchPatternSavePayloadSchema.safeParse({
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      sessionId: '',
      pattern: makePattern()
    })
    expect(result.success).toBe(false)
  })

  it('rejects when pattern fails ScratchPatternSchema invariants', () => {
    const badPattern = makePattern()
    // Platter must start at timeUs=0; use a non-zero first timestamp to trigger invariant.
    badPattern.platter = [
      { timeUs: 100, turns: 0, touched: true },
      { timeUs: 1_000_000, turns: 1, touched: false }
    ]
    const result = ScratchPatternSavePayloadSchema.safeParse({
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      sessionId: 'session-1',
      pattern: badPattern
    })
    expect(result.success).toBe(false)
  })

  it('rejects when pattern field is missing', () => {
    const result = ScratchPatternSavePayloadSchema.safeParse({
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      sessionId: 'session-1'
    })
    expect(result.success).toBe(false)
  })
})

describe('ScratchPatternDeletePayload schema', () => {
  it('accepts a valid delete payload', () => {
    const result = ScratchPatternDeletePayloadSchema.safeParse({
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      patternId: 'sp-1'
    })
    expect(result.success).toBe(true)
  })

  it('rejects when protocolVersion is wrong', () => {
    const result = ScratchPatternDeletePayloadSchema.safeParse({
      protocolVersion: 99,
      patternId: 'sp-1'
    })
    expect(result.success).toBe(false)
  })

  it('rejects when patternId is empty', () => {
    const result = ScratchPatternDeletePayloadSchema.safeParse({
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      patternId: ''
    })
    expect(result.success).toBe(false)
  })

  it('rejects when patternId is missing', () => {
    const result = ScratchPatternDeletePayloadSchema.safeParse({
      protocolVersion: SCRATCH_PROTOCOL_VERSION
    })
    expect(result.success).toBe(false)
  })
})

describe('ScratchPatternRenamePayload schema', () => {
  it('accepts a valid rename payload', () => {
    const result = ScratchPatternRenamePayloadSchema.safeParse({
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      patternId: 'sp-1',
      name: 'New Name'
    })
    expect(result.success).toBe(true)
  })

  it('rejects when protocolVersion is wrong', () => {
    const result = ScratchPatternRenamePayloadSchema.safeParse({
      protocolVersion: 0,
      patternId: 'sp-1',
      name: 'New Name'
    })
    expect(result.success).toBe(false)
  })

  it('rejects when patternId is empty', () => {
    const result = ScratchPatternRenamePayloadSchema.safeParse({
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      patternId: '',
      name: 'New Name'
    })
    expect(result.success).toBe(false)
  })

  it('rejects when name is empty', () => {
    const result = ScratchPatternRenamePayloadSchema.safeParse({
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      patternId: 'sp-1',
      name: ''
    })
    expect(result.success).toBe(false)
  })

  it('rejects when name is missing', () => {
    const result = ScratchPatternRenamePayloadSchema.safeParse({
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      patternId: 'sp-1'
    })
    expect(result.success).toBe(false)
  })
})
