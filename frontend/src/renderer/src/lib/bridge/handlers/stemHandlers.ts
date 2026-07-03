// Stem-separation inbound handlers: progress, completion, and failure.
//
// Mirrors the mixdown handlers — updates the reactive separation state that the
// progress dialog binds to and surfaces user-facing notifications. The new
// tracks for each ready stem are created by the UI orchestration layer, which
// reuses the existing library-import / track-add flows (single source of truth).

import {
  applyStemProgress,
  clearStemSeparationState,
  markStemSeparationFinalizing,
  snapshotStemSeparationState
} from '@/lib/stemSeparationState'
import { createTracksFromStems, createTrackFromStem } from '@/lib/stems/createStemTracks'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { log } from '@/lib/log'
import type { BridgeInboundHandlers } from '@/lib/bridge/handlerTypes'

/** Yield to the browser so a pending reactive update paints before the caller
 *  starts a burst of synchronous work. Resolves after the next frame (falling
 *  back to a macrotask when no rAF is available, e.g. a backgrounded window). */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve())
    } else {
      setTimeout(resolve, 0)
    }
  })
}

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

  STEM_READY: async (payload) => {
    const tracked = snapshotStemSeparationState()
    if (tracked && tracked.jobId !== payload.jobId) return
    log.info(
      'stems',
      `ready jobId=${payload.jobId} clipId=${payload.clipId} stems=${payload.stems
        .map((s) => s.stem)
        .join(',')}`
    )
    // Keep the progress dialog up in a "Writing files…" state while the stems are
    // read, imported, and placed on tracks, so it never disappears seconds before
    // the clips actually land on the timeline. Yield one frame first so that state
    // paints before the (main-thread-blocking) import/placement work begins.
    markStemSeparationFinalizing(payload.jobId)
    await nextPaint()
    try {
      await createTracksFromStems(payload)
    } finally {
      clearStemSeparationState()
    }
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
