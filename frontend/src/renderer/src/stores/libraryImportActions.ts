// Import / analysis-progress domain actions for the library store.
// Spread into the store; `this` is the store instance.

import { useProjectStore } from '@/stores/projectStore'
import type { Clip } from '@/stores/projectStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useUiStore } from '@/stores/uiStore'
import { send as sendBridge } from '@/lib/bridgeService'
import type { LibraryState } from './libraryTypes'
import { libraryItemDisplayName } from './libraryItemHelpers'

type ImportThis = LibraryState & {
  markItemWarping(libraryItemId: string): void
  finishImport(id: string, stage: 'done' | 'failed'): void
  alignItemClipsToGrid(itemId: string): number
}

// Library items analysed just before a project-BPM change (a first-clip tempo
// seed) whose clips still need grid alignment once the new tempo lands. Module
// scope (not reactive state) — pure cross-message coordination; auto-expires so
// a later manual BPM change can't reflow clips.
const gridAlignPendingItemIds = new Set<string>()

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

    /** Records backend analysis and advances matching import progress. `align`
     *  is off for authoritative snapshot applies (project load, undo/redo): the
     *  clips are already where they belong, so re-aligning would fight an undo or
     *  dirty a freshly-loaded project. New imports and manual-tempo echoes align. */
    setItemAnalysis(
      itemId: string,
      bpm: number,
      beatAnchorSec: number,
      beats: number[],
      variableTempo: boolean,
      playbackFilePath?: string,
      lowConfidence?: boolean,
      align: boolean = true
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
      useProjectStore().timelineRevision++
      // Beat-align this item's placed clips to the project bar grid once beats are
      // known. Runs now (covers a clip dropped at a tempo the project already uses)
      // AND is re-run from PROJECT_BPM_APPLIED via `flushGridAlignAfterBpm`: a
      // first-clip tempo seed lands in the NEXT bridge message, so at this point the
      // project grid may still be the stale pre-seed tempo. `alignClipToBarGrid`
      // itself skips simple samples, locked clips, tempo mismatches, and warped
      // clips are excluded here.
      if (bpm > 0 && align && useUiStore().alignClipsToGridOnAnalysis) {
        this.alignItemClipsToGrid(itemId)
        gridAlignPendingItemIds.add(itemId)
        // Don't let this linger and reflow clips on an unrelated future manual BPM
        // change; any tempo seed for this item arrives within a frame.
        setTimeout(() => gridAlignPendingItemIds.delete(itemId), 1500)
      }
      // Split the single backend analysis pass into clearer visible stages.
      const entry = this.imports.find((e) => e.libraryItemId === itemId)
      if (entry && entry.stage !== 'done' && entry.stage !== 'failed') {
        const project = useProjectStore()
        const pendingAutoWarpClips = Object.values(project.clips).filter(
          (clip: Clip) => clip.libraryItemId === itemId && clip.pendingAutoWarp === true
        )
        entry.stage = 'detectingBeats'
        if (pendingAutoWarpClips.length > 0) {
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

    /** Align a library item's placed, non-warping clips to the project bar grid.
     *  `alignClipToBarGrid` skips clips that can't/shouldn't move (no beat grid,
     *  locked, tempo mismatch, already aligned). */
    alignItemClipsToGrid(itemId: string): number {
      const project = useProjectStore()
      let blocked = 0
      for (const clip of Object.values(project.clips)) {
        if (clip.libraryItemId === itemId && clip.pendingAutoWarp !== true) {
          if (project.alignClipToBarGrid(clip.id) === 'blocked') blocked++
        }
      }
      return blocked
    },

    /** Re-align clips for items analysed just before a project-BPM change (the
     *  first-clip tempo seed). Called from the PROJECT_BPM_APPLIED handler once the
     *  project grid tempo is final, so a clip whose tempo now matches the grid
     *  snaps into place (it was skipped as a mismatch at analysis time). */
    flushGridAlignAfterBpm(): void {
      if (gridAlignPendingItemIds.size === 0) return
      const ids = [...gridAlignPendingItemIds]
      gridAlignPendingItemIds.clear()
      if (!useUiStore().alignClipsToGridOnAnalysis) return
      for (const id of ids) this.alignItemClipsToGrid(id)
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
