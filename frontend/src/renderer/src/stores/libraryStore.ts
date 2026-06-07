// Library store for reusable audio files and saved clips.
// Renderer owns decoded peaks/metadata; backend owns durable catalogue state.
// Items are decoded once and reused by every placed clip.
//
// **File-size note (documented exception).** Types and pure helpers are already
// extracted; the remaining Pinia actions share one cohesive `this` state. Further
// splitting would add store-typing indirection without improving readability.

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

// Stable facade for existing `@/stores/libraryStore` imports.
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
  importTotal: number
  importDone: number
  imports: ImportEntry[]
  /** HTML5 dragover cannot read non-text `dataTransfer`; store the id here. */
  currentDragItemId: string | null
  /** One multi-MB high-resolution peaks payload for the Clip Editor. */
  editorHiResPeaks: EditorHiResPeaks | null
  /** Stereo peak data kept outside `LibraryItem` so summary paths stay untouched. */
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

/** Finds direct and legacy implicit saved-clip links for propagation/rebind. */
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
      playbackFilePath?: string
      key?: string
      /** Snapshot rebuilds must not echo `LIBRARY_ADD` back to the backend. */
      fromSnapshot?: boolean
      id?: string
      derivedFrom?: SavedClipSource
      collapsed?: boolean
      /** Saved-clip warp defaults copied onto new timeline placements. */
      warpEnabled?: boolean
      warpMode?: ClipWarpMode
      tempoRatio?: number
      semitones?: number
      cents?: number
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

    addSavedClipFromTimelineClip(clip: Clip): string | null {
      // Walk saved clips back to their source audio-file.
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
      // Preserve a user-renamed clip name when saving it to the library.
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
        // Copy-on-drop defaults; later timeline edits stay per-instance.
        warpEnabled: clip.warpEnabled,
        warpMode: clip.warpMode,
        tempoRatio: pinnedTempoRatio,
        semitones: clip.semitones,
        cents: clip.cents
      })
      // Saved clips share source analysis details with their underlying audio file.
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
      // Reveal the newly saved clip even if its source group was collapsed.
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

    /** Saves a Clip Editor selection, reusing an exact matching saved clip. */
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

    /** Updates a saved-clip trim window, refusing linked timeline collisions. */
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

      // Refuse the whole edit if any linked sibling would overlap a neighbour.
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
      // Propagated sibling trims currently become separate undo steps.
      for (const c of linkedClips) {
        if (!c) continue
        // Adopt legacy implicit links before pushing the new window.
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
      // Duration changes need a timeline geometry repaint.
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

      // Source audio stays blocked while timeline clips depend on it.
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

      // Walk back-to-front so cascading child splices don't invalidate indexes.
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
      // Re-locate the source row after cascade splices.
      const finalIdx = this.items.findIndex((i) => i.id === itemId)
      if (finalIdx < 0) return true
      revokeItemCoverArt(this.items[finalIdx])
      this.items.splice(finalIdx, 1)
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
      // Only active saved-clip descendants block source removal.
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

    /** Replaces peaks for PROJECT_STATE items once cached WAVEFORM_DATA arrives. */
    setItemPeaks(itemId: string, peaks: Float32Array, sampleRate: number, peaksPerSecond?: number): void {
      const item = this.items.find((i) => i.id === itemId)
      if (!item) return
      item.peaks = peaks
      if (typeof peaksPerSecond === 'number' && peaksPerSecond > 0) item.peaksPerSecond = peaksPerSecond
      if (sampleRate > 0) item.sampleRate = sampleRate
      // Build shared LOD after the current frame so peak watchers stay cheap.
      const itemPps = item.peaksPerSecond
      if (peaks.length >= 4 && typeof itemPps === 'number' && itemPps > 0) {
        const buildLod = (): void => {
          // Item may have been removed while queued.
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

    /** Stores stereo peaks and per-channel LOD; non-stereo clears the entry. */
    setItemChannelPeaks(itemId: string, channels: Float32Array[], peaksPerSecond: number): void {
      if (!this.items.some((i) => i.id === itemId)) return
      if (channels.length !== 2 || !(peaksPerSecond > 0)) {
        delete this.channelPeaksByItemId[itemId]
        return
      }
      // Avoid rebuilding identical shared LOD pyramids for every clip waveform event.
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

    /** `null` clears the multi-MB Clip Editor peaks payload for GC. */
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
      // Backend hint refreshes on reanalysis; explicit `sampleMode` still wins.
      item.lowConfidence = lowConfidence === true ? true : undefined
      // Keep backend decoded-WAV cache path separate from renderer clip-add paths.
      item.decodedCacheFilePath = playbackFilePath?.trim() ? playbackFilePath : undefined
      // One unconditional repaint is cheaper than searching for matching clips.
      useProjectStore().peaksRevision++
      // Split the single backend analysis pass into clearer visible stages.
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

    /** Mirrors the dragged item id because `dragover` cannot read dataTransfer. */
    setDragItem(itemId: string | null): void {
      this.currentDragItemId = itemId
    }
  }
})
