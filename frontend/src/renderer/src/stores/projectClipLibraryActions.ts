// Clip<->library linking domain actions for the project store.
// Spread into the store's `actions`; call sites stay `useProjectStore().X(...)`.
// `this` is the store instance, typed via the shared ProjectClipThis contract.

import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { runInUndoGroup } from '@/lib/undo/undoGroup'
import { useLibraryStore, libraryItemIsSimple } from '@/stores/libraryStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { variableTempoWarpSkippedMessage } from '@/lib/warp'
import { fileStem } from './projectHelpers'
import type { ClipWarpMode } from '@shared/bridge-protocol'
import type { LibraryItem } from '@/stores/libraryStore'
import type { ProjectClipThis } from './projectClipContract'

export const clipLibraryActions = {
    /** Relink once per library item; referenced clips follow that binding. */
    relinkLibraryItem(itemId: string, filePath: string): void {
      sendBridge('LIBRARY_ITEM_RELINK', { itemId, filePath })
      log.info('project', `relinkLibraryItem id=${itemId} -> ${filePath}`)
    },

    saveClipToLibrary(clipId: string): string | null {
      const clip = this.clips[clipId]
      if (!clip) return null
      const itemId = useLibraryStore().addLibraryClipFromTimelineClip(clip)
      if (itemId) {
        // Rebind so library-clip usage views see the originating timeline clip.
        if (clip.libraryItemId !== itemId) {
          clip.libraryItemId = itemId
          sendBridge('CLIP_REBIND', { clipId, libraryItemId: itemId })
        }
        log.info('project', `saveClipToLibrary clip=${clipId} item=${itemId}`)
      }
      return itemId
    },

    saveClipAsSample(clipId: string, audioType: 'simple' | 'music'): void {
      const clip = this.clips[clipId]
      if (!clip) return
      const itemId = `sample-${crypto.randomUUID()}`
      sendBridge('CLIP_SAVE_AS_SAMPLE', {
        clipId,
        itemId,
        sampleName: clip.name?.trim() || fileStem(clip.fileName),
        audioType
      })
    },

    /**
     * Harvest a clip's slices (the segments between source-ms cut markers, plus
     * head and tail) as individual library samples in one backend batch. Returns
     * the number of samples requested.
     */
    sliceClipToSamples(
      clipId: string,
      markersSourceMs: readonly number[],
      audioType: 'simple' | 'music' = 'simple'
    ): number {
      const clip = this.clips[clipId]
      if (!clip) return 0
      const clipEnd = clip.inMs + clip.durationMs
      const cuts = markersSourceMs
        .filter((m) => m > clip.inMs && m < clipEnd)
        .slice()
        .sort((a, b) => a - b)
      const bounds = [clip.inMs, ...cuts, clipEnd]
      const slices: { itemId: string; inMs: number; durationMs: number }[] = []
      for (let i = 0; i < bounds.length - 1; i++) {
        const inMs = bounds[i]!
        const durationMs = bounds[i + 1]! - inMs
        if (durationMs <= 0) continue
        slices.push({ itemId: `sample-${crypto.randomUUID()}`, inMs, durationMs })
      }
      if (slices.length === 0) return 0
      sendBridge('CLIP_SLICE_TO_SAMPLES', { clipId, audioType, slices })
      return slices.length
    },

    /** Rebind a library-clip instance to its source item while preserving its trim window. */
    unlinkClipFromLibrary(clipId: string): boolean {
      const clip = this.clips[clipId]
      if (!clip) return false
      const library = useLibraryStore()
      const parent = library.byId[clip.libraryItemId]
      if (!parent || parent.kind !== 'clip') return false
      const fallbackParentId = parent.derivedFrom?.sourceItemId
      if (!fallbackParentId) return false
      clip.libraryItemId = fallbackParentId
      sendBridge('CLIP_REBIND', { clipId, libraryItemId: fallbackParentId })
      // Library binding changes need an explicit redraw for the link badge.
      this.peaksRevision++
      log.info('project', `unlinkClipFromLibrary clip=${clipId} -> source=${fallbackParentId}`)
      return true
    },

    /** Drop a library item onto a track using its decoded peaks. */
    addClipFromLibrary(
      trackId: string,
      libraryItem: {
        id: string
        filePath: string
        fileName: string
        durationMs: number
        sampleRate: number
        channelCount: number
        peaks: Float32Array
        peaksPerSecond?: number
        playbackFilePath?: string
        kind?: LibraryItem['kind']
        name?: string
        derivedFrom?: LibraryItem['derivedFrom']
        /** Source BPM for auto-warp; variable-tempo files expose their median. */
        bpm?: number
        /** Auto-warp skips unstable-tempo sources. */
        variableTempo?: boolean
        /** Saved-clip warp defaults copy on drop. */
        warpEnabled?: boolean
        warpMode?: ClipWarpMode
        tempoRatio?: number
        semitones?: number
        cents?: number
        /** 'simple'-classified items never auto-warp on drop. */
        audioType?: 'simple' | 'music'
      },
      startMs: number
    ): string | null {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return null
      const snapped = Math.max(0, Math.floor(startMs))
      const clipInMs =
        libraryItem.kind === 'clip' ? Math.max(0, libraryItem.derivedFrom?.inMs ?? 0) : 0
      const clipDurationMs =
        libraryItem.kind === 'clip'
          ? Math.max(0, libraryItem.derivedFrom?.durationMs ?? libraryItem.durationMs)
          : libraryItem.durationMs
      // Predict post-drop effective duration so collision checks match auto-warp.
      const projectBpm = useTransportStore().bpm
      const autoWarpPref = useUiStore().matchProjectTempoOnDrop
      const projectHasOtherClips = Object.keys(this.clips).length > 0
      const willAutoWarp =
        libraryItem.warpEnabled === true ||
        (autoWarpPref &&
          projectHasOtherClips &&
          libraryItem.kind !== 'clip' &&
          libraryItem.variableTempo !== true &&
          !libraryItemIsSimple(
            { audioType: libraryItem.audioType, derivedFrom: libraryItem.derivedFrom },
            useLibraryStore().byId
          ) &&
          typeof libraryItem.bpm === 'number' && libraryItem.bpm > 0 &&
          typeof projectBpm === 'number' && projectBpm > 0)
      let effectiveClipDurationMs = clipDurationMs
      if (willAutoWarp) {
        const pinned = libraryItem.tempoRatio
        const ratio = typeof pinned === 'number' && pinned > 0
          ? pinned
          : (typeof libraryItem.bpm === 'number' && libraryItem.bpm > 0 && projectBpm > 0
              ? projectBpm / libraryItem.bpm
              : 1)
        if (ratio > 0 && Math.abs(ratio - 1) > 1e-4) {
          effectiveClipDurationMs = clipDurationMs / ratio
        }
      }
      if (this.wouldClipOverlap(trackId, snapped, effectiveClipDurationMs)) return null

      const inheritedName = libraryItem.name?.trim() || ''
      const clipId = this.addClipToTrack(
        trackId,
        {
          libraryItemId: libraryItem.id,
          filePath: libraryItem.filePath,
          fileName: inheritedName || libraryItem.fileName,
          durationMs: clipDurationMs,
          sampleRate: libraryItem.sampleRate,
          channelCount: libraryItem.channelCount,
          peaks: libraryItem.peaks,
          peaksPerSecond: libraryItem.peaksPerSecond,
          playbackFilePath: libraryItem.playbackFilePath,
          inMs: clipInMs
        },
        snapped
      )
      if (!clipId) return null

      // One undo step for the whole drop: clip add, inherited name, drop-time warp, inherited
      // envelope, and the track-gain re-push all fold into a single transaction.
      runInUndoGroup('Add clip', () => {
        sendBridge('CLIP_ADD', {
          trackId,
          clipId,
          libraryItemId: libraryItem.id,
          positionMs: snapped,
          ...(clipInMs > 0 || libraryItem.kind === 'clip' ? { inMs: clipInMs } : {}),
          ...(libraryItem.kind === 'clip' ? { durationMs: clipDurationMs } : {})
        })
        if (inheritedName) {
          const newClip = this.clips[clipId]
          if (newClip) newClip.name = inheritedName
          sendBridge('CLIP_RENAME', { clipId, name: inheritedName })
        }

        // Drop-time warp copies saved defaults or marks eligible audio for auto-warp.
        this.applyDropTimeWarp(clipId, libraryItem)

        // Inherit the saved clip's shared volume envelope from an existing instance
        // so every linked placement carries the same shape.
        if (libraryItem.kind === 'clip') {
          const sibling = Object.values(this.clips).find(
            (c) =>
              !!c &&
              c.id !== clipId &&
              c.libraryItemId === libraryItem.id &&
              Array.isArray(c.envelopePoints) &&
              c.envelopePoints.length >= 2
          )
          if (sibling?.envelopePoints) this.setClipEnvelope(clipId, sibling.envelopePoints)
        }

        this.pushTrackGain(track)
      })
      log.info('project', `addClipFromLibrary track=${trackId} clip=${clipId} pos=${snapped}ms`)
      return clipId
    },

    /** Apply the single drop-time warp policy before notifying the backend. */
    applyDropTimeWarp(
      clipId: string,
      src: {
        id?: string
        kind?: LibraryItem['kind']
        bpm?: number
        variableTempo?: boolean
        lowConfidence?: boolean
        audioType?: 'simple' | 'music'
        warpEnabled?: boolean
        warpMode?: ClipWarpMode
        tempoRatio?: number
        semitones?: number
        cents?: number
        derivedFrom?: LibraryItem['derivedFrom']
      }
    ): void {
      log.info(
        'warp',
        `applyDropTimeWarp clip=${clipId} kind=${src.kind ?? 'audio'} ` +
          `srcBpm=${src.bpm ?? 'undef'} variableTempo=${src.variableTempo ?? false} ` +
          `lowConfidence=${src.lowConfidence ?? false} audioType=${src.audioType ?? 'auto'} ` +
          `inheritedWarpEnabled=${src.warpEnabled ?? 'undef'} ` +
          `inheritedTempoRatio=${src.tempoRatio ?? 'undef'}`
      )
      // Saved-clip warp defaults are explicit user choices, not auto-match.
      if (src.kind === 'clip' && (
        src.warpEnabled !== undefined ||
        src.warpMode !== undefined ||
        src.tempoRatio !== undefined ||
        src.semitones !== undefined ||
        src.cents !== undefined
      )) {
        log.info('warp', `applyDropTimeWarp clip=${clipId} → library-clip inheritance branch`)
        this.setClipWarp(clipId, {
          warpEnabled: src.warpEnabled,
          warpMode: src.warpMode,
          tempoRatio: src.tempoRatio,
          semitones: src.semitones,
          cents: src.cents
        })
        return
      }
      // Sample-classified sources skip tempo auto-match; manual warp still
      // works. Low detection confidence no longer counts as a sample, so a
      // low-confidence musical source still auto-warps to the project tempo.
      const sampleClassified = libraryItemIsSimple(
        {
          audioType: src.audioType,
          derivedFrom: src.derivedFrom
        },
        useLibraryStore().byId
      )
      if (sampleClassified) {
        log.info(
          'warp',
          `applyDropTimeWarp clip=${clipId} → skip (library item classified as sample)`
        )
        return
      }
      const ui = useUiStore()
      if (!ui.matchProjectTempoOnDrop) {
        log.info('warp', `applyDropTimeWarp clip=${clipId} → skip (matchProjectTempoOnDrop pref OFF)`)
        return
      }
      // First audio clip seeds project BPM, so auto-warp would target a transient default.
      const otherClipExists = Object.values(this.clips).some((c) => c.id !== clipId)
      if (!otherClipExists) {
        log.info('warp', `applyDropTimeWarp clip=${clipId} → skip (first clip on project)`)
        return
      }
      // Need stable source BPM and project BPM to target.
      const projectBpm = useTransportStore().bpm
      if (src.variableTempo === true || typeof src.bpm !== 'number' || src.bpm <= 0) {
        // Unknown source BPM: let later analysis opt in unless the user edits warp.
        if (src.kind !== 'clip' && src.variableTempo !== true) {
          log.info(
            'warp',
            `applyDropTimeWarp clip=${clipId} → pendingAutoWarp (source BPM not yet known)`
          )
          this.setClipWarp(clipId, { pendingAutoWarp: true })
        } else {
          log.info(
            'warp',
            `applyDropTimeWarp clip=${clipId} → skip (variableTempo or no BPM, not pending)`
          )
          // Variable tempo is a deliberate auto-warp exclusion; tell the user why
          // and how to warp it manually instead of silently doing nothing.
          if (src.variableTempo === true) {
            const clip = this.clips[clipId]
            const name = clip?.name?.trim() || (clip ? fileStem(clip.fileName) : '')
            useNotificationsStore().pushInfo(variableTempoWarpSkippedMessage(name))
          }
        }
        return
      }
      if (typeof projectBpm !== 'number' || projectBpm <= 0) {
        log.info(
          'warp',
          `applyDropTimeWarp clip=${clipId} → skip (project BPM unknown: ${projectBpm})`
        )
        return
      }
      const ratio = projectBpm / src.bpm
      // Ratio ≈ 1 is inaudible and should not burn an undo step.
      if (Math.abs(ratio - 1) < 1e-3) {
        log.info(
          'warp',
          `applyDropTimeWarp clip=${clipId} → skip (ratio ≈ 1: project=${projectBpm} src=${src.bpm})`
        )
        return
      }
      log.info(
        'warp',
        `applyDropTimeWarp clip=${clipId} → ENGAGE warp (project=${projectBpm} src=${src.bpm} ratio=${ratio.toFixed(4)})`
      )
      this.setClipWarp(clipId, {
        warpEnabled: true,
        warpMode: 'rhythmic',
        // Undefined keeps the clip following project BPM; pinning is user-driven.
      })
    },
} satisfies Record<string, (this: ProjectClipThis, ...args: never[]) => unknown> &
  ThisType<ProjectClipThis>
