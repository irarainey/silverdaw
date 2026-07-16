// Momentary crossfader "cut" driven by a single configurable key (Z or M).
// The resting default is closed (deck silent); holding the key opens the fader
// (deck audible) and releasing it closes again — the press is akin to swinging
// the fader in. The closed default is asserted when the session becomes
// controllable so the visible fader and audio agree before any key is pressed.
// Blur/unmount force the fader back closed so a held key can never leave the
// deck stuck open.
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
}

export interface ScratchKeyboardCutController {
  handleKeyDown(event: { code: string; repeat: boolean }): void
  handleKeyUp(event: { code: string }): void
  applyRestingClosed(): void
  forceClosed(): void
}

/**
 * Stateful key→crossfader mapper. Tracks whether the cut is currently open so
 * auto-repeat is ignored, key-up only closes a fader it actually opened, and
 * activation/blur/unmount can settle the fader back to its closed resting state.
 */
export function createScratchKeyboardCutController(
  options: ScratchKeyboardCutOptions
): ScratchKeyboardCutController {
  const { getCutKey, getDeck, getSessionId, canControl, sendControl } = options
  let opened = false

  function sendCut(open: boolean): void {
    const sid = getSessionId()
    if (!sid || !canControl()) return
    sendControl(buildCrossfaderPayload(sid, crossfaderCutValue(open, getDeck())))
  }

  return {
    handleKeyDown(event): void {
      if (event.repeat || event.code !== getCutKey() || opened) return
      opened = true
      sendCut(true)
    },
    handleKeyUp(event): void {
      if (event.code !== getCutKey() || !opened) return
      opened = false
      sendCut(false)
    },
    applyRestingClosed(): void {
      opened = false
      sendCut(false)
    },
    forceClosed(): void {
      if (!opened) return
      opened = false
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
}

export function useScratchKeyboardControls(options: ScratchKeyboardControlsOptions): void {
  const { activeSessionId, canControl, selectedDeck, sendControl, buildBacking } = options
  const inputSettings = useScratchInputSettingsStore()

  const controller = createScratchKeyboardCutController({
    getCutKey: () => inputSettings.crossfaderCutKey,
    getDeck: () => selectedDeck.value ?? VIRTUAL_DECK,
    getSessionId: () => activeSessionId.value,
    canControl: () => canControl.value,
    sendControl
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
    if (event.code === inputSettings.crossfaderCutKey) {
      // Swallow every auto-repeat while held. The controller only sends the
      // opening edge once, but letting repeated key events reach the browser
      // and dialog handlers makes pointer interaction sluggish.
      event.preventDefault()
      event.stopPropagation()
    }
    controller.handleKeyDown(event)
  }
  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === inputSettings.crossfaderCutKey) {
      event.preventDefault()
      event.stopPropagation()
    }
    controller.handleKeyUp(event)
  }
  const onBlur = (): void => controller.forceClosed()

  // Settle the fader to its closed resting default once the session is
  // controllable, so the visible fader and audio start in agreement.
  watch(
    () => canControl.value && activeSessionId.value !== null,
    (ready) => {
      if (ready) controller.applyRestingClosed()
    },
    { immediate: true }
  )

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
    controller.forceClosed()
  })
}
