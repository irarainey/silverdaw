import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/bridgeService', () => ({
  send: vi.fn()
}))
vi.mock('@/lib/log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { send as sendBridge } from '@/lib/bridgeService'
import { scratchPatternActions } from '@/stores/scratchPatternActions'
import { SCRATCH_PROTOCOL_VERSION } from '@shared/bridge-protocol'

const mockSend = vi.mocked(sendBridge)

describe('scratchPatternActions - replay', () => {
  beforeEach(() => {
    mockSend.mockClear()
  })

  const actionsContext = { savedScratchPatterns: [] }

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

  it('stopPatternReplay sends SCRATCH_PATTERN_REPLAY_STOP', () => {
    scratchPatternActions.stopPatternReplay.call(actionsContext)
    expect(mockSend).toHaveBeenCalledWith('SCRATCH_PATTERN_REPLAY_STOP', {
      protocolVersion: SCRATCH_PROTOCOL_VERSION
    })
  })
})
