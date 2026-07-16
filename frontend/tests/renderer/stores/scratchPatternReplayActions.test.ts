import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/bridgeService', () => ({
  send: vi.fn()
}))
vi.mock('@/lib/log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { send as sendBridge } from '@/lib/bridgeService'
import { scratchPatternActions } from '@/stores/scratchPatternActions'
import {
  SCRATCH_CROSSFADER_CURVE_VERSION,
  SCRATCH_PATTERN_VERSION,
  SCRATCH_PROTOCOL_VERSION,
  type ScratchPattern
} from '@shared/bridge-protocol'

const mockSend = vi.mocked(sendBridge)

describe('scratchPatternActions - replay', () => {
  beforeEach(() => {
    mockSend.mockClear()
  })

  const actionsContext = { savedScratchPatterns: [] }
  const draftPattern: ScratchPattern = {
    id: 'draft-1',
    name: 'Draft',
    version: SCRATCH_PATTERN_VERSION,
    durationUs: 1000,
    cropStartUs: 0,
    cropEndUs: 1000,
    sourceOffsetTurns: 0,
    ownerDeck: 1,
    crossfaderCurve: SCRATCH_CROSSFADER_CURVE_VERSION,
    platter: [
      { timeUs: 0, turns: 0, touched: false },
      { timeUs: 1000, turns: 0.001, touched: false }
    ],
    crossfader: [
      { timeUs: 0, value: 0 },
      { timeUs: 1000, value: 0 }
    ]
  }

  it('applyScratchPattern sends SCRATCH_PATTERN_APPLY', () => {
    scratchPatternActions.applyScratchPattern.call(actionsContext, 'clip-1', 'sp-1')
    expect(mockSend).toHaveBeenCalledWith('SCRATCH_PATTERN_APPLY', {
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      clipId: 'clip-1',
      patternId: 'sp-1'
    })
  })

  it('removeScratchPattern sends SCRATCH_PATTERN_REMOVE', () => {
    scratchPatternActions.removeScratchPattern.call(actionsContext, 'clip-1')
    expect(mockSend).toHaveBeenCalledWith('SCRATCH_PATTERN_REMOVE', {
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      clipId: 'clip-1'
    })
  })

  it('startPatternReplay sends SCRATCH_PATTERN_REPLAY_START', () => {
    scratchPatternActions.startPatternReplay.call(actionsContext, 'sp-1')
    expect(mockSend).toHaveBeenCalledWith('SCRATCH_PATTERN_REPLAY_START', {
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      patternId: 'sp-1'
    })
  })

  it('startPatternReplay sends the current draft', () => {
    scratchPatternActions.startPatternReplay.call(actionsContext, draftPattern)
    expect(mockSend).toHaveBeenCalledWith('SCRATCH_PATTERN_REPLAY_START', {
      protocolVersion: SCRATCH_PROTOCOL_VERSION,
      pattern: draftPattern
    })
  })

  it('stopPatternReplay sends SCRATCH_PATTERN_REPLAY_STOP', () => {
    scratchPatternActions.stopPatternReplay.call(actionsContext)
    expect(mockSend).toHaveBeenCalledWith('SCRATCH_PATTERN_REPLAY_STOP', {
      protocolVersion: SCRATCH_PROTOCOL_VERSION
    })
  })
})
