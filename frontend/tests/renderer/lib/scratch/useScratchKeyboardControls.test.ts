import { describe, expect, it, vi } from 'vitest'
import { createScratchKeyboardCutController } from '@/lib/scratch/useScratchKeyboardControls'
import type { ScratchSessionControlPayload } from '@shared/bridge-protocol'
import type { ScratchCrossfaderCutKeyDto } from '@shared/types'

function setup(
  cutKey: ScratchCrossfaderCutKeyDto = 'KeyZ',
  overrides: { sessionId?: string | null; canControl?: boolean } = {}
) {
  const sendControl = vi.fn<(payload: ScratchSessionControlPayload) => void>()
  const state = {
    cutKey,
    sessionId: 'sessionId' in overrides ? (overrides.sessionId ?? null) : 'sid-1',
    canControl: overrides.canControl ?? true
  }
  const controller = createScratchKeyboardCutController({
    getCutKey: () => state.cutKey,
    getSessionId: () => state.sessionId,
    canControl: () => state.canControl,
    sendControl
  })
  return { controller, sendControl, state }
}

describe('createScratchKeyboardCutController', () => {
  it('closes the fader on cut-key down and reopens on key up', () => {
    const { controller, sendControl } = setup('KeyZ')

    controller.handleKeyDown({ code: 'KeyZ', repeat: false })
    expect(sendControl).toHaveBeenCalledTimes(1)
    expect(sendControl).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ action: 'crossfader', value: 1 })
    )

    controller.handleKeyUp({ code: 'KeyZ' })
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

  it('ignores auto-repeat key-down events', () => {
    const { controller, sendControl } = setup('KeyZ')

    controller.handleKeyDown({ code: 'KeyZ', repeat: false })
    controller.handleKeyDown({ code: 'KeyZ', repeat: true })
    controller.handleKeyDown({ code: 'KeyZ', repeat: true })
    expect(sendControl).toHaveBeenCalledTimes(1)
  })

  it('does not reopen on a key-up it never closed', () => {
    const { controller, sendControl } = setup('KeyZ')

    controller.handleKeyUp({ code: 'KeyZ' })
    expect(sendControl).not.toHaveBeenCalled()
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

  it('forces the fader open exactly once while the key is held', () => {
    const { controller, sendControl } = setup('KeyZ')

    controller.handleKeyDown({ code: 'KeyZ', repeat: false })
    controller.forceOpen()
    expect(sendControl).toHaveBeenCalledTimes(2)
    expect(sendControl).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ action: 'crossfader', value: 0 })
    )

    // A later key-up must not re-open — state was already reset by forceOpen.
    controller.handleKeyUp({ code: 'KeyZ' })
    expect(sendControl).toHaveBeenCalledTimes(2)
  })

  it('forceOpen is a no-op when the fader is already open', () => {
    const { controller, sendControl } = setup('KeyZ')

    controller.forceOpen()
    expect(sendControl).not.toHaveBeenCalled()
  })
})
