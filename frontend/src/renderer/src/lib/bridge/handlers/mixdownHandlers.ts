// Mixdown-domain inbound handlers: export progress, completion, and failure.

import { applyMixdownProgress, clearMixdownState, snapshotMixdownState } from '@/lib/mixdownState'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { log } from '@/lib/log'
import type { BridgeInboundHandlers } from '@/lib/bridge/handlerTypes'

export const mixdownBridgeHandlers: BridgeInboundHandlers<
  'MIXDOWN_PROGRESS' | 'MIXDOWN_DONE' | 'MIXDOWN_FAILED'
> = {
  MIXDOWN_PROGRESS: (payload) => {
    applyMixdownProgress(payload)
  },

  MIXDOWN_DONE: (payload) => {
    const tracked = snapshotMixdownState()
    clearMixdownState()
    const fileName = payload.filePath.replace(/^.*[\\/]/, '')
    useNotificationsStore().pushInfo(`Exported ${fileName}`)
    log.info(
      'mixdown',
      `done filePath=${payload.filePath} durationMs=${payload.durationMs} (tracked format=${tracked?.format ?? 'unknown'})`
    )
  },

  MIXDOWN_FAILED: (payload) => {
    const tracked = snapshotMixdownState()
    clearMixdownState()
    if (payload.code === 'cancelled') {
      useNotificationsStore().pushInfo('Mixdown cancelled')
      log.info('mixdown', `cancelled (tracked path=${tracked?.outputPath ?? 'unknown'})`)
    } else {
      useNotificationsStore().pushError(`Mixdown failed: ${payload.error}`)
      log.error('mixdown', `failed code=${payload.code} error=${payload.error}`)
    }
  }
}
