// Toggle crossfader cut driven by a single configurable key (Z or M). The
// resting default is open (deck audible); each press switches the fader between
// open and closed. The open default is asserted when the virtual fallback
// becomes controllable so the visible fader and audio agree before any key is
// pressed.
//
// This is the keyboard/trackpad path only; it never touches the MIDI crossfader
// controls, which own their own direction and gain handling.
//
// The stateful key→crossfader mapping lives in a pure controller so it is unit
// testable without a DOM; the composable is only the Vue lifecycle + window glue.

import { onBeforeUnmount, onMounted, watch } from 'vue'
import type { Ref } from 'vue'
import type { ScratchDeckSide, ScratchSessionControlPayload } from '@shared/bridge-protocol'
import type { ScratchCrossfaderCutKeyDto } from '@shared/types'
import { useScratchInputSettingsStore } from '@/stores/scratchInputSettingsStore'
import { buildCrossfaderPayload, crossfaderCutValue, VIRTUAL_DECK } from './scratchControlHelpers'

interface ScratchKeyboardCutOptions {
  getCutKey: () => ScratchCrossfaderCutKeyDto
  getDeck: () => ScratchDeckSide
  getSessionId: () => string | null
  canControl: () => boolean
  sendControl: (payload: ScratchSessionControlPayload) => void
  onCutValueChange?: (value: number) => void
}

export interface ScratchKeyboardCutController {
  handleKeyDown(event: { code: string; repeat: boolean }): void
  applyRestingOpen(): void
}

/**
 * Stateful key→crossfader mapper. Tracks whether the cut is currently closed so
 * each non-repeating key-down toggles its state and activation can settle the
 * fader back to its open resting state.
 */
export function createScratchKeyboardCutController(
  options: ScratchKeyboardCutOptions
): ScratchKeyboardCutController {
  const { getCutKey, getDeck, getSessionId, canControl, sendControl, onCutValueChange } = options
  let closed = false

  function sendCut(shouldClose: boolean): boolean {
    const sid = getSessionId()
    if (!sid || !canControl()) return false
    const value = crossfaderCutValue(!shouldClose, getDeck())
    sendControl(buildCrossfaderPayload(sid, value))
    onCutValueChange?.(value)
    return true
  }

  return {
    handleKeyDown(event): void {
      if (event.repeat || event.code !== getCutKey()) return
      const nextClosed = !closed
      if (sendCut(nextClosed)) closed = nextClosed
    },
    applyRestingOpen(): void {
      closed = false
      sendCut(false)
    }
  }
}

interface ScratchKeyboardControlsOptions {
  activeSessionId: Ref<string | null>
  canControl: Ref<boolean>
  selectedDeck: Ref<ScratchDeckSide | null | undefined>
  sendControl: (payload: ScratchSessionControlPayload) => void
  buildBacking: () => void
  onCrossfaderCutValueChange?: (value: number) => void
}

export function useScratchKeyboardControls(options: ScratchKeyboardControlsOptions): void {
  const {
    activeSessionId,
    canControl,
    selectedDeck,
    sendControl,
    buildBacking,
    onCrossfaderCutValueChange
  } = options
  const inputSettings = useScratchInputSettingsStore()

  const controller = createScratchKeyboardCutController({
    getCutKey: () => inputSettings.crossfaderCutKey,
    getDeck: () => selectedDeck.value ?? VIRTUAL_DECK,
    getSessionId: () => activeSessionId.value,
    canControl: () => canControl.value,
    sendControl,
    onCutValueChange: onCrossfaderCutValueChange
  })

  const onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target
    const editingText = target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement
      || (target instanceof HTMLElement && target.isContentEditable)
    if (event.code === 'KeyB' && !event.repeat && !editingText) {
      event.preventDefault()
      buildBacking()
      return
    }
    if (event.code === inputSettings.crossfaderCutKey && !event.repeat) {
      event.preventDefault()
      event.stopPropagation()
      controller.handleKeyDown(event)
      return
    }
    controller.handleKeyDown(event)
  }

  // Settle the fader to its open resting default once the virtual fallback is
  // controllable, so the visible fader and audio start in agreement.
  watch(
    () => canControl.value && activeSessionId.value !== null,
    (ready) => {
      if (ready) controller.applyRestingOpen()
    },
    { immediate: true }
  )

  onMounted(() => {
    void inputSettings.hydrate()
    window.addEventListener('keydown', onKeyDown)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeyDown)
  })
}
