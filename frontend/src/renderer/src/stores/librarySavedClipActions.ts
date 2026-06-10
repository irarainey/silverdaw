// Saved-clip domain actions for the library store (create from timeline/
// selection, trim, edit, warp). Spread into the store; `this` is the store.

import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import {
  effectiveClipDurationMs,
  effectiveClipTempoRatio,
  isClipTempoWarpActive
} from '@/stores/projectStore'
import type { Clip } from '@/stores/projectStore'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { shiftedKey } from '@/lib/pitchKey'
import { effectiveDurationMs } from '@/lib/warp'
import type { ClipWarpMode, ClipEnvelopePoint } from '@shared/bridge-protocol'
import type { AddLibraryItemInput, LibraryItem, LibraryState } from './libraryTypes'
import { buildSavedClipName } from './libraryItemHelpers'

type SavedClipThis = LibraryState & {
  addItem(audio: AddLibraryItemInput): string
  setItemCollapsed(itemId: string, collapsed: boolean): boolean
}

/** Finds direct and legacy implicit saved-clip links for propagation/rebind. */
function findLinkedTimelineClips(savedClipItem: LibraryItem): Clip[] {
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

export const savedClipActions = {
    addSavedClipFromTimelineClip(clip: Clip): string | null {
      // Walk saved clips back to their underlying source file. An audio-file or
      // a stem already IS a standalone source file (a stem's derivedFrom only
      // points at the original track for inherited identity, not its audio), so
      // it is used directly; only a saved-clip resolves back to its source.
      const direct = this.items.find((item) => item.id === clip.libraryItemId)
      const source =
        direct?.kind === 'saved-clip' && direct.derivedFrom?.sourceItemId
          ? (this.items.find((i) => i.id === direct.derivedFrom?.sourceItemId) ?? direct)
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

    // Shared volume-shape edit for a saved clip: propagate the envelope to every
    // linked timeline instance, so editing volume on one linked clip changes them
    // all (like trim/warp/pitch). The durable store is each clip's backend
    // envelope (CLIP_SET_ENVELOPE) — the shape lives on the live instances, not on
    // the library item, so a saved clip with no placed instance carries no shape.
    updateSavedClipEnvelope(itemId: string, points: ClipEnvelopePoint[]): { ok: boolean } {
      const item = this.items.find((i) => i.id === itemId)
      if (!item || item.kind !== 'saved-clip') return { ok: false }
      const project = useProjectStore()
      const linkedClips = findLinkedTimelineClips(item)
      for (const c of linkedClips) {
        if (!c) continue
        project.setClipEnvelope(c.id, points)
      }
      log.info(
        'library',
        `updateSavedClipEnvelope id=${itemId} points=${points.length} propagatedTo=${linkedClips.length}`
      )
      return { ok: true }
    },

    // Shared reverse for a saved clip: propagate the flag to every linked timeline instance, so
    // reversing one linked clip reverses them all (like trim/warp/pitch/envelope). The durable
    // store is each clip's backend reverse flag (CLIP_SET_REVERSED); the flag lives on the live
    // instances, not the library item.
    updateSavedClipReversed(itemId: string, reversed: boolean): { ok: boolean } {
      const item = this.items.find((i) => i.id === itemId)
      if (!item || item.kind !== 'saved-clip') return { ok: false }
      const project = useProjectStore()
      const linkedClips = findLinkedTimelineClips(item)
      for (const c of linkedClips) {
        if (!c) continue
        project.setClipReversed(c.id, reversed)
      }
      log.info(
        'library',
        `updateSavedClipReversed id=${itemId} reversed=${reversed} propagatedTo=${linkedClips.length}`
      )
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
} satisfies Record<string, (this: SavedClipThis, ...args: never[]) => unknown> &
  ThisType<SavedClipThis>
