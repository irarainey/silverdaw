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
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'

export interface LibraryItem {
  readonly id: string
  readonly filePath: string
  readonly fileName: string
  readonly durationMs: number
  /**
   * Sample rate of the source file. May be 0 for placeholder items
   * reconstructed from PROJECT_STATE before WAVEFORM_DATA arrives; gets
   * filled in by `setItemPeaks`.
   */
  sampleRate: number
  readonly channelCount: number
  /**
   * Alternating min/max float pairs at PEAKS_PER_SECOND resolution. May
   * be an empty array for placeholder items reconstructed from
   * PROJECT_STATE; filled in by `setItemPeaks` when WAVEFORM_DATA arrives.
   */
  peaks: Float32Array
  /**
   * Detected BPM (rounded to 2 d.p.) from the backend's BTrack-based
   * estimator. `undefined` until the worker job finishes. The library
   * tile shows this once it's populated.
   */
  bpm?: number
  /**
   * Path the JUCE backend should actually load when this item is placed
   * on a track. Equals `filePath` for formats the backend can decode
   * natively (WAV/AIFF/FLAC/Ogg/MP3/WMA). For others (e.g. .m4a on
   * Windows), the import flow asks main to transcode the decoded PCM to
   * a temp WAV and stores that path here. UI continues to display the
   * original `filePath` / `fileName` to the user.
   */
  readonly playbackFilePath: string
  /**
   * ID3 / Vorbis / iTunes / BWF tag info, populated asynchronously by the
   * main process via `audio:readMetadata`. `undefined` while loading,
   * `null` once we know the file has no parseable tags.
   *
   * Note: the `coverArt` field of `AudioMetadata` is stripped before the
   * value lands here — the raw bytes live for one tick inside
   * `setItemMetadata`, then get wrapped in a Blob and exposed as
   * `coverArtUrl` below. Keeping the bytes out of the reactive object
   * stops Vue from proxying ~MB-sized buffers and stops Pinia devtools
   * from snapshotting them.
   */
  metadata?: AudioMetadata | null
  /**
   * `URL.createObjectURL(blob)` for the embedded cover art, if any.
   * Owned by the library store: created in `setItemMetadata`, revoked in
   * `removeItem` / `revokeItemCoverArt`. Components bind directly to it
   * as an `<img :src>` — no base64, no copying.
   */
  coverArtUrl?: string
}

/**
 * Per-file import progress entry, surfaced to the UI by the
 * `ImportProgressDialog`. An entry is created when the renderer starts
 * decoding/registering a file and removed shortly after the backend's
 * BPM detection has completed (or the import failed). The user gets a
 * visible spinner the whole time the system is working on a file —
 * including the BPM-detection stage, which used to be silent.
 */
