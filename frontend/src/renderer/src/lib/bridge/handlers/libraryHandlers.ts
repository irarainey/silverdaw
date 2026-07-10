// Library/waveform-domain inbound handlers: peak cache loads, analysis results,
// and saved-sample reconciliation.

import { useLibraryStore, libraryItemDisplayName } from '@/stores/libraryStore'
import { useProjectStore } from '@/stores/projectStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { applySampleSaved, loadEditorPeaksFromCache, loadPeaksFromCache } from '@/lib/bridge/peaksCache'
import { log } from '@/lib/log'
import { refreshLibraryPeaksForPath } from '@/stores/projectSnapshotLibrary'
import type { BridgeInboundHandlers } from '@/lib/bridge/handlerTypes'

export const libraryBridgeHandlers: BridgeInboundHandlers<
  'WAVEFORM_READY' | 'WAVEFORM_FAILED' | 'CLIP_EDITOR_PEAKS_READY' | 'LIBRARY_ITEM_ANALYSIS' | 'SAMPLE_SAVED'
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
  }
}
