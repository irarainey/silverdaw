// Stem-separation inbound handlers: progress, completion, and failure.
//
// Mirrors the mixdown handlers — updates the reactive separation state that the
// progress dialog binds to and surfaces user-facing notifications. The new
// tracks for each ready stem are created by the UI orchestration layer, which
// reuses the existing library-import / track-add flows (single source of truth).

import {
  applyStemProgress,
  clearStemSeparationState,
  snapshotStemSeparationState
} from '@/lib/stemSeparationState'
import { createTracksFromStems, createTrackFromStem } from '@/lib/stems/createStemTracks'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { log } from '@/lib/log'
import type { BridgeInboundHandlers } from '@/lib/bridge/handlerTypes'

export const stemBridgeHandlers: BridgeInboundHandlers<
  'STEM_PROGRESS' | 'STEM_PARTIAL' | 'STEM_READY' | 'STEM_FAILED'
> = {
  STEM_PROGRESS: (payload) => {
    applyStemProgress(payload)
  },

  STEM_PARTIAL: (payload) => {
    const tracked = snapshotStemSeparationState()
    if (tracked && tracked.jobId !== payload.jobId) return
    log.info('stems', `partial jobId=${payload.jobId} stem=${payload.stem}`)
    // Fire-and-forget: place this one stem's track now for live feedback.
    void createTrackFromStem(payload)
  },

  STEM_READY: (payload) => {
    const tracked = snapshotStemSeparationState()
    if (tracked && tracked.jobId !== payload.jobId) return
    clearStemSeparationState()
    log.info(
      'stems',
      `ready jobId=${payload.jobId} clipId=${payload.clipId} stems=${payload.stems
        .map((s) => s.stem)
        .join(',')}`
    )
    // Fire-and-forget: each stem is read, imported, and placed on a new track.
    void createTracksFromStems(payload)
  },

  STEM_FAILED: (payload) => {
    const tracked = snapshotStemSeparationState()
    if (tracked && tracked.jobId !== payload.jobId) return
    clearStemSeparationState()
    if (payload.code === 'cancelled') {
      useNotificationsStore().pushInfo('Stem separation cancelled')
      log.info('stems', `cancelled jobId=${payload.jobId}`)
    } else {
      useNotificationsStore().pushError(`Stem separation failed: ${payload.error}`)
      log.error('stems', `failed jobId=${payload.jobId} code=${payload.code} error=${payload.error}`)
    }
  }
}
