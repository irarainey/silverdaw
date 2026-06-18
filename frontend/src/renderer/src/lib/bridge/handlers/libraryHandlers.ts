// Library/waveform-domain inbound handlers: peak cache loads, analysis results,
// and saved-sample reconciliation.

import { useLibraryStore } from '@/stores/libraryStore'
import { applySampleSaved, loadEditorPeaksFromCache, loadPeaksFromCache } from '@/lib/bridge/peaksCache'
import { log } from '@/lib/log'
import type { BridgeInboundHandlers } from '@/lib/bridge/handlerTypes'

export const libraryBridgeHandlers: BridgeInboundHandlers<
  'WAVEFORM_READY' | 'CLIP_EDITOR_PEAKS_READY' | 'LIBRARY_ITEM_ANALYSIS' | 'SAMPLE_SAVED'
> = {
  WAVEFORM_READY: (payload) => {
    // Bulk peaks stay on disk; main reads and dequantises them.
    void loadPeaksFromCache(payload)
  },

  CLIP_EDITOR_PEAKS_READY: (payload) => {
    // Clip Editor peaks are keyed by library item for library-clip reuse.
    void loadEditorPeaksFromCache(payload)
  },

  LIBRARY_ITEM_ANALYSIS: (payload) => {
    useLibraryStore().setItemAnalysis(
      payload.itemId,
      payload.bpm,
      payload.beatAnchorSec,
      payload.beats,
      payload.variableTempo,
      payload.playbackFilePath,
      payload.lowConfidence
    )
    log.info(
      'bridge',
      `LIBRARY_ITEM_ANALYSIS itemId=${payload.itemId} bpm=${payload.bpm.toFixed(2)} anchor=${payload.beatAnchorSec.toFixed(3)}s beats=${payload.beats.length}${payload.variableTempo ? ' variable' : ''}${payload.lowConfidence ? ' low-confidence' : ''}${payload.playbackFilePath ? ' (cached)' : ''}`
    )
  },

  SAMPLE_SAVED: (payload) => {
    void applySampleSaved(payload)
  }
}
