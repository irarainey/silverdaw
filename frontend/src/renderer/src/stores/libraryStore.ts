// Library store for reusable audio files and saved clips.
// Renderer owns decoded peaks/metadata; backend owns durable catalogue state.
// Items are decoded once and reused by every placed clip.
//
// Domain actions live in sibling modules spread into `actions` below:
//   librarySavedClipActions — create/trim/edit/warp saved clips
//   libraryImportActions     — import + analysis-progress lifecycle
//   libraryPeaksActions      — waveform / peaks caching
// This module keeps state, getters, and the catalogue/metadata core.

import { defineStore } from 'pinia'
import { useProjectStore } from '@/stores/projectStore'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import type {
  AddLibraryItemInput,
  LibraryItem,
  LibraryState
} from './libraryTypes'
import { revokeItemCoverArt } from './libraryItemHelpers'

// Stable facade for existing `@/stores/libraryStore` imports.
export type {
  EditorHiResPeaks,
  ImportEntry,
  ImportStage,
  ItemChannelPeaks,
  LibraryItem,
  SavedClipSource
} from './libraryTypes'
export { libraryItemDisplayName, libraryItemIsSample, libraryItemSourceBpm, stemPartLabel, STEM_NAME_SEPARATOR } from './libraryItemHelpers'

import { savedClipActions } from './librarySavedClipActions'
import { importActions } from './libraryImportActions'
import { peaksActions } from './libraryPeaksActions'

