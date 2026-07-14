// Momentary crossfader "cut" driven by a single configurable key (Z or M).
// Holding the key closes the fader (deck silent); releasing it reopens.
// The resting default is open, matching the deck's neutral state, so nothing is
// sent until the key is first pressed. Blur/unmount force the fader open so a
// held key can never leave the deck stuck silent.
//
// The stateful key→crossfader mapping lives in a pure controller so it is unit
// testable without a DOM; the composable is only the Vue lifecycle + window glue.

import { onBeforeUnmount, onMounted } from 'vue'
import type { Ref } from 'vue'
import type { ScratchSessionControlPayload } from '@shared/bridge-protocol'
import type { ScratchCrossfaderCutKeyDto } from '@shared/types'
import { useScratchInputSettingsStore } from '@/stores/scratchInputSettingsStore'
import { buildCrossfaderPayload, crossfaderCutValue, VIRTUAL_DECK } from './scratchControlHelpers'

interface ScratchKeyboardCutOptions {
  getCutKey: () => ScratchCrossfaderCutKeyDto
  getSessionId: () => string | null
  canControl: () => boolean
  sendControl: (payload: ScratchSessionControlPayload) => void
}

export interface ScratchKeyboardCutController {
  handleKeyDown(event: { code: string; repeat: boolean }): void
  handleKeyUp(event: { code: string }): void
  forceOpen(): void
}

/**
 * Stateful key→crossfader mapper. Tracks whether the cut is currently closed so
 * auto-repeat is ignored, key-up only reopens a fader it actually closed, and
 * blur/unmount can force the fader back open exactly once.
 */
export function createScratchKeyboardCutController(
  options: ScratchKeyboardCutOptions
): ScratchKeyboardCutController {
  const { getCutKey, getSessionId, canControl, sendControl } = options
  let closed = false

  function sendCut(open: boolean): void {
    const sid = getSessionId()
    if (!sid || !canControl()) return
    sendControl(buildCrossfaderPayload(sid, crossfaderCutValue(open, VIRTUAL_DECK)))
  }

  return {
    handleKeyDown(event): void {
      if (event.repeat || event.code !== getCutKey() || closed) return
      closed = true
      sendCut(false)
    },
    handleKeyUp(event): void {
      if (event.code !== getCutKey() || !closed) return
      closed = false
      sendCut(true)
    },
    forceOpen(): void {
      if (!closed) return
      closed = false
      sendCut(true)
    }
  }
}

interface ScratchKeyboardControlsOptions {
  activeSessionId: Ref<string | null>
  canControl: Ref<boolean>
  sendControl: (payload: ScratchSessionControlPayload) => void
}

export function useScratchKeyboardControls(options: ScratchKeyboardControlsOptions): void {
  const { activeSessionId, canControl, sendControl } = options
  const inputSettings = useScratchInputSettingsStore()

  const controller = createScratchKeyboardCutController({
    getCutKey: () => inputSettings.crossfaderCutKey,
    getSessionId: () => activeSessionId.value,
    canControl: () => canControl.value,
    sendControl
  })

  const onKeyDown = (event: KeyboardEvent): void => controller.handleKeyDown(event)
  const onKeyUp = (event: KeyboardEvent): void => controller.handleKeyUp(event)
  const onBlur = (): void => controller.forceOpen()

  onMounted(() => {
    void inputSettings.hydrate()
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', onBlur)
    controller.forceOpen()
  })
}
