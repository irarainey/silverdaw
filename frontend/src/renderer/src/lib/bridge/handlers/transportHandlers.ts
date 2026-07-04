// Transport-domain inbound handlers: readiness handshake, playhead position,
// and non-fatal engine error surfacing.

import { useTransportStore } from '@/stores/transportStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { log } from '@/lib/log'
import type { BridgeInboundHandlers } from '@/lib/bridge/handlerTypes'

export const transportBridgeHandlers: BridgeInboundHandlers<
  'READY' | 'PLAYHEAD_UPDATE' | 'ENGINE_ERROR'
> = {
  READY: () => {
    // Handshake ack: the backend is reachable. This lets the UI appear before the audio
    // device finishes opening; PROJECT_STATE carries the authoritative init snapshot.
    useTransportStore().setHandshakeReady(true)
  },

  PLAYHEAD_UPDATE: (payload) => {
    // Position only: local play intent wins, and <2 ms sample-rounding acks are ignored.
    const t = useTransportStore()
    if (Math.abs(payload.positionMs - t.positionMs) < 2) return
    t.setPosition(payload.positionMs)
  },

  ENGINE_ERROR: (payload) => {
    // Backend survived a handler exception; surface it non-fatally.
    log.error('bridge', `ENGINE_ERROR: ${payload.message}`)
    useNotificationsStore().pushError(
      'The audio engine hit a problem but kept running. If something looks off, try the action again.',
      8000
    )
  }
}
