// Mixdown-domain inbound handlers: export progress, completion, and failure.

import { applyMixdownProgress, clearMixdownState, snapshotMixdownState } from '@/lib/mixdownState'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { log } from '@/lib/log'
import type { BridgeInboundHandlers } from '@/lib/bridge/handlerTypes'

export const mixdownBridgeHandlers: BridgeInboundHandlers<
  'MIXDOWN_PROGRESS' | 'MIXDOWN_DONE' | 'MIXDOWN_FAILED' | 'TRACK_EXPORT_READY'
> = {
  MIXDOWN_PROGRESS: (payload) => {
    applyMixdownProgress(payload)
  },

  TRACK_EXPORT_READY: ({ folder, trackCount }) => {
    clearMixdownState()
    useNotificationsStore().pushInfo(`Exported ${trackCount} ${trackCount === 1 ? 'track' : 'tracks'} to ${folder}`)
  },

  MIXDOWN_DONE: (payload) => {
    const tracked = snapshotMixdownState()
    clearMixdownState()
    const fileName = payload.filePath.replace(/^.*[\\/]/, '')
    const notifications = useNotificationsStore()
    if (payload.warning) {
      notifications.pushError(`Exported ${fileName}, but ${payload.warning}`)
    } else {
      notifications.pushInfo(`Exported ${fileName}`)
    }
    log.info(
      'mixdown',
      `done filePath=${payload.filePath} durationMs=${payload.durationMs} (tracked format=${tracked?.format ?? 'unknown'})`
    )
  },

  MIXDOWN_FAILED: (payload) => {
    const tracked = snapshotMixdownState()
    clearMixdownState()
    if (payload.code === 'cancelled') {
      useNotificationsStore().pushInfo(tracked?.tracks ? 'Track export cancelled' : 'Mixdown cancelled')
      log.info('mixdown', `cancelled (tracked path=${tracked?.outputPath ?? 'unknown'})`)
    } else {
      useNotificationsStore().pushError(`${tracked?.tracks ? 'Track export' : 'Mixdown'} failed: ${payload.error}`)
      log.error('mixdown', `failed code=${payload.code} error=${payload.error}`)
    }
  }
}
