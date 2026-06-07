// Library — a project-wide pool of imported audio files that can be
// dragged onto tracks. The renderer owns decoded peaks / metadata, while the
// backend stores the durable catalogue fields needed to rebuild tiles after
// save/load.
//
// Items are decoded once on import and the resulting peaks / metadata are
// reused for every clip dragged out, so dropping the same sample onto five
// tracks doesn't re-decode the file five times.
//
// **File-size note (documented exception).** The cleanly separable parts have
// been extracted: the domain types live in `./library.types` and the pure,
// stateless item helpers in `./libraryItemHelpers` (both re-exported below so
// `@/stores/libraryStore` import paths stay stable). What remains is a single
// cohesive Pinia options store: its actions share the same `this` state
// (`items`, `imports`, `channelPeaksByItemId`, …) and call one another
// (`this.addItem`, `this.setItemCollapsed`, `this.finishImport`, …). Splitting
// the action bag into free functions threaded with the store instance would be
// contrived (a store-typing dependency on every call) and hurt readability more
// than the line count helps — see the TS instructions on justified exceptions.

import { defineStore } from 'pinia'
import { effectiveClipDurationMs, effectiveClipTempoRatio, isClipTempoWarpActive, useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { shiftedKey } from '@/lib/pitchKey'
import { effectiveDurationMs } from '@/lib/warp'
import { buildPeaksLodPyramid } from '@/lib/peaksLod'
import type { Clip } from '@/stores/projectStore'
import type { ClipWarpMode, LibraryItemKind } from '@shared/bridge-protocol'
import type {
  EditorHiResPeaks,
  ImportEntry,
  ItemChannelPeaks,
  LibraryItem,
  SavedClipSource
} from './library.types'
import { buildSavedClipName, libraryItemDisplayName, revokeItemCoverArt } from './libraryItemHelpers'

// Re-exported so existing `@/stores/libraryStore` consumers keep working after
// the type + pure-helper extraction.
export type {
  EditorHiResPeaks,
  ImportEntry,
  ImportStage,
  ItemChannelPeaks,
  LibraryItem,
  SavedClipSource
} from './library.types'
export { libraryItemDisplayName, libraryItemIsSample, libraryItemSourceBpm } from './libraryItemHelpers'

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
  /** Session-scoped high-resolution peaks for the Clip Editor.
   *  Computed on demand when the user zooms in past the detail the
   *  default-resolution peaks can resolve. We hold a single entry
   *  here (one per dialog open / item switch) because each array can
   *  be multi-MB and there's only one Clip Editor on screen at a time. */
  editorHiResPeaks: EditorHiResPeaks | null
  /**
   * Per-library-item stereo peak data, keyed by item id. Held in a
   * separate map (rather than threaded through the `LibraryItem`
   * constructors) so the summary-mode path stays untouched and the
   * blast radius of the stereo feature is bounded. Only populated for
   * 2-channel sources; cleared in `removeItem`. */
  channelPeaksByItemId: Record<string, ItemChannelPeaks>
}

function touchTimelineClipsForLibraryItem(itemId: string): number {
  const project = useProjectStore()
  let count = 0
  for (const clip of Object.values(project.clips)) {
    if (clip?.libraryItemId === itemId) count++
  }
  if (count > 0) project.peaksRevision++
  return count
}

/**
 * Discover every timeline clip that should be treated as a "linked
 * sibling" of a saved-clip library item, for trim/warp/pitch
 * propagation. Two pools are merged:
 *
 *  1. **Direct links** — timeline clips whose `libraryItemId` points
 *     straight at the saved-clip item. The canonical case after the
 *     saveClipToLibrary rebind landed.
 *  2. **Implicit links** — legacy projects (created before the rebind)
 *     have timeline clips that still point at the underlying
 *     audio-file source but happen to share the saved-clip's exact
 *     `derivedFrom` window. They are adopted as linked siblings on
 *     the next edit so the project file becomes structurally correct.
 *
 * Returns the merged array. Callers that need to write may also call
 * `CLIP_REBIND` for any clip whose `libraryItemId` doesn't already
 * equal `savedClipItem.id`.
 */
function findLinkedTimelineClips(
  savedClipItem: LibraryItem
): Clip[] {
  const project = useProjectStore()
  const directLinkedClips = Object.values(project.clips).filter(
    (c): c is Clip => c?.libraryItemId === savedClipItem.id
  )
  const sourceItemId = savedClipItem.derivedFrom?.sourceItemId
  if (!sourceItemId) return directLinkedClips
  const currentInMs = savedClipItem.derivedFrom?.inMs ?? 0
  const currentDurationMs = savedClipItem.derivedFrom?.durationMs ?? savedClipItem.durationMs
  const implicitLinkedClips = Object.values(project.clips).filter(
    (c): c is Clip =>
      !!c &&
      c.libraryItemId === sourceItemId &&
      Math.abs(c.inMs - currentInMs) < 0.5 &&
      Math.abs(c.durationMs - currentDurationMs) < 0.5
  )
  return [...directLinkedClips, ...implicitLinkedClips]
}

