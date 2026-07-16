import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useScratchPointerDispatch } from '@/lib/scratch/useScratchPointerDispatch'
import { VIRTUAL_DECK } from '@/lib/scratch/scratchControlHelpers'

function setup(overrides: { activeSessionId?: string | null; controlsEnabled?: boolean } = {}) {
  const activeSessionId = ref('activeSessionId' in overrides ? overrides.activeSessionId ?? null : 'sid-1')
  const controlsEnabled = ref(overrides.controlsEnabled ?? true)
  const sendControl = vi.fn()

  const dispatch = useScratchPointerDispatch({ activeSessionId, controlsEnabled, sendControl })
  return { dispatch, activeSessionId, controlsEnabled, sendControl }
}

describe('useScratchPointerDispatch', () => {
  it('sends a platter touch payload for the virtual deck when controls are enabled', () => {
    const { dispatch, sendControl } = setup()
    dispatch.onPlatterTouch(true)
    expect(sendControl).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sid-1', deck: VIRTUAL_DECK, action: 'platterTouch', touched: true })
    )
  })

  it('sends a platter move payload with the delta and client time', () => {
    const { dispatch, sendControl } = setup()
    dispatch.onPlatterMove(0.25, 1234)
    expect(sendControl).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sid-1', deck: VIRTUAL_DECK, action: 'platterMove', deltaTurns: 0.25 })
    )
  })

  it('sends a crossfader payload with the given value', () => {
    const { dispatch, sendControl } = setup()
    dispatch.onCrossfaderChange(0.75)
    expect(sendControl).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sid-1', action: 'crossfader', value: 0.75 })
    )
  })

  it('drops all input while controlsEnabled is false (replay gating)', () => {
    const { dispatch, sendControl } = setup({ controlsEnabled: false })
    dispatch.onPlatterTouch(true)
    dispatch.onPlatterMove(0.1, 0)
    dispatch.onCrossfaderChange(0.5)
    expect(sendControl).not.toHaveBeenCalled()
  })

  it('drops all input when there is no active session', () => {
    const { dispatch, sendControl } = setup({ activeSessionId: null })
    dispatch.onPlatterTouch(true)
    dispatch.onPlatterMove(0.1, 0)
    dispatch.onCrossfaderChange(0.5)
    expect(sendControl).not.toHaveBeenCalled()
  })
})