function touchTimelineClipsForLibraryItem(itemId: string): number {
  const project = useProjectStore()
  let count = 0
  for (const clip of Object.values(project.clips)) {
    if (clip?.libraryItemId === itemId) count++
  }
  if (count > 0) project.peaksRevision++
  return count
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
    byId(state): Record<string, LibraryItem> {
      const map: Record<string, LibraryItem> = {}
      for (const item of state.items) map[item.id] = item
      return map
    },

    /** True while decoding or backend analysis is in flight. */
    isImporting(state): boolean {
      if (state.importTotal > 0) return true
      // `imports` outlives the batch counter while backend analysis runs.
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

    importFraction(state): number {
      if (state.importTotal <= 0) return 0
      return Math.min(1, state.importDone / state.importTotal)
    }
  },

  actions: {
    ...savedClipActions,
    ...importActions,
    ...peaksActions,
    /** Clears state before a reset PROJECT_STATE rebuilds the catalogue. */
    clear(): void {
      // Revoke cover-art URLs so Blobs can be collected.
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

    /** Reuses audio-file items by `filePath`; saved clips are distinct by trim window. */
    addItem(audio: AddLibraryItemInput): string {
      const kind = audio.kind ?? 'audio-file'
      if (kind === 'saved-clip' && !audio.derivedFrom) {
        log.warn('library', `addItem refused saved clip without source window file=${audio.filePath}`)
        return ''
      }
      if (kind === 'stem' && !audio.derivedFrom?.sourceItemId) {
        log.warn('library', `addItem refused stem without source item file=${audio.filePath}`)
        return ''
      }
      const existing =
        kind === 'audio-file'
          ? this.items.find((i) => i.kind === 'audio-file' && i.filePath === audio.filePath)
          : kind === 'stem'
            ? this.items.find((i) => i.kind === 'stem' && i.filePath === audio.filePath)
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

      // Adopt snapshot ids and advance the auto-mint counter past them.
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
      // Snapshot-driven adds already mirror backend truth, so they do not echo.
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

    /** Backfills decoded details for items reconstructed from saved project state. */
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

    /** Overrides sample/music classification; `auto` falls back to `lowConfidence`. */
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

    /** Blank names clear the override; `LIBRARY_ADD` persists the upsert. */
    renameItem(itemId: string, name: string): boolean {
      const item = this.items.find((i) => i.id === itemId)
      if (!item) return false
      const trimmed = name.trim()
      const nextName = trimmed.length > 0 ? trimmed : undefined
      if (item.name === nextName) return false
      const previousName = item.name
      item.name = nextName
      // Propagate only to linked clips still using the saved-clip name.
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
      // Omit `playbackFilePath` so backend decoded-cache paths stay intact.
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

    /** Persists source-group disclosure state. */
    setItemCollapsed(itemId: string, collapsed: boolean): boolean {
      const item = this.items.find((i) => i.id === itemId)
      if (!item) return false
      const next = collapsed ? true : undefined
      if ((item.collapsed ?? false) === (next ?? false)) return false
      item.collapsed = next
      // Omit `playbackFilePath` so backend decoded-cache paths stay intact.
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

    /** Removes unused items; audio-file sources cascade-delete unused saved clips. */
    removeItem(itemId: string): boolean {
      const idx = this.items.findIndex((i) => i.id === itemId)
      if (idx < 0) return false
      const item = this.items[idx]
      if (!item) return false

      // Source audio and stems stay blocked while timeline clips depend on them.
      if ((item.kind === 'audio-file' || item.kind === 'stem') && this.isItemInUse(itemId)) {
        log.warn('library', `removeItem refused (${item.kind} in use) id=${itemId}`)
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

      // An audio-file source lends inherited identity to its stems; promote it
      // before the source disappears so each stem keeps reading standalone.
      if (item.kind === 'audio-file') {
        // Stems own their audio but inherit identity (tags, cover art, BPM, key,
        // beats, sample classification) from the source via live lookups.
        let coverHandedOff = false
        for (const child of this.items) {
          if (child.kind !== 'stem' || child.derivedFrom?.sourceItemId !== itemId) continue
          if (!child.metadata && item.metadata) child.metadata = item.metadata
          if ((child.bpm == null || child.bpm <= 0) && typeof item.bpm === 'number') {
            child.bpm = item.bpm
          }
          if (child.beats == null && item.beats) child.beats = item.beats
          if (child.beatAnchorSec == null && typeof item.beatAnchorSec === 'number') {
            child.beatAnchorSec = item.beatAnchorSec
          }
          if (child.variableTempo == null && item.variableTempo != null) {
            child.variableTempo = item.variableTempo
          }
          if (child.sampleMode == null && item.sampleMode) child.sampleMode = item.sampleMode
          if (child.lowConfidence == null && item.lowConfidence != null) {
            child.lowConfidence = item.lowConfidence
          }
          if (!child.key && item.key) child.key = item.key
          if (!child.coverArtUrl && item.coverArtUrl) {
            child.coverArtUrl = item.coverArtUrl
            coverHandedOff = true
          }
        }
        // The cover Blob is now shared by the surviving stems; drop the source's
        // claim so the revoke below can't free an object URL still in use.
        if (coverHandedOff) item.coverArtUrl = undefined
      }

      // Saved clips replay their source's file (an audio-file OR a stem), so
      // they cannot outlive it. Walk back-to-front so splices stay valid.
      if (item.kind === 'audio-file' || item.kind === 'stem') {
        for (let i = this.items.length - 1; i >= 0; i--) {
          const child = this.items[i]
          if (!child || child.kind !== 'saved-clip' || child.derivedFrom?.sourceItemId !== itemId) {
            continue
          }
          revokeItemCoverArt(child)
          this.items.splice(i, 1)
          delete this.channelPeaksByItemId[child.id]
          sendBridge('LIBRARY_REMOVE', { itemId: child.id })
          log.info('library', `removeItem id=${child.id} (cascade)`)
        }
      }
      // Re-locate the source row after cascade splices.
      const finalIdx = this.items.findIndex((i) => i.id === itemId)
      if (finalIdx < 0) return true
      const removed = this.items[finalIdx]
      this.items.splice(finalIdx, 1)
      // Revoke cover art only when no surviving item (e.g. a stem we just handed
      // ownership to) still references the same Blob URL.
      if (removed?.coverArtUrl && !this.items.some((i) => i.coverArtUrl === removed.coverArtUrl)) {
        revokeItemCoverArt(removed)
      }
      delete this.channelPeaksByItemId[itemId]
      sendBridge('LIBRARY_REMOVE', { itemId })
      log.info('library', `removeItem id=${itemId}`)
      return true
    },

    /** True when removal would leave a timeline reference dangling. */
    isItemInUse(itemId: string): boolean {
      const item = this.items.find((i) => i.id === itemId)
      if (!item) return false
      const project = useProjectStore()
      for (const id in project.clips) {
        if (project.clips[id]?.libraryItemId === itemId) return true
      }
      // Only active saved-clip descendants block removal. Stems are standalone
      // WAV files that merely inherit identity (name/tags/art) from the source,
      // so a stem on the timeline does NOT keep the source in use. But a stem,
      // like a source, can itself back saved clips that replay its file.
      if (item.kind === 'audio-file' || item.kind === 'stem') {
        for (const child of this.items) {
          if (child.kind !== 'saved-clip' || child.derivedFrom?.sourceItemId !== itemId) continue
          for (const id in project.clips) {
            if (project.clips[id]?.libraryItemId === child.id) return true
          }
        }
      }
      return false
    },

    getItem(itemId: string): LibraryItem | null {
      return this.items.find((i) => i.id === itemId) ?? null
    },

    /** Stores parsed tags; cover-art bytes become a revocable object URL. */
    setItemMetadata(itemId: string, metadata: AudioMetadata | null): void {
      const item = this.items.find((i) => i.id === itemId)
      if (!item) return

      revokeItemCoverArt(item)
      item.coverArtUrl = undefined

      if (metadata == null) {
        item.metadata = metadata
        return
      }

      // Keep cover bytes out of Vue reactivity; expose only the Blob URL.
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

      // Promote only untouched auto-named single-clip tracks to the parsed title.
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

    /** Mirrors the dragged item id because `dragover` cannot read dataTransfer. */
    setDragItem(itemId: string | null): void {
      this.currentDragItemId = itemId
    }
  }
})