export const useLibraryStore = defineStore('library', {
  state: (): LibraryState => ({
    items: [],
    nextItemIndex: 1,
    importTotal: 0,
    importDone: 0,
    imports: [],
    currentDragItemId: null,
    editorHiResPeaks: null,
    channelPeaksByItemId: {}
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
        if (
          entry.stage === 'decoding' ||
          entry.stage === 'detectingTempo' ||
          entry.stage === 'detectingBeats'
        ) {
          return true
        }
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
      this.channelPeaksByItemId = {}
      this.editorHiResPeaks = null
      log.info('library', 'cleared')
    },

    /**
     * Add a decoded audio file to the library. If a file with the same
      * `filePath` is already present, returns the existing audio-file item's
      * id rather than creating a duplicate. Saved clips are allowed to share a
      * filePath with their source because their trim window makes them distinct.
      */
    addItem(audio: {
      kind?: LibraryItemKind
      name?: string
      filePath: string
      fileName: string
      durationMs: number
      sampleRate: number
      channelCount: number
      peaks: Float32Array
      peaksPerSecond?: number
      /** Optional override; defaults to `filePath`. */
      playbackFilePath?: string
      /** Detected or tagged musical key. */
      key?: string
      /** When true, the item is being reconstructed from a
       *  PROJECT_STATE snapshot and we must NOT echo a LIBRARY_ADD
       *  back to the backend (we're applying the backend's truth,
       *  not creating a new entry). */
      fromSnapshot?: boolean
      /** Specific id to use (snapshot path). Auto-minted when omitted
       *  on a user-driven import. */
      id?: string
      derivedFrom?: SavedClipSource
      collapsed?: boolean
      /** Saved-clip default warp settings (only meaningful when
       *  `kind === 'saved-clip'`). Copied onto a fresh timeline clip
       *  when the tile is dragged in (copy-on-drop, not live link). */
      warpEnabled?: boolean
      warpMode?: ClipWarpMode
      tempoRatio?: number
      semitones?: number
      cents?: number
      /** Backend's per-item missing-source flag from PROJECT_STATE. */
      unresolved?: boolean
    }): string {
      const kind = audio.kind ?? 'audio-file'
      if (kind === 'saved-clip' && !audio.derivedFrom) {
        log.warn('library', `addItem refused saved clip without source window file=${audio.filePath}`)
        return ''
      }
      const existing =
        kind === 'audio-file'
          ? this.items.find((i) => i.kind === 'audio-file' && i.filePath === audio.filePath)
          : this.items.find(
              (i) =>
                i.kind === 'saved-clip' &&
                i.filePath === audio.filePath &&
                i.derivedFrom?.sourceItemId === audio.derivedFrom?.sourceItemId &&
                i.derivedFrom?.inMs === audio.derivedFrom?.inMs &&
                i.derivedFrom?.durationMs === audio.derivedFrom?.durationMs
            )
      if (existing) {
        this.setItemAudioDetails(existing.id, audio.durationMs, audio.sampleRate, audio.channelCount)
        if (audio.key && !existing.key) existing.key = audio.key
        return existing.id
      }

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
        kind,
        name: audio.name,
        filePath: audio.filePath,
        fileName: audio.fileName,
        durationMs: audio.durationMs,
        sampleRate: audio.sampleRate,
        channelCount: audio.channelCount,
        peaks: audio.peaks,
        peaksPerSecond: audio.peaksPerSecond,
        playbackFilePath: audio.playbackFilePath ?? audio.filePath,
        key: audio.key,
        derivedFrom: audio.derivedFrom,
        collapsed: audio.collapsed,
        warpEnabled: kind === 'saved-clip' ? audio.warpEnabled : undefined,
        warpMode: kind === 'saved-clip' ? audio.warpMode : undefined,
        tempoRatio: kind === 'saved-clip' ? audio.tempoRatio : undefined,
        semitones: kind === 'saved-clip' ? audio.semitones : undefined,
        cents: kind === 'saved-clip' ? audio.cents : undefined,
        unresolved: audio.unresolved === true ? true : undefined
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
        sendBridge('LIBRARY_ADD', {
          itemId: id,
          filePath: audio.filePath,
          kind,
          name: audio.name,
          fileName: audio.fileName,
          durationMs: audio.durationMs,
          sampleRate: audio.sampleRate,
          channelCount: audio.channelCount,
          playbackFilePath: audio.playbackFilePath,
          key: audio.key,
          sourceItemId: audio.derivedFrom?.sourceItemId,
          sourceClipId: audio.derivedFrom?.sourceClipId,
          sourceInMs: audio.derivedFrom?.inMs,
          sourceDurationMs: audio.derivedFrom?.durationMs,
          collapsed: audio.collapsed,
          warpEnabled: kind === 'saved-clip' ? audio.warpEnabled : undefined,
          warpMode: kind === 'saved-clip' ? audio.warpMode : undefined,
          tempoRatio: kind === 'saved-clip' ? audio.tempoRatio : undefined,
          semitones: kind === 'saved-clip' ? audio.semitones : undefined,
          cents: kind === 'saved-clip' ? audio.cents : undefined
        })
      }
      return id
    },

    /** Save a timeline clip as a reusable library item related to its source file. */
    addSavedClipFromTimelineClip(clip: Clip): string | null {
      // Resolve the source library item via the clip's libraryItemId
      // (single source of truth). If the clip's library item is itself
      // a saved-clip, walk up to its source audio-file.
      const direct = this.items.find((item) => item.id === clip.libraryItemId)
      const source =
        direct?.kind === 'audio-file'
          ? direct
          : direct?.derivedFrom?.sourceItemId
            ? this.items.find((i) => i.id === direct.derivedFrom?.sourceItemId)
            : direct
      const sourceItemId = source?.id
      const inMs = Math.max(0, clip.inMs)
      const durationMs = Math.max(0, clip.durationMs)
      if (durationMs <= 0) {
        log.warn('library', `addSavedClipFromTimelineClip refused zero-duration clip id=${clip.id}`)
        return null
      }
      const existing = this.items.find(
        (item) =>
          item.kind === 'saved-clip' &&
          item.derivedFrom?.sourceItemId === sourceItemId &&
          item.derivedFrom?.inMs === inMs &&
          item.derivedFrom?.durationMs === durationMs
      )
      // Prefer the clip's own custom name (set via inline rename on the
       // timeline) so the saved-clip library item inherits whatever the
       // user already chose to call it. Falls back to an auto-generated
       // "<source> @ <position>" label otherwise.
      const customName = clip.name?.trim()
      const name = customName && customName.length > 0
        ? customName
        : buildSavedClipName(source ?? clip, inMs, durationMs)
      const pinnedTempoRatio =
        isClipTempoWarpActive(clip) ? effectiveClipTempoRatio(clip) : clip.tempoRatio
      const shiftedClipKey = shiftedKey(source?.key ?? source?.metadata?.key, clip.semitones, clip.cents)
      if (existing) {
        existing.key = shiftedClipKey ?? source?.key
        existing.semitones = clip.semitones
        existing.cents = clip.cents
        existing.warpEnabled = clip.warpEnabled
        existing.warpMode = clip.warpMode
        existing.tempoRatio = pinnedTempoRatio
        sendBridge('LIBRARY_ADD', {
          itemId: existing.id,
          filePath: existing.filePath,
          kind: existing.kind,
          name: existing.name,
          fileName: existing.fileName,
          durationMs: existing.durationMs,
          sampleRate: existing.sampleRate,
          channelCount: existing.channelCount,
          key: existing.key,
          sourceItemId: existing.derivedFrom?.sourceItemId,
          sourceClipId: existing.derivedFrom?.sourceClipId,
          sourceInMs: existing.derivedFrom?.inMs,
          sourceDurationMs: existing.derivedFrom?.durationMs,
          warpEnabled: existing.warpEnabled,
          warpMode: existing.warpMode,
          tempoRatio: existing.tempoRatio,
          semitones: existing.semitones,
          cents: existing.cents
        })
        return existing.id
      }
      const itemId = this.addItem({
        kind: 'saved-clip',
        name,
        filePath: clip.filePath,
        fileName: source?.fileName ?? clip.fileName,
        durationMs,
        sampleRate: clip.sampleRate,
        channelCount: clip.channelCount,
        peaks: clip.peaks,
        peaksPerSecond: clip.peaksPerSecond,
        playbackFilePath: source?.playbackFilePath ?? clip.playbackFilePath ?? clip.filePath,
        key: shiftedClipKey ?? source?.key,
        derivedFrom: {
          sourceItemId,
          sourceClipId: clip.id,
          inMs,
          durationMs
        },
        // Copy the originating clip's warp settings as the saved-clip
        // defaults (copy-on-drop semantics: future placements of this
        // saved clip start with these values, but later edits on
        // either side do NOT propagate across — warp is per-instance).
        warpEnabled: clip.warpEnabled,
        warpMode: clip.warpMode,
        tempoRatio: pinnedTempoRatio,
        semitones: clip.semitones,
        cents: clip.cents
      })
      // Inherit the source's already-known analysis details so the info
      // dialog opens with populated fields instead of "Not available
      // yet". The saved clip points at the same underlying audio file,
      // so its decoded WAV cache, BPM, beats and variable-tempo flag
      // are guaranteed to match.
      if (itemId && source) {
        const item = this.items.find((i) => i.id === itemId)
        if (item) {
          if (source.decodedCacheFilePath) item.decodedCacheFilePath = source.decodedCacheFilePath
          if (shiftedClipKey) item.key = shiftedClipKey
          if (source.bpm !== undefined) item.bpm = source.bpm
          if (source.beats !== undefined) item.beats = source.beats.slice()
          if (source.beatAnchorSec !== undefined) item.beatAnchorSec = source.beatAnchorSec
          if (source.variableTempo !== undefined) item.variableTempo = source.variableTempo
          if (source.lowConfidence !== undefined) item.lowConfidence = source.lowConfidence
        }
      }
      // Auto-expand the parent source group so the new saved clip is
      // visible immediately. If the user had previously collapsed it
      // this overrides that — adding a clip is an explicit gesture
      // that should reveal its result.
      if (itemId && source && source.collapsed) {
        this.setItemCollapsed(source.id, false)
      }
      return itemId || null
    },

    async saveLibraryItemAsSample(itemId: string): Promise<void> {
      const item = this.items.find((i) => i.id === itemId)
      if (!item) return
      if (item.kind !== 'saved-clip') {
        useNotificationsStore().pushError('Only saved clips can be saved as samples from the library.')
        return
      }
      const project = useProjectStore()
      const sampleId = `sample-${crypto.randomUUID()}`
      const slash = project.currentFilePath
        ? Math.max(project.currentFilePath.lastIndexOf('\\'), project.currentFilePath.lastIndexOf('/'))
        : -1
      const projectDir = slash > 0 && project.currentFilePath ? project.currentFilePath.slice(0, slash) : ''
      const qol = await window.silverdaw.getQolPrefs().catch(() => null)
      const base = projectDir || qol?.paths.defaultProjectDir || ''
      sendBridge('LIBRARY_ITEM_SAVE_AS_SAMPLE', {
        libraryItemId: itemId,
        itemId: sampleId,
        sampleName: libraryItemDisplayName(item),
        outputDir: base ? `${base}\\Samples` : 'Samples'
      })
      useNotificationsStore().pushInfo('Saving sample…')
    },

    /**
     * Fill in decoded audio details for a library item reconstructed from
     * saved project state. Older project files may only have clip duration,
     * so this lets the reload path backfill the tile without re-importing.
     */
    setItemAudioDetails(
      itemId: string,
      durationMs: number,
      sampleRate: number,
      channelCount: number
    ): void {
      const item = this.items.find((i) => i.id === itemId)
      if (!item) return
      if (durationMs > 0) item.durationMs = durationMs
      if (sampleRate > 0) item.sampleRate = sampleRate
      if (channelCount > 0) item.channelCount = channelCount
    },

    /** Replace or clear the detected musical key for a library item. */
    setItemKey(itemId: string, key: string | undefined): void {
      const item = this.items.find((i) => i.id === itemId)
      if (!item) return
      item.key = key
      if (item.metadata) {
        if (key) {
          item.metadata = { ...item.metadata, key }
        } else {
          const { key: _key, ...rest } = item.metadata
          void _key
          item.metadata = rest
        }
      }
    },

    /**
     * Override the user-facing sample/music classification for a
     * library item. Pass `'sample'` / `'music'` to force the mode,
     * or `null` / `'auto'` to clear the override so the renderer
     * falls back to the backend's `lowConfidence` flag. Bumps
     * `peaksRevision` so any clip that referenced the item
     * repaints (drop hides BPM/beats badges, beat-marker grid).
     */
    setItemSampleMode(itemId: string, mode: 'sample' | 'music' | 'auto' | null): void {
      const item = this.items.find((i) => i.id === itemId)
      if (!item) return
      const normalised: 'sample' | 'music' | 'auto' =
        mode === 'sample' || mode === 'music' ? mode : 'auto'
      const nextStored: 'sample' | 'music' | undefined =
        normalised === 'auto' ? undefined : normalised
      if (item.sampleMode === nextStored) return
      item.sampleMode = nextStored
      useProjectStore().peaksRevision++
      sendBridge('LIBRARY_ITEM_SET_SAMPLE_MODE', {
        itemId,
        mode: normalised
      })
    },

    /**
     * Variant of `addSavedClipFromTimelineClip` that takes an explicit
     * source library item id and selection window — used by the Clip
     * Editor's "Save as new clip" action. Returns the new saved-clip
     * id, or the id of an existing matching saved-clip if one already
     * has the same source / inMs / durationMs.
     */
    addSavedClipFromSelection(
      sourceItemId: string,
      inMs: number,
      durationMs: number,
      name?: string
    ): string | null {
      const source = this.items.find((i) => i.id === sourceItemId)
      if (!source) {
        log.warn('library', `addSavedClipFromSelection unknown source=${sourceItemId}`)
        return null
      }
      const trimIn = Math.max(0, Math.floor(inMs))
      const trimDur = Math.max(0, Math.floor(durationMs))
      if (trimDur <= 0) {
        log.warn('library', `addSavedClipFromSelection refused zero-duration source=${sourceItemId}`)
        return null
      }
      const existing = this.items.find(
        (item) =>
          item.kind === 'saved-clip' &&
          item.derivedFrom?.sourceItemId === sourceItemId &&
          item.derivedFrom?.inMs === trimIn &&
          item.derivedFrom?.durationMs === trimDur
      )
      if (existing) return existing.id

      const trimmed = name?.trim()
      const finalName =
        trimmed && trimmed.length > 0 ? trimmed : buildSavedClipName(source, trimIn, trimDur)
      const itemId = this.addItem({
        kind: 'saved-clip',
        name: finalName,
        filePath: source.filePath,
        fileName: source.fileName,
        durationMs: trimDur,
        sampleRate: source.sampleRate,
        channelCount: source.channelCount,
        peaks: source.peaks,
        peaksPerSecond: source.peaksPerSecond,
        playbackFilePath: source.playbackFilePath,
        key: source.key,
        derivedFrom: {
          sourceItemId,
          sourceClipId: '',
          inMs: trimIn,
          durationMs: trimDur
        }
      })
      if (itemId) {
        const item = this.items.find((i) => i.id === itemId)
        if (item) {
          if (source.decodedCacheFilePath) item.decodedCacheFilePath = source.decodedCacheFilePath
          if (source.bpm !== undefined) item.bpm = source.bpm
          if (source.beats !== undefined) item.beats = source.beats.slice()
          if (source.beatAnchorSec !== undefined) item.beatAnchorSec = source.beatAnchorSec
          if (source.variableTempo !== undefined) item.variableTempo = source.variableTempo
          if (source.lowConfidence !== undefined) item.lowConfidence = source.lowConfidence
        }
        if (source.collapsed) this.setItemCollapsed(source.id, false)
      }
      return itemId || null
    },

    /**
     * Update the trim window of an existing saved-clip library item.
     * Refuses (returns false) if the saved-clip is currently referenced
     * by any timeline clip — those clips own their own trim windows and
     * silently rewriting the source-of-truth would corrupt them. The
     * caller is expected to surface a "Save as new clip" hint instead.
     */
    updateSavedClipTrim(
      itemId: string,
      inMs: number,
      durationMs: number
    ): { ok: boolean; conflictingTrackNames?: string[] } {
      const item = this.items.find((i) => i.id === itemId)
      if (!item) return { ok: false }
      if (item.kind !== 'saved-clip') return { ok: false }
      const trimIn = Math.max(0, Math.floor(inMs))
      const trimDur = Math.max(0, Math.floor(durationMs))
      if (trimDur <= 0) return { ok: false }

      // Saved-clip trim edits propagate to every linked timeline clip
      // (see `findLinkedTimelineClips`). Before applying the edit,
      // verify the new duration won't make any linked sibling overlap
      // a neighbour on its track. Refuse the whole edit if any sibling
      // would collide — predictable and non-destructive, and the user
      // can move the conflicting neighbour aside before retrying.
      const project = useProjectStore()
      const linkedClips = findLinkedTimelineClips(item)
      const conflictingTrackNames = new Set<string>()
      for (const c of linkedClips) {
        if (!c) continue
        const track = project.tracks.find((t) => t.id === c.trackId)
        if (!track) continue
        const ratio = isClipTempoWarpActive(c) ? effectiveClipTempoRatio(c) : 1
        const newEnd = c.startMs + trimDur / ratio
        let collides = false
        for (const otherId of track.clipIds) {
          if (otherId === c.id) continue
          const other = project.clips[otherId]
          if (!other) continue
          const otherEnd = other.startMs + effectiveClipDurationMs(other)
          if (c.startMs < otherEnd && newEnd > other.startMs) {
            collides = true
            break
          }
        }
        if (collides) conflictingTrackNames.add(track.name)
      }
      if (conflictingTrackNames.size > 0) {
        log.warn(
          'library',
          `updateSavedClipTrim refused (collisions on ${[...conflictingTrackNames].join(', ')}) id=${itemId}`
        )
        return { ok: false, conflictingTrackNames: [...conflictingTrackNames] }
      }

      const next = item.derivedFrom
        ? { ...item.derivedFrom, inMs: trimIn, durationMs: trimDur }
        : { sourceItemId: '', sourceClipId: '', inMs: trimIn, durationMs: trimDur }
      item.derivedFrom = next
      item.durationMs = trimDur
      sendBridge('LIBRARY_ADD', {
        itemId: item.id,
        filePath: item.filePath,
        kind: item.kind,
        name: item.name,
        fileName: item.fileName,
        durationMs: item.durationMs,
        sampleRate: item.sampleRate,
        channelCount: item.channelCount,
        key: item.key,
        sourceItemId: next.sourceItemId,
        sourceClipId: next.sourceClipId,
        sourceInMs: next.inMs,
        sourceDurationMs: next.durationMs,
        collapsed: item.collapsed
      })
      // Propagate the new trim to every linked timeline clip. The
      // backend coalesces same-clip CLIP_TRIM envelopes within 500 ms
      // into one undo step, but we also want the saved-clip's
      // LIBRARY_ADD upsert and all of these CLIP_TRIMs to fold into
      // the SAME undo step — that's the user's mental "apply trim"
      // action. The dispatcher's coalescing keys CLIP_TRIM on clipId,
      // so each sibling's edit starts its own transaction. For now
      // they're separate undo steps; bundling them is a follow-up
      // (the existing compound-op gap mentioned in the design plan).
      for (const c of linkedClips) {
        if (!c) continue
        // Adopt implicitly-linked clips (legacy projects) by rebinding
        // their libraryItemId to this saved-clip before pushing the
        // new window. Subsequent edits then find them via the direct
        // libraryItemId === item.id path.
        if (c.libraryItemId !== itemId) {
          c.libraryItemId = itemId
          sendBridge('CLIP_REBIND', { clipId: c.id, libraryItemId: itemId })
        }
        c.inMs = trimIn
        c.durationMs = trimDur
        sendBridge('CLIP_TRIM', {
          clipId: c.id,
          startMs: c.startMs,
          inMs: trimIn,
          durationMs: trimDur
        })
      }
      // Force the PixiJS timeline to repaint — the clip-block
      // geometry depends on durationMs and the watch on
      // `project.peaksRevision` is the cheapest redraw trigger.
      if (linkedClips.length > 0) project.peaksRevision++
      log.info(
        'library',
        `updateSavedClipTrim id=${itemId} in=${trimIn} dur=${trimDur} propagatedTo=${linkedClips.length}`
      )
      return { ok: true }
    },

    updateSavedClipEdit(
      itemId: string,
      patch: {
        inMs?: number
        durationMs?: number
        warpEnabled?: boolean
        warpMode?: ClipWarpMode
        tempoRatio?: number | null
        semitones?: number
        cents?: number
      }
    ): { ok: boolean; conflictingTrackNames?: string[] } {
      const item = this.items.find((i) => i.id === itemId)
      if (!item || item.kind !== 'saved-clip') return { ok: false }

      const trimIn = Math.max(0, Math.floor(patch.inMs ?? item.derivedFrom?.inMs ?? 0))
      const trimDur = Math.max(0, Math.floor(patch.durationMs ?? item.derivedFrom?.durationMs ?? item.durationMs))
      if (trimDur <= 0) return { ok: false }

      const nextWarpEnabled = patch.warpEnabled ?? item.warpEnabled
      const nextWarpMode = patch.warpMode ?? item.warpMode
      const nextTempoRatio = patch.tempoRatio !== undefined
        ? (patch.tempoRatio === null ? undefined : patch.tempoRatio)
        : item.tempoRatio
      const nextSemitones = patch.semitones ?? item.semitones
      const nextCents = patch.cents ?? item.cents

      const project = useProjectStore()
      const linkedClips = findLinkedTimelineClips(item)

      const sourceItemId = item.derivedFrom?.sourceItemId
      const source = sourceItemId
        ? this.items.find((candidate) => candidate.id === sourceItemId)
        : undefined
      const nextEffectiveDuration = effectiveDurationMs(trimDur, {
        warpEnabled: nextWarpEnabled,
        tempoRatio: nextTempoRatio,
        sourceBpm: source?.bpm,
        projectBpm: useTransportStore().bpm
      })
      const conflictingTrackNames = new Set<string>()
      for (const c of linkedClips) {
        if (!c) continue
        const track = project.tracks.find((t) => t.id === c.trackId)
        if (!track) continue
        const newEnd = c.startMs + nextEffectiveDuration
        let collides = false
        for (const otherId of track.clipIds) {
          if (otherId === c.id) continue
          const other = project.clips[otherId]
          if (!other) continue
          const otherEnd = other.startMs + effectiveClipDurationMs(other)
          if (c.startMs < otherEnd && newEnd > other.startMs) {
            collides = true
            break
          }
        }
        if (collides) conflictingTrackNames.add(track.name)
      }
      if (conflictingTrackNames.size > 0) {
        log.warn(
          'library',
          `updateSavedClipEdit refused (collisions on ${[...conflictingTrackNames].join(', ')}) id=${itemId}`
        )
        return { ok: false, conflictingTrackNames: [...conflictingTrackNames] }
      }

      const next = item.derivedFrom
        ? { ...item.derivedFrom, inMs: trimIn, durationMs: trimDur }
        : { sourceItemId: '', sourceClipId: '', inMs: trimIn, durationMs: trimDur }
      const prevInMs = item.derivedFrom?.inMs ?? 0
      const prevDurationMs = item.derivedFrom?.durationMs ?? item.durationMs
      const trimChanged = Math.abs(trimIn - prevInMs) >= 0.5 || Math.abs(trimDur - prevDurationMs) >= 0.5
      item.derivedFrom = next
      item.durationMs = trimDur
      if (nextWarpEnabled === undefined) delete item.warpEnabled
      else item.warpEnabled = nextWarpEnabled
      if (nextWarpMode === undefined) delete item.warpMode
      else item.warpMode = nextWarpMode
      if (nextTempoRatio === undefined) delete item.tempoRatio
      else item.tempoRatio = nextTempoRatio
      if (nextSemitones === undefined) delete item.semitones
      else item.semitones = nextSemitones
      if (nextCents === undefined) delete item.cents
      else item.cents = nextCents
      item.key = shiftedKey(source?.key ?? source?.metadata?.key, item.semitones, item.cents) ?? source?.key ?? item.key

      sendBridge('LIBRARY_ADD', {
        itemId: item.id,
        filePath: item.filePath,
        kind: item.kind,
        name: item.name,
        fileName: item.fileName,
        durationMs: item.durationMs,
        sampleRate: item.sampleRate,
        channelCount: item.channelCount,
        key: item.key,
        sourceItemId: next.sourceItemId,
        sourceClipId: next.sourceClipId,
        sourceInMs: next.inMs,
        sourceDurationMs: next.durationMs,
        collapsed: item.collapsed,
        warpEnabled: item.warpEnabled,
        warpMode: item.warpMode,
        tempoRatio: item.tempoRatio,
        semitones: item.semitones,
        cents: item.cents
      })

      for (const c of linkedClips) {
        if (!c) continue
        let shouldSendTrim = trimChanged
        if (c.libraryItemId !== itemId) {
          c.libraryItemId = itemId
          sendBridge('CLIP_REBIND', { clipId: c.id, libraryItemId: itemId })
          shouldSendTrim = true
        }
        c.inMs = trimIn
        c.durationMs = trimDur
        if (shouldSendTrim) {
          sendBridge('CLIP_TRIM', {
            clipId: c.id,
            startMs: c.startMs,
            inMs: trimIn,
            durationMs: trimDur
          })
        }
        project.setClipWarp(c.id, {
          ...(item.warpEnabled !== undefined ? { warpEnabled: item.warpEnabled } : {}),
          ...(item.warpMode !== undefined ? { warpMode: item.warpMode } : {}),
          tempoRatio: item.tempoRatio ?? null,
          ...(item.semitones !== undefined ? { semitones: item.semitones } : {}),
          ...(item.cents !== undefined ? { cents: item.cents } : {})
        })
      }
      if (linkedClips.length > 0) project.peaksRevision++
      log.info('library', `updateSavedClipEdit id=${itemId} propagatedTo=${linkedClips.length}`)
      return { ok: true }
    },

    updateSavedClipWarp(
      itemId: string,
      patch: {
        warpEnabled?: boolean
        warpMode?: ClipWarpMode
        tempoRatio?: number | null
        semitones?: number
        cents?: number
      }
    ): boolean {
      const item = this.items.find((i) => i.id === itemId)
      if (!item || item.kind !== 'saved-clip') return false
      if (patch.warpEnabled !== undefined) item.warpEnabled = patch.warpEnabled
      if (patch.warpMode !== undefined) item.warpMode = patch.warpMode
      if (patch.tempoRatio !== undefined) item.tempoRatio = patch.tempoRatio === null ? undefined : patch.tempoRatio
      if (patch.semitones !== undefined) item.semitones = patch.semitones
      if (patch.cents !== undefined) item.cents = patch.cents
      const source = item.derivedFrom?.sourceItemId
        ? this.items.find((candidate) => candidate.id === item.derivedFrom?.sourceItemId)
        : undefined
      item.key = shiftedKey(source?.key ?? source?.metadata?.key, item.semitones, item.cents) ?? source?.key ?? item.key

      sendBridge('LIBRARY_ADD', {
        itemId: item.id,
        filePath: item.filePath,
        kind: item.kind,
        name: item.name,
        fileName: item.fileName,
        durationMs: item.durationMs,
        sampleRate: item.sampleRate,
        channelCount: item.channelCount,
        key: item.key,
        sourceItemId: item.derivedFrom?.sourceItemId,
        sourceClipId: item.derivedFrom?.sourceClipId,
        sourceInMs: item.derivedFrom?.inMs,
        sourceDurationMs: item.derivedFrom?.durationMs,
        collapsed: item.collapsed,
        warpEnabled: item.warpEnabled,
        warpMode: item.warpMode,
        tempoRatio: item.tempoRatio,
        semitones: item.semitones,
        cents: item.cents
      })

      const project = useProjectStore()
      let propagated = 0
      for (const clipId in project.clips) {
        const clip = project.clips[clipId]
        if (!clip || clip.libraryItemId !== itemId) continue
        project.setClipWarp(clipId, patch)
        propagated++
      }
      if (propagated > 0) project.peaksRevision++
      log.info('library', `updateSavedClipWarp id=${itemId} propagatedTo=${propagated}`)
      return true
    },

    /**
     * Rename a library item. Blank names are coerced to undefined so the
     * tile falls back to the source-file name. Persisted to the backend
     * via a fresh `LIBRARY_ADD` envelope; the backend treats matching ids
     * as an upsert and the new name round-trips through PROJECT_STATE.
     */
    renameItem(itemId: string, name: string): boolean {
      const item = this.items.find((i) => i.id === itemId)
      if (!item) return false
      const trimmed = name.trim()
      const nextName = trimmed.length > 0 ? trimmed : undefined
      if (item.name === nextName) return false
      const previousName = item.name
      item.name = nextName
      // Saved-clip renames propagate to every linked timeline clip
      // that's still displaying the saved-clip's previous name
      // (i.e. the user hasn't given that clip its own per-instance
      // name override via the title-strip double-click). Clips whose
      // `clip.name` differs from `previousName` are treated as
      // user-customised and left untouched.
      if (item.kind === 'saved-clip') {
        const project = useProjectStore()
        let propagated = 0
        for (const clipId in project.clips) {
          const clip = project.clips[clipId]
          if (!clip || clip.libraryItemId !== itemId) continue
          if (clip.name === previousName) {
            clip.name = nextName
            sendBridge('CLIP_RENAME', { clipId, name: nextName ?? '' })
            propagated++
          }
        }
        const touched = touchTimelineClipsForLibraryItem(itemId)
        log.debug('library', `renameItem linked redraw id=${itemId} touched=${touched} propagated=${propagated}`)
      }
      // Omit `playbackFilePath` from rename/collapse upserts: the
      // renderer's `item.playbackFilePath` is just the source filePath
      // (the cached-WAV optimisation lives entirely backend-side), and
      // sending it here would overwrite the backend's decoded-cache
      // path with the original audio file — turning subsequent
      // CLIP_ADDs into slow MP3 reads instead of cheap WAV reads.
      sendBridge('LIBRARY_ADD', {
        itemId: item.id,
        filePath: item.filePath,
        kind: item.kind,
        name: nextName,
        fileName: item.fileName,
        durationMs: item.durationMs,
        sampleRate: item.sampleRate,
        channelCount: item.channelCount,
        key: item.key,
        sourceItemId: item.derivedFrom?.sourceItemId,
        sourceClipId: item.derivedFrom?.sourceClipId,
        sourceInMs: item.derivedFrom?.inMs,
        sourceDurationMs: item.derivedFrom?.durationMs,
        collapsed: item.collapsed
      })
      log.info('library', `renameItem id=${itemId} name=${nextName ?? '<cleared>'}`)
      return true
    },

    /**
     * Toggle the source-group disclosure for a library item. Only
     * meaningful for `audio-file` items; saved-clip items don't have
     * a child list. Persisted to the backend so the open/closed state
     * survives save / load.
     */
    setItemCollapsed(itemId: string, collapsed: boolean): boolean {
      const item = this.items.find((i) => i.id === itemId)
      if (!item) return false
      const next = collapsed ? true : undefined
      if ((item.collapsed ?? false) === (next ?? false)) return false
      item.collapsed = next
      // Same `playbackFilePath` omission as `renameItem` — see comment
      // there. Sending the renderer's value would clobber the
      // backend-managed decoded-WAV cache path.
      sendBridge('LIBRARY_ADD', {
        itemId: item.id,
        filePath: item.filePath,
        kind: item.kind,
        name: item.name,
        fileName: item.fileName,
        durationMs: item.durationMs,
        sampleRate: item.sampleRate,
        channelCount: item.channelCount,
        key: item.key,
        sourceItemId: item.derivedFrom?.sourceItemId,
        sourceClipId: item.derivedFrom?.sourceClipId,
        sourceInMs: item.derivedFrom?.inMs,
        sourceDurationMs: item.derivedFrom?.durationMs,
        collapsed
      })
      log.info('library', `setItemCollapsed id=${itemId} collapsed=${collapsed}`)
      return true
    },

    /** Clear stale tempo/beat metadata while a forced reanalysis is running. */
    clearItemAnalysis(itemId: string): void {
      const item = this.items.find((i) => i.id === itemId)
      if (!item) return
      item.bpm = undefined
      item.beatAnchorSec = undefined
      item.beats = undefined
      item.variableTempo = undefined
      item.lowConfidence = undefined
      useProjectStore().peaksRevision++
    },

    /**
     * Remove an item from the library. Returns true when the item was
     * actually removed.
     *
     * - Saved-clip items: removable iff no timeline clip references
     *   them. (A saved-clip has no children of its own.)
     * - Audio-file source items: removable iff neither the source nor
     *   any of its derived saved-clip children are referenced by a
     *   timeline clip. The cascade is the important detail — a source
     *   row is *not* held hostage by a saved-clip child that's itself
     *   sitting unused in the library. Removing such a source deletes
     *   every unused saved-clip descendant as well so the library
     *   doesn't leak orphaned rows pointing at a now-gone parent.
     *
     * Cover-art object URLs are revoked on each removed row so the
     * underlying Blob is eligible for GC.
     */
    removeItem(itemId: string): boolean {
      const idx = this.items.findIndex((i) => i.id === itemId)
      if (idx < 0) return false
      const item = this.items[idx]
      if (!item) return false

      // Audio-file sources remain blocked while anything depends on
      // them — actual audio data lives behind the source path. Saved
      // clips, on the other hand, are organisational references: we
      // can always remove them by unlinking any linked timeline clips
      // first (the clips keep their current window, just rebound to
      // the saved-clip's underlying audio-file source).
      if (item.kind === 'audio-file' && this.isItemInUse(itemId)) {
        log.warn('library', `removeItem refused (audio-file in use) id=${itemId}`)
        return false
      }

      if (item.kind === 'saved-clip') {
        const project = useProjectStore()
        const linkedClipIds: string[] = []
        for (const clipId in project.clips) {
          if (project.clips[clipId]?.libraryItemId === itemId) linkedClipIds.push(clipId)
        }
        for (const clipId of linkedClipIds) {
          project.unlinkClipFromLibrary(clipId)
        }
      }

      // Cascade: removing an audio-file source also removes every
      // saved-clip derived from it. Each child is guaranteed to be
      // unused at this point (the in-use check above would have
      // refused otherwise), so the cascade is safe. Walk the array
      // back-to-front so child splices don't invalidate later indexes.
      if (item.kind === 'audio-file') {
        for (let i = this.items.length - 1; i >= 0; i--) {
          const child = this.items[i]
          if (!child || child.derivedFrom?.sourceItemId !== itemId) continue
          revokeItemCoverArt(child)
          this.items.splice(i, 1)
          delete this.channelPeaksByItemId[child.id]
          sendBridge('LIBRARY_REMOVE', { itemId: child.id })
          log.info('library', `removeItem id=${child.id} (cascade)`)
        }
      }
      // Re-locate the source row in case the cascade above shifted
      // its index. Safe-guard against the possibility that the row
      // itself got spliced (shouldn't happen — a source doesn't
      // derive from itself — but cheaper to check than to debug).
      const finalIdx = this.items.findIndex((i) => i.id === itemId)
      if (finalIdx < 0) return true
      revokeItemCoverArt(this.items[finalIdx])
      this.items.splice(finalIdx, 1)
      delete this.channelPeaksByItemId[itemId]
      sendBridge('LIBRARY_REMOVE', { itemId })
      log.info('library', `removeItem id=${itemId}`)
      return true
    },

    /**
     * True iff this library item is still referenced somewhere the
     * UI cares about — i.e. removing it would leave a dangling
     * reference on the timeline.
     *
     * For audio-file source items the answer is "any timeline clip
     * points at me, OR any timeline clip points at one of my
     * derived saved-clips". The second clause stops `removeItem`
     * from orphaning an in-use saved-clip when its parent is being
     * deleted; saved-clips that exist in the library but aren't on
     * any track are NOT counted, so a source with only-unused
     * children is freely removable (and the children get cascade-
     * deleted alongside it).
     *
     * For saved-clip items the answer is simply "any timeline clip
     * references me". They have no children to consider.
      */
    isItemInUse(itemId: string): boolean {
      const item = this.items.find((i) => i.id === itemId)
      if (!item) return false
      const project = useProjectStore()
      // Direct timeline reference?
      for (const id in project.clips) {
        if (project.clips[id]?.libraryItemId === itemId) return true
      }
      // Audio-file source: also block removal if any *active*
      // saved-clip descendant exists. An "active" descendant is one
      // currently referenced by a timeline clip — a saved-clip just
      // sitting in the library is fine, because the cascade in
      // `removeItem` will tidy it up.
      if (item.kind === 'audio-file') {
        for (const child of this.items) {
          if (child.derivedFrom?.sourceItemId !== itemId) continue
          for (const id in project.clips) {
            if (project.clips[id]?.libraryItemId === child.id) return true
          }
        }
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
      if (item.key && !rest.key) rest.key = item.key
      if (!item.key && rest.key) item.key = rest.key
      item.metadata = rest
      this.setItemAudioDetails(
        itemId,
        rest.durationMs ?? 0,
        rest.sampleRate ?? 0,
        rest.channelCount ?? 0
      )
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
    setItemPeaks(itemId: string, peaks: Float32Array, sampleRate: number, peaksPerSecond?: number): void {
      const item = this.items.find((i) => i.id === itemId)
      if (!item) return
      item.peaks = peaks
      if (typeof peaksPerSecond === 'number' && peaksPerSecond > 0) item.peaksPerSecond = peaksPerSecond
      if (sampleRate > 0) item.sampleRate = sampleRate
      // Build the LOD pyramid eagerly. Downsampling is O(N) per level
      // and runs once per source-file peaks arrival; the pyramid is
      // shared by every timeline clip that references this item.
      // A queued microtask defers the work past the current frame so
      // the watcher chain that fires on peaks arrival doesn't pay the
      // cost in-line.
      const itemPps = item.peaksPerSecond
      if (peaks.length >= 4 && typeof itemPps === 'number' && itemPps > 0) {
        const buildLod = (): void => {
          // The library item may have been removed while we were
          // queued; bail out if so.
          const live = this.items.find((i) => i.id === itemId)
          if (!live || live.peaks !== peaks) return
          live.peaksLod = buildPeaksLodPyramid(peaks, itemPps)
        }
        if (typeof queueMicrotask === 'function') queueMicrotask(buildLod)
        else buildLod()
      } else {
        item.peaksLod = undefined
      }
      log.debug('library', `setItemPeaks id=${itemId} peaks=${peaks.length / 2} sr=${sampleRate} pps=${item.peaksPerSecond ?? 'undef'}`)
    },

    /**
     * Store per-channel stereo peaks for `itemId` and eagerly build a
     * per-channel LOD pyramid. Only meaningful for 2-channel sources;
     * an empty / non-stereo `channels` array clears any existing entry.
     * Held outside the `LibraryItem` so the summary path is untouched.
     */
    setItemChannelPeaks(itemId: string, channels: Float32Array[], peaksPerSecond: number): void {
      if (!this.items.some((i) => i.id === itemId)) return
      if (channels.length !== 2 || !(peaksPerSecond > 0)) {
        delete this.channelPeaksByItemId[itemId]
        return
      }
      // Skip the (synchronous) per-channel LOD rebuild when an identical entry
      // already exists. Many clips can share one source file, so each
      // WAVEFORM_READY would otherwise rebuild the same two pyramids and stall
      // the UI. Reference + rate equality is a cheap, sufficient identity check.
      const existing = this.channelPeaksByItemId[itemId]
      if (
        existing &&
        existing.peaksPerSecond === peaksPerSecond &&
        existing.channels.length === channels.length &&
        existing.channels.every((ch, i) => ch === channels[i])
      ) {
        return
      }
      const lod = channels.map((ch) => buildPeaksLodPyramid(ch, peaksPerSecond))
      this.channelPeaksByItemId[itemId] = { channels, lod, peaksPerSecond }
      log.debug(
        'library',
        `setItemChannelPeaks id=${itemId} lanes=${channels.length} pps=${peaksPerSecond}`
      )
    },

    /** Set the session-scoped high-resolution peaks payload used by
     *  the Clip Editor. Pass null to clear (called on dialog close /
     *  item switch so the multi-MB Float32Array is GC-eligible). */
    setEditorHiResPeaks(
      payload: {
        libraryItemId: string
        peaksPerSecond: number
        sampleRate: number
        peaks: Float32Array
        channels: Float32Array[]
      } | null
    ): void {
      this.editorHiResPeaks = payload
    },

    /**
     * Record the complete BTrack analysis result for `itemId`: BPM,
     * beat positions (in source-file seconds), and the variable-tempo
     * flag. Called from the bridge when a `LIBRARY_ITEM_ANALYSIS`
     * envelope arrives. Also closes any matching in-flight import
     * progress entry — the BPM/beats arriving is the canonical
     * "analysis is done" signal.
     */
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
      // Store BPM at full precision. The 2-decimal rounding the
      // library tile uses for display happens at format-time
      // (`item.bpm.toFixed(2)`); using the rounded value in the
      // math would introduce a fractional-BPM drift that compounds
      // across many beat / loop boundaries.
      item.bpm = bpm > 0 ? bpm : undefined
      item.beatAnchorSec = beats.length > 0 ? beatAnchorSec : undefined
      item.beats = beats.length > 0 ? beats.slice() : undefined
      item.variableTempo = variableTempo || undefined
      // Auto-classification hint from the backend. Recomputed on every
      // analysis pass (so re-analyse refreshes it), but the user's
      // explicit `sampleMode` override always wins when set.
      item.lowConfidence = lowConfidence === true ? true : undefined
      // Keep the backend's decoded-WAV cache path separate from
      // `playbackFilePath`. The renderer still sends the source path
      // for normal clip adds so the backend can do its library lookup,
      // but the info dialog can show the actual WAV cache path.
      item.decodedCacheFilePath = playbackFilePath?.trim() ? playbackFilePath : undefined
      // Bump the project's redraw counter so the timeline repaints
      // with the freshly-arrived beat markers on the matching clips.
      // Done unconditionally — the cost is a single repaint and
      // checking for matching clips is cheaper to skip than to do.
      useProjectStore().peaksRevision++
      // Surface beat detection as its own visible stage in the import
      // progress panel before finishing the entry. The backend produces
      // BPM and beats in a single pass, but the UX reads more clearly
      // when the user sees two sequential stages ("Analysing tempo…"
      // → "Analysing beats…" → optional "Applying warp…" → done).
      const entry = this.imports.find((e) => e.libraryItemId === itemId)
      if (entry && entry.stage !== 'done' && entry.stage !== 'failed') {
        const project = useProjectStore()
        const hasPendingAutoWarpClip = Object.values(project.clips).some(
          (clip) => clip.libraryItemId === itemId && clip.pendingAutoWarp === true
        )
        entry.stage = 'detectingBeats'
        if (hasPendingAutoWarpClip) {
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
     * id so the LIBRARY_ITEM_ANALYSIS-arrived handler can find this entry.
     */
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
