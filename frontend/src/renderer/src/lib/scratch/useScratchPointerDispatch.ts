// Platter/crossfader pointer control dispatch: routes local pointer-operated
// control input to the active scratch session, gated by whether local input is
// currently allowed (blocked during pattern replay — see useScratchReplay).

import type { Ref } from 'vue'
import type { ScratchSessionControlPayload } from '@shared/bridge-protocol'
import {
  buildCrossfaderPayload,
  buildPlatterMovePayload,
  buildPlatterTouchPayload,
  VIRTUAL_DECK
} from './scratchControlHelpers'

export interface ScratchPointerDispatchOptions {
  activeSessionId: Ref<string | null>
  controlsEnabled: Ref<boolean>
  sendControl(payload: ScratchSessionControlPayload): void
}

export interface ScratchPointerDispatch {
  onPlatterTouch(touched: boolean): void
  onPlatterMove(deltaTurns: number, clientTimeMs: number): void
  onCrossfaderChange(value: number): void
}

export function useScratchPointerDispatch(
  options: ScratchPointerDispatchOptions
): ScratchPointerDispatch {
  const { activeSessionId, controlsEnabled, sendControl } = options

  function onPlatterTouch(touched: boolean): void {
    const sid = activeSessionId.value
    if (!sid || !controlsEnabled.value) return
    sendControl(buildPlatterTouchPayload(sid, VIRTUAL_DECK, touched))
  }

  function onPlatterMove(deltaTurns: number, clientTimeMs: number): void {
    const sid = activeSessionId.value
    if (!sid || !controlsEnabled.value) return
    sendControl(buildPlatterMovePayload(sid, VIRTUAL_DECK, deltaTurns, clientTimeMs))
  }

  function onCrossfaderChange(value: number): void {
    const sid = activeSessionId.value
    if (!sid || !controlsEnabled.value) return
    sendControl(buildCrossfaderPayload(sid, value))
  }

  return { onPlatterTouch, onPlatterMove, onCrossfaderChange }
}
