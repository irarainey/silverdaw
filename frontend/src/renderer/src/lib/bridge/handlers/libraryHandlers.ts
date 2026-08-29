// Library/waveform-domain inbound handlers: peak cache loads, analysis results,
// and saved-sample reconciliation.

import { useLibraryStore, libraryItemDisplayName } from '@/stores/libraryStore'
import { useProjectStore } from '@/stores/projectStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { applySampleSaved, loadEditorPeaksFromCache, loadPeaksFromCache } from '@/lib/bridge/peaksCache'
import { log } from '@/lib/log'
import { refreshLibraryPeaksForPath } from '@/stores/projectSnapshotLibrary'
import {
  describeTempoCorrection,
  describeTempoCorrectionCaveats
} from '@/lib/library/tempoCorrectionReport'
import type { BridgeInboundHandlers } from '@/lib/bridge/handlerTypes'

export const libraryBridgeHandlers: BridgeInboundHandlers<
  | 'WAVEFORM_READY'
  | 'WAVEFORM_FAILED'
  | 'CLIP_EDITOR_PEAKS_READY'
  | 'LIBRARY_ITEM_ANALYSIS'
  | 'TEMPO_CORRECTION_APPLIED'
  | 'SAMPLE_SAVED'
> = {
  WAVEFORM_READY: (payload) => {
    // Bulk peaks stay on disk; main reads and dequantises them.
    void loadPeaksFromCache(payload)
  },

  WAVEFORM_FAILED: (payload) => {
    const clip = useProjectStore().clips[payload.clipId]
    if (clip) refreshLibraryPeaksForPath(clip.filePath)
    log.warn('bridge', `WAVEFORM_FAILED clipId=${payload.clipId}: ${payload.error}`)
  },

  CLIP_EDITOR_PEAKS_READY: (payload) => {
    // Clip Editor peaks are keyed by library item for library-clip reuse.
    void loadEditorPeaksFromCache(payload)
  },

  LIBRARY_ITEM_ANALYSIS: (payload) => {
    const library = useLibraryStore()
    // Applied before the analysis so the item's source BPM resolves from its musical
    // length the moment the grid lands. Sent as 0 when there is none — a hand-set tempo
    // clears it, and leaving a stale count would keep overriding the typed value.
    if (typeof payload.musicalBeats === 'number') {
      const item = library.byId[payload.itemId]
      if (item) item.musicalBeats = payload.musicalBeats >= 1 ? payload.musicalBeats : undefined
    }
    library.setItemAnalysis(
      payload.itemId,
      payload.bpm,
      payload.beatAnchorSec,
      payload.beats,
      payload.variableTempo,
      payload.playbackFilePath,
      payload.lowConfidence,
      // A manual tempo echo must not reflow placed clips — that happens on Clip
      // Editor Save. Automatic detection (import) has no `manual` flag and aligns.
      /*align=*/ payload.manual !== true
    )
    log.info(
      'bridge',
      `LIBRARY_ITEM_ANALYSIS itemId=${payload.itemId} bpm=${payload.bpm.toFixed(2)} anchor=${payload.beatAnchorSec.toFixed(3)}s beats=${payload.beats.length}${payload.variableTempo ? ' variable' : ''}${payload.lowConfidence ? ' low-confidence' : ''}${payload.playbackFilePath ? ' (cached)' : ''}${payload.timedOut ? ' timed-out' : ''}`
    )
    // Tempo detection hit its time limit: tell the user it was skipped and that
    // they can retry it manually (right-click ▸ Reanalyse) rather than leaving
    // them wondering why the clip has no beat grid.
    if (payload.timedOut) {
      const item = library.getItem(payload.itemId)
      const name = item ? libraryItemDisplayName(item) : 'the track'
      useNotificationsStore().pushError(
        `Tempo detection timed out for "${name}". You can reanalyse it manually from the library.`
      )
    }
  },

  SAMPLE_SAVED: (payload) => {
    void applySampleSaved(payload)
  },

  // ADR 0027: a correction is never silent. It can re-warp clips it was not pointed at,
  // remove transitions and push clips past the project length, so the result is always
  // reported — including what it deliberately left alone.
  TEMPO_CORRECTION_APPLIED: (payload) => {
    const notifications = useNotificationsStore()
    const library = useLibraryStore()

    if (!payload.ok) {
      // Nothing was applied, so the project is not half-corrected; say what failed.
      log.warn('bridge', `TEMPO_CORRECTION_APPLIED itemId=${payload.itemId} failed: ${payload.error}`)
      notifications.pushError(`Could not correct the tempo. ${payload.error}`)
      return
    }

    const item = library.getItem(payload.itemId)
    const owner = library.getItem(payload.ownerItemId)
    const summary = describeTempoCorrection(
      payload,
      item ? libraryItemDisplayName(item) : 'the track',
      owner ? libraryItemDisplayName(owner) : undefined
    )
    const caveats = describeTempoCorrectionCaveats(payload)

    log.info(
      'bridge',
      `TEMPO_CORRECTION_APPLIED itemId=${payload.itemId} owner=${payload.ownerItemId} (${payload.ownerReason}) ${payload.previousBpm.toFixed(2)}->${payload.appliedBpm.toFixed(2)} updated=${payload.clipsUpdated} pinned=${payload.clipsPinnedExcluded} unwarped=${payload.clipsUnwarpedExcluded} transitionsRemoved=${payload.transitionsRemoved} pastLength=${payload.clipsPastProjectLength}`
    )

    // The caveats ride in the same toast: they are consequences of the one action the
    // user just took, and splitting them across toasts would make the outcome harder to
    // read rather than easier.
    notifications.pushInfo([summary, ...caveats].join('\n'))
  }
}
