// Library — a project-wide pool of imported audio files that can be
// dragged onto tracks. Items live in the renderer only (not pushed to the
// backend) until they're placed on a track, at which point the normal
// CLIP_ADD flow runs in `projectStore.addClipFromLibrary`.
//
// Items are decoded once on import and the resulting peaks / metadata are
// reused for every clip dragged out, so dropping the same sample onto five
// tracks doesn't re-decode the file five times.

import { defineStore } from 'pinia'
import { useProjectStore } from '@/stores/projectStore'

export interface LibraryItem {
  readonly id: string
  readonly filePath: string
  readonly fileName: string
  readonly durationMs: number
  readonly sampleRate: number
  readonly channelCount: number
  /** Alternating min/max float pairs at PEAKS_PER_SECOND resolution. */
  readonly peaks: Float32Array
}

interface LibraryState {
  items: LibraryItem[]
  nextItemIndex: number
  /**
   * Total number of files queued for import in the current batch. Resets to
   * 0 once every queued file has finished (success OR failure). Used by
   * `StatusBar` to drive the import-progress bar.
   */
  importTotal: number
  /** Number of files in the current batch that have finished. */
  importDone: number
  /**
   * Id of the library item currently being dragged out (set on `dragstart`,
   * cleared on `dragend`). HTML5's `dataTransfer.getData(...)` returns an
   * empty string during `dragover` for non-text payloads, so the timeline's
   * drag-over handler reads the dragged item from here instead.
   */
  currentDragItemId: string | null
}

export const useLibraryStore = defineStore('library', {
  state: (): LibraryState => ({
    items: [],
    nextItemIndex: 1,
    importTotal: 0,
    importDone: 0,
    currentDragItemId: null
  }),

  getters: {
    /** Lookup map for quick `getItem(id)` by-id access. */
    byId(state): Record<string, LibraryItem> {
      const map: Record<string, LibraryItem> = {}
      for (const item of state.items) map[item.id] = item
      return map
    },

    /** True while at least one import is queued or in flight. */
    isImporting(state): boolean {
      return state.importTotal > 0
    },

    /** Fraction in [0, 1] of the current import batch completed. */
    importFraction(state): number {
      if (state.importTotal <= 0) return 0
      return Math.min(1, state.importDone / state.importTotal)
    }
  },

  actions: {
    /**
     * Add a decoded audio file to the library. If a file with the same
     * `filePath` is already present, returns the existing item's id rather
     * than creating a duplicate.
     */
    addItem(audio: {
      filePath: string
      fileName: string
      durationMs: number
      sampleRate: number
      channelCount: number
      peaks: Float32Array
    }): string {
      const existing = this.items.find((i) => i.filePath === audio.filePath)
      if (existing) return existing.id

      const id = `l${this.nextItemIndex++}`
      this.items.push({
        id,
        filePath: audio.filePath,
        fileName: audio.fileName,
        durationMs: audio.durationMs,
        sampleRate: audio.sampleRate,
        channelCount: audio.channelCount,
        peaks: audio.peaks
      })
      return id
    },

    /**
     * Remove an item from the library. No-op if the item's file is still
     * referenced by any clip on any track — the user must delete those
     * clips first. Returns true if the item was actually removed.
     */
    removeItem(itemId: string): boolean {
      const idx = this.items.findIndex((i) => i.id === itemId)
      if (idx < 0) return false
      if (this.isItemInUse(itemId)) return false
      this.items.splice(idx, 1)
      return true
    },

    /**
     * True if any clip on any track currently references this library
     * item's file. Used to gate `removeItem` and to disable the remove
     * button in the library UI.
     */
    isItemInUse(itemId: string): boolean {
      const item = this.items.find((i) => i.id === itemId)
      if (!item) return false
      const project = useProjectStore()
      for (const id in project.clips) {
        if (project.clips[id].filePath === item.filePath) return true
      }
      return false
    },

    /** Lookup an item by id, or `null` if absent. */
    getItem(itemId: string): LibraryItem | null {
      return this.items.find((i) => i.id === itemId) ?? null
    },

    /**
     * Add `count` files to the current import batch. Drives the
     * progress bar in the status bar; pair every call with the same
     * number of `noteImportFinished()` calls (one per file, regardless
     * of success or failure).
     */
    beginImportBatch(count: number): void {
      if (count <= 0) return
      this.importTotal += count
    },

    /**
     * Mark one queued import as finished. When `importDone` catches up
     * with `importTotal`, both reset to 0 so the progress bar disappears.
     */
    noteImportFinished(): void {
      if (this.importTotal <= 0) return
      this.importDone++
      if (this.importDone >= this.importTotal) {
        this.importDone = 0
        this.importTotal = 0
      }
    },

    /**
     * Record which library item is currently being dragged out. Set this
     * on `dragstart` and clear it (with `null`) on `dragend` so the
     * timeline can identify the dragged item during `dragover` events,
     * where `dataTransfer.getData(...)` is intentionally empty.
     */
    setDragItem(itemId: string | null): void {
      this.currentDragItemId = itemId
    }
  }
})
