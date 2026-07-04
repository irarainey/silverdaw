// Import / analysis-progress domain actions for the library store.
// Spread into the store; `this` is the store instance.

import { useProjectStore } from '@/stores/projectStore'
import type { Clip } from '@/stores/projectStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { variableTempoWarpSkippedMessage } from '@/lib/warp'
import { send as sendBridge } from '@/lib/bridgeService'
import type { LibraryState } from './libraryTypes'
import { libraryItemDisplayName } from './libraryItemHelpers'

type ImportThis = LibraryState & {
  markItemWarping(libraryItemId: string): void
  finishImport(id: string, stage: 'done' | 'failed'): void
}

export const importActions = {
    saveLibraryItemAsSample(itemId: string, audioType: 'simple' | 'music'): void {
      const item = this.items.find((i) => i.id === itemId)
      if (!item) return
      if (item.kind !== 'clip') {
        useNotificationsStore().pushError('Only saved clips can be saved as samples from the library.')
        return
      }
      const sampleId = `sample-${crypto.randomUUID()}`
      sendBridge('LIBRARY_ITEM_SAVE_AS_SAMPLE', {
        libraryItemId: itemId,
        itemId: sampleId,
        sampleName: libraryItemDisplayName(item),
        audioType
      })
    },

    /** Records backend analysis and advances matching import progress. */
    setItemAnalysis(
      itemId: string,
      bpm: number,
      beatAnchorSec: number,
      beats: number[],
      variableTempo: boolean,
      playbackFilePath?: string,
      lowConfidence?: boolean
    ): void {
      const item = this.items.find((i) => i.id === itemId)
      if (!item) return
      // Keep full-precision BPM; display rounding would drift in beat math.
      item.bpm = bpm > 0 ? bpm : undefined
      item.beatAnchorSec = beats.length > 0 ? beatAnchorSec : undefined
      item.beats = beats.length > 0 ? beats.slice() : undefined
      item.variableTempo = variableTempo || undefined
      // Backend hint refreshes on reanalysis; explicit `audioType` still wins.
      item.lowConfidence = lowConfidence === true ? true : undefined
      // Keep backend decoded-WAV cache path separate from renderer clip-add paths.
      item.decodedCacheFilePath = playbackFilePath?.trim() ? playbackFilePath : undefined
      // One unconditional repaint is cheaper than searching for matching clips.
      useProjectStore().peaksRevision++
      // Split the single backend analysis pass into clearer visible stages.
      const entry = this.imports.find((e) => e.libraryItemId === itemId)
      if (entry && entry.stage !== 'done' && entry.stage !== 'failed') {
        const project = useProjectStore()
        const pendingAutoWarpClips = Object.values(project.clips).filter(
          (clip: Clip) => clip.libraryItemId === itemId && clip.pendingAutoWarp === true
        )
        entry.stage = 'detectingBeats'
        if (pendingAutoWarpClips.length > 0 && variableTempo) {
          // A variable tempo can't be matched with a single stretch ratio, so the
          // queued auto-warp is abandoned. Clear the pending flag on both ends so
          // the clip doesn't sit waiting to warp, and point the user at manual
          // warping instead of silently dropping the request.
          for (const clip of pendingAutoWarpClips) {
            project.setClipWarp(clip.id, { pendingAutoWarp: false })
          }
          useNotificationsStore().pushInfo(variableTempoWarpSkippedMessage(libraryItemDisplayName(item)))
          setTimeout(() => this.finishImport(entry.id, 'done'), 600)
        } else if (pendingAutoWarpClips.length > 0) {
          setTimeout(() => {
            if (entry.stage === 'detectingBeats') this.markItemWarping(itemId)
          }, 300)
        } else {
          setTimeout(() => {
            this.finishImport(entry.id, 'done')
          }, 600)
        }
      }
    },

    /** Begins renderer-local import progress tracking. */
    beginImport(fileName: string): string {
      const id = crypto.randomUUID()
      this.imports.push({ id, fileName, stage: 'decoding' })
      return id
    },

    /** Moves an import from renderer decode to backend analysis. */
    markImportAnalyzing(id: string, libraryItemId: string): void {
      const entry = this.imports.find((e) => e.id === id)
      if (!entry) return
      entry.libraryItemId = libraryItemId
      entry.stage = 'detectingTempo'
    },

    markItemWarping(libraryItemId: string): void {
      const entry = this.imports.find((e) => e.libraryItemId === libraryItemId)
      if (!entry || entry.stage === 'done' || entry.stage === 'failed') return
      entry.stage = 'warping'
      setTimeout(() => {
        if (entry.stage === 'warping') this.finishImport(entry.id, 'done')
      }, 2000)
    },

    finishItemWarping(libraryItemId: string): void {
      const entry = this.imports.find((e) => e.libraryItemId === libraryItemId)
      if (!entry || entry.stage === 'done' || entry.stage === 'failed') return
      if (entry.stage === 'detectingBeats' || entry.stage === 'warping') {
        entry.stage = 'warping'
        setTimeout(() => {
          this.finishImport(entry.id, 'done')
        }, 300)
      }
    },

    /** Finishes an import and briefly leaves the result visible. */
    finishImport(id: string, stage: 'done' | 'failed'): void {
      const entry = this.imports.find((e) => e.id === id)
      if (!entry || entry.stage === 'done' || entry.stage === 'failed') return
      entry.stage = stage
      // Delay long enough to read, short enough not to clutter.
      setTimeout(() => {
        const idx = this.imports.findIndex((e) => e.id === id)
        if (idx >= 0) this.imports.splice(idx, 1)
      }, 1200)
    },

    /** Pair every queued file with one `noteImportFinished()` call. */
    beginImportBatch(count: number): void {
      if (count <= 0) return
      this.importTotal += count
    },

    /** Resets the batch counters when all queued files finish. */
    noteImportFinished(): void {
      if (this.importTotal <= 0) return
      this.importDone++
      if (this.importDone >= this.importTotal) {
        this.importDone = 0
        this.importTotal = 0
      }
    },
} satisfies Record<string, (this: ImportThis, ...args: never[]) => unknown> &
  ThisType<ImportThis>
