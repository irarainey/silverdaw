import { describe, expect, it, vi } from 'vitest'
import { createScratchKeyboardCutController } from '@/lib/scratch/useScratchKeyboardControls'
import type { ScratchDeckSide, ScratchSessionControlPayload } from '@shared/bridge-protocol'
import type { ScratchCrossfaderCutKeyDto } from '@shared/types'

function setup(
  cutKey: ScratchCrossfaderCutKeyDto = 'KeyZ',
  overrides: { sessionId?: string | null; canControl?: boolean; deck?: ScratchDeckSide } = {}
) {
  const sendControl = vi.fn<(payload: ScratchSessionControlPayload) => void>()
  const state = {
    cutKey,
    deck: overrides.deck ?? 1,
    sessionId: 'sessionId' in overrides ? (overrides.sessionId ?? null) : 'sid-1',
    canControl: overrides.canControl ?? true
  }
  const controller = createScratchKeyboardCutController({
    getCutKey: () => state.cutKey,
    getDeck: () => state.deck,
    getSessionId: () => state.sessionId,
    canControl: () => state.canControl,
    sendControl
  })
  return { controller, sendControl, state }
}

describe('createScratchKeyboardCutController', () => {
  it('toggles the fader on each cut-key press', () => {
    const { controller, sendControl } = setup('KeyZ')

    controller.handleKeyDown({ code: 'KeyZ', repeat: false })
    expect(sendControl).toHaveBeenCalledTimes(1)
    expect(sendControl).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ action: 'crossfader', value: 1 })
    )

    controller.handleKeyDown({ code: 'KeyZ', repeat: false })
    expect(sendControl).toHaveBeenCalledTimes(2)
    expect(sendControl).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ action: 'crossfader', value: 0 })
    )
  })

  it('honours the configured cut key and ignores others', () => {
    const { controller, sendControl } = setup('KeyM')

    controller.handleKeyDown({ code: 'KeyZ', repeat: false })
    controller.handleKeyDown({ code: 'Space', repeat: false })
    expect(sendControl).not.toHaveBeenCalled()

    controller.handleKeyDown({ code: 'KeyM', repeat: false })
    expect(sendControl).toHaveBeenCalledTimes(1)
    expect(sendControl).toHaveBeenNthCalledWith(1, expect.objectContaining({ value: 1 }))
  })

  it('toggles the selected right deck at its matching fader edges', () => {
    const { controller, sendControl } = setup('KeyZ', { deck: 2 })

    controller.handleKeyDown({ code: 'KeyZ', repeat: false })
    controller.handleKeyDown({ code: 'KeyZ', repeat: false })

    expect(sendControl).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ action: 'crossfader', value: 0 })
    )
    expect(sendControl).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ action: 'crossfader', value: 1 })
    )
  })

  it('ignores auto-repeat key-down events', () => {
    const { controller, sendControl } = setup('KeyZ')

    controller.handleKeyDown({ code: 'KeyZ', repeat: false })
    controller.handleKeyDown({ code: 'KeyZ', repeat: true })
    controller.handleKeyDown({ code: 'KeyZ', repeat: true })
    expect(sendControl).toHaveBeenCalledTimes(1)
  })

  it('does not send while the session cannot be controlled', () => {
    const { controller, sendControl } = setup('KeyZ', { canControl: false })

    controller.handleKeyDown({ code: 'KeyZ', repeat: false })
    expect(sendControl).not.toHaveBeenCalled()
  })

  it('does not send without an active session id', () => {
    const { controller, sendControl } = setup('KeyZ', { sessionId: null })

    controller.handleKeyDown({ code: 'KeyZ', repeat: false })
    expect(sendControl).not.toHaveBeenCalled()
  })

  it('settles the fader to its open resting default on activation', () => {
    const { controller, sendControl } = setup('KeyZ')

    controller.applyRestingOpen()
    expect(sendControl).toHaveBeenCalledTimes(1)
    expect(sendControl).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ action: 'crossfader', value: 0 })
    )

  })

  it('reports a cut value for an immediate visual update after sending it', () => {
    const onCutValueChange = vi.fn()
    const { sendControl } = setup('KeyZ')
    const visualController = createScratchKeyboardCutController({
      getCutKey: () => 'KeyZ',
      getDeck: () => 1,
      getSessionId: () => 'sid-1',
      canControl: () => true,
      sendControl,
      onCutValueChange
    })

    visualController.handleKeyDown({ code: 'KeyZ', repeat: false })
    expect(onCutValueChange).toHaveBeenCalledWith(1)
  })

})