export type ImportStage = 'decoding' | 'detecting' | 'done' | 'failed'
export interface ImportEntry {
  /** Local-only id used to remove the entry; not the library item id
   *  (which is unknown until `decoding` finishes). */
  id: string
  fileName: string
  stage: ImportStage
  /** Filled in once the library item exists; lets the BPM-arrived
   *  event match this entry by itemId. */
  libraryItemId?: string
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
  /** Currently in-flight import entries, in order of arrival. The
   *  `ImportProgressDialog` reads this and renders one row per entry. */
  imports: ImportEntry[]
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
    imports: [],
    currentDragItemId: null
  }),

  getters: {
    /** Lookup map for quick `getItem(id)` by-id access. */
    byId(state): Record<string, LibraryItem> {
      const map: Record<string, LibraryItem> = {}
      for (const item of state.items) map[item.id] = item
      return map
    },

    /** True while at least one import is queued or in flight — either
     *  a renderer-side decoding stage or a backend BPM-detection stage.
     *  Used to drive both the legacy status-bar progress bar and the
     *  document-wide busy cursor. */
    isImporting(state): boolean {
      if (state.importTotal > 0) return true
      // The per-file `imports` list outlives `importTotal` because BPM
      // detection runs after the renderer's decode-and-add stage has
      // already incremented `importDone`. Any entry still in
      // `decoding` or `detecting` should keep the cursor in its busy
      // state so the user knows work is in progress.
      for (const entry of state.imports) {
        if (entry.stage === 'decoding' || entry.stage === 'detecting') return true
      }
      return false
    },

    /** Fraction in [0, 1] of the current import batch completed. */
    importFraction(state): number {
      if (state.importTotal <= 0) return 0
      return Math.min(1, state.importDone / state.importTotal)
    }
  },

  actions: {
    /**
     * Drop every library item. Called by `projectStore` when a
     * PROJECT_STATE with `reset=true` arrives (PROJECT_LOAD /
     * PROJECT_NEW) — the new project's library catalogue is rebuilt
     * fresh as part of applying the snapshot.
     */
    clear(): void {
      // Revoke cover-art URLs so the underlying Blobs are GC-eligible.
      for (const item of this.items) {
        if (item.coverArtUrl) {
          try {
            URL.revokeObjectURL(item.coverArtUrl)
          } catch {
            /* ignore */
          }
        }
      }
      this.items = []
      this.imports = []
      log.info('library', 'cleared')
    },

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
      /** Optional override; defaults to `filePath`. */
      playbackFilePath?: string
      /** When true, the item is being reconstructed from a
       *  PROJECT_STATE snapshot and we must NOT echo a LIBRARY_ADD
       *  back to the backend (we're applying the backend's truth,
       *  not creating a new entry). */
      fromSnapshot?: boolean
      /** Specific id to use (snapshot path). Auto-minted when omitted
       *  on a user-driven import. */
      id?: string
    }): string {
      const existing = this.items.find((i) => i.filePath === audio.filePath)
      if (existing) return existing.id

      // Snapshot path passes the persisted id so the renderer ↔
      // backend id space stays in sync across reloads. User-driven
      // adds auto-mint a fresh id; we still bump `nextItemIndex`
      // past any explicit id we adopt so future auto-mints don't
      // collide.
      let id: string
      if (typeof audio.id === 'string' && audio.id.length > 0) {
        id = audio.id
        const m = /^l(\d+)$/.exec(id)
        if (m) {
          const n = Number(m[1])
          if (Number.isFinite(n) && n >= this.nextItemIndex) {
            this.nextItemIndex = n + 1
          }
        }
      } else {
        id = `l${this.nextItemIndex++}`
      }
      this.items.push({
        id,
        filePath: audio.filePath,
        fileName: audio.fileName,
        durationMs: audio.durationMs,
        sampleRate: audio.sampleRate,
        channelCount: audio.channelCount,
        peaks: audio.peaks,
        playbackFilePath: audio.playbackFilePath ?? audio.filePath
      })
      log.info(
        'library',
        `addItem id=${id} file=${audio.fileName} sr=${audio.sampleRate} ch=${audio.channelCount} ms=${audio.durationMs}`
      )
      // Persist user-driven library additions to the project so the
      // catalogue survives save/load. Snapshot-driven adds (called
      // from `applyProjectStateSnapshot`) skip this — we're already
      // mirroring the backend's truth, not creating new state.
      if (audio.fromSnapshot !== true) {
        sendBridge('LIBRARY_ADD', { itemId: id, filePath: audio.filePath })
      }
      return id
    },

    /**
     * Remove an item from the library. No-op if the item's file is still
     * referenced by any clip on any track — the user must delete those
     * clips first. Returns true if the item was actually removed.
     *
     * Also revokes the cover-art object URL so the underlying Blob is
     * eligible for GC; without this the renderer would leak ~MB per
     * imported file across the session.
     */
    removeItem(itemId: string): boolean {
      const idx = this.items.findIndex((i) => i.id === itemId)
      if (idx < 0) return false
      if (this.isItemInUse(itemId)) {
        log.warn('library', `removeItem refused (in use) id=${itemId}`)
        return false
      }
      revokeItemCoverArt(this.items[idx])
      this.items.splice(idx, 1)
      sendBridge('LIBRARY_REMOVE', { itemId })
      log.info('library', `removeItem id=${itemId}`)
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
        if (project.clips[id]?.filePath === item.filePath) return true
      }
      return false
    },

    /** Lookup an item by id, or `null` if absent. */
    getItem(itemId: string): LibraryItem | null {
      return this.items.find((i) => i.id === itemId) ?? null
    },

    /**
     * Attach tag metadata (artist / title / cover art / bitrate / …) to an
     * existing library item. Called by the import flow once the main
     * process finishes parsing. `null` means “parsing finished but no
     * usable tags were found” — distinct from `undefined` (“still loading”).
     *
     * If the metadata carries embedded cover art, the raw bytes are
     * stripped out of the stored metadata object and turned into a
     * `Blob` + `URL.createObjectURL`. The resulting URL is stashed on
     * the item as `coverArtUrl`; the previous URL (if any) is revoked
     * so re-importing a file with a different cover doesn't leak.
     */
    setItemMetadata(itemId: string, metadata: AudioMetadata | null): void {
      const item = this.items.find((i) => i.id === itemId)
      if (!item) return

      // Drop any previously-issued cover URL before we overwrite it.
      revokeItemCoverArt(item)
      item.coverArtUrl = undefined

      if (metadata == null) {
        item.metadata = metadata
        return
      }

      // Pull the cover bytes off the metadata object so we don't store a
      // multi-megabyte ArrayBuffer inside Vue's reactivity proxy. The
      // wrapped Blob URL is the only handle the rest of the app sees.
      const { coverArt, ...rest } = metadata
      item.metadata = rest
      if (coverArt && coverArt.data && (coverArt.data as ArrayBuffer).byteLength > 0) {
        const blob = new Blob([coverArt.data], { type: coverArt.mimeType })
        item.coverArtUrl = URL.createObjectURL(blob)
      }

      // Backfill auto-named tracks. If a track is hosting exactly one
      // clip whose file matches this library item, and the track's
      // current name is the basename of that file (i.e. the
      // auto-assigned fallback from `addClipToTrack` /
      // `applyProjectStateSnapshot`), promote it to the freshly-loaded
      // title. User-renamed tracks are skipped because their name no
      // longer matches the basename pattern.
      const title = rest.title?.trim()
      if (title && title.length > 0) {
        const project = useProjectStore()
        const fileBase = item.fileName.replace(/\.[^.]+$/, '')
        for (const track of project.tracks) {
          if (track.clipIds.length !== 1) continue
          const clip = project.clips[track.clipIds[0]!]
          if (!clip || clip.filePath !== item.filePath) continue
          if (track.name === fileBase || track.name === item.fileName) {
            track.name = title
          }
        }
      }
    },

    /**
     * Replace a library item's waveform peaks (and optionally its
     * sample rate). Called by the project store when a `WAVEFORM_DATA`
     * frame arrives for a clip whose source file maps to this item, so
     * library cards rebuilt from PROJECT_STATE pick up their waveform
     * once the backend serves the cached peaks. No-op for unknown ids.
     */
    setItemPeaks(itemId: string, peaks: Float32Array, sampleRate: number): void {
      const item = this.items.find((i) => i.id === itemId)
      if (!item) return
      item.peaks = peaks
      if (sampleRate > 0) item.sampleRate = sampleRate
      log.debug('library', `setItemPeaks id=${itemId} peaks=${peaks.length / 2} sr=${sampleRate}`)
    },

    /**
     * Record the BPM detected for `itemId`. Called from the bridge
     * when a `LIBRARY_ITEM_BPM` envelope arrives (backend has finished
     * the BTrack analysis on a worker thread). No-op for unknown ids
     * — the item may have been removed mid-analysis.
     */
    setItemBpm(itemId: string, bpm: number): void {
      const item = this.items.find((i) => i.id === itemId)
      if (!item) return
      if (bpm > 0) {
        item.bpm = Math.round(bpm * 100) / 100
      } else {
        item.bpm = undefined
      }
      // The progress entry waiting on this item's BPM detection can now
      // be finished. Match by libraryItemId; entries without one (e.g.
      // a library item that was preloaded from a snapshot rather than
      // a fresh import) won't have a progress row to update.
      const entry = this.imports.find((e) => e.libraryItemId === itemId)
      if (entry) {
        this.finishImport(entry.id, 'done')
      }
    },

    /**
     * Begin tracking a new import (renderer-side decoding stage). Returns
     * a renderer-local id used to update the entry later. The progress
     * panel shows the entry from this call until `finishImport` is
     * called (or the entry expires from inactivity).
     */
    beginImport(fileName: string): string {
      const id = crypto.randomUUID()
      this.imports.push({ id, fileName, stage: 'decoding' })
      return id
    },

    /**
     * Mark a renderer-side decoding stage as complete; the entry now
     * waits on the backend's BPM detection. Attach the library item
     * id so the LIBRARY_ITEM_BPM-arrived handler can find this entry.
     */
    markImportAnalyzing(id: string, libraryItemId: string): void {
      const entry = this.imports.find((e) => e.id === id)
      if (!entry) return
      entry.libraryItemId = libraryItemId
      entry.stage = 'detecting'
    },

    /**
     * Mark an entry as finished (done or failed) and schedule its
     * removal a short delay later so the user gets a brief flash of
     * "done" before the row disappears. Idempotent.
     */
    finishImport(id: string, stage: 'done' | 'failed'): void {
      const entry = this.imports.find((e) => e.id === id)
      if (!entry || entry.stage === 'done' || entry.stage === 'failed') return
      entry.stage = stage
      // Remove after a short delay so the user gets to see the
      // "done" / "failed" transition. 1.2 s is long enough to read
      // and short enough not to clutter the screen.
      setTimeout(() => {
        const idx = this.imports.findIndex((e) => e.id === id)
        if (idx >= 0) this.imports.splice(idx, 1)
      }, 1200)
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

/**
 * Resolve a library item to the label that should be used wherever it's
 * shown to the user as a single line (clip name on the timeline, drag
 * ghost text, etc.). Prefers the tag title; falls back to the file name
 * if there's no title or the title is just whitespace.
 */
export function libraryItemDisplayName(item: {
  fileName: string
  metadata?: AudioMetadata | null
}): string {
  const title = item.metadata?.title?.trim()
  return title && title.length > 0 ? title : item.fileName
}

/**
 * Revoke the cover-art object URL on `item` if one has been issued.
 * Safe to call when no URL is set. Does NOT clear `item.coverArtUrl` —
 * callers either delete the item outright (no further references) or
 * overwrite the property immediately afterwards.
 */
function revokeItemCoverArt(item: LibraryItem | undefined): void {
  if (item?.coverArtUrl) URL.revokeObjectURL(item.coverArtUrl)
}
