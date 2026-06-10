// Clip<->library linking domain actions for the project store.
// Spread into the store's `actions`; call sites stay `useProjectStore().X(...)`.
// `this` is the store instance, typed via the shared ProjectClipThis contract.

import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { useLibraryStore, libraryItemIsSample } from '@/stores/libraryStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { fileStem, parentDir } from './projectHelpers'
import type { ClipWarpMode } from '@shared/bridge-protocol'
import type { LibraryItem } from '@/stores/libraryStore'
import type { ProjectClipThis } from './projectClipContract'

async function defaultSamplesDir(currentFilePath: string | null): Promise<string> {
  const projectDir = parentDir(currentFilePath)
  if (projectDir) return `${projectDir}\\Samples`
  const qol = await window.silverdaw.getQolPrefs().catch(() => null)
  const base = qol?.paths.defaultProjectDir || ''
  return base ? `${base}\\Samples` : 'Samples'
}

export const clipLibraryActions = {
    /** Relink once per library item; referenced clips follow that binding. */
    relinkLibraryItem(itemId: string, filePath: string): void {
      sendBridge('LIBRARY_ITEM_RELINK', { itemId, filePath })
      log.info('project', `relinkLibraryItem id=${itemId} -> ${filePath}`)
    },

    saveClipToLibrary(clipId: string): string | null {
      const clip = this.clips[clipId]
      if (!clip) return null
      const itemId = useLibraryStore().addSavedClipFromTimelineClip(clip)
      if (itemId) {
        // Rebind so saved-clip usage views see the originating timeline clip.
        if (clip.libraryItemId !== itemId) {
          clip.libraryItemId = itemId
          sendBridge('CLIP_REBIND', { clipId, libraryItemId: itemId })
        }
        log.info('project', `saveClipToLibrary clip=${clipId} item=${itemId}`)
      }
      return itemId
    },

    async saveClipAsSample(clipId: string): Promise<void> {
      const clip = this.clips[clipId]
      if (!clip) return
      const itemId = `sample-${crypto.randomUUID()}`
      sendBridge('CLIP_SAVE_AS_SAMPLE', {
        clipId,
        itemId,
        sampleName: clip.name?.trim() || fileStem(clip.fileName),
        outputDir: await defaultSamplesDir(this.currentFilePath)
      })
      useNotificationsStore().pushInfo('Saving sample…')
    },

    /** Rebind a saved-clip instance to its source item while preserving its trim window. */
    unlinkClipFromLibrary(clipId: string): boolean {
      const clip = this.clips[clipId]
      if (!clip) return false
      const library = useLibraryStore()
      const parent = library.byId[clip.libraryItemId]
      if (!parent || parent.kind !== 'saved-clip') return false
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
      },
      startMs: number
    ): string | null {
      const track = this.tracks.find((t) => t.id === trackId)
      if (!track) return null
      const snapped = Math.max(0, Math.floor(startMs))
      const clipInMs =
        libraryItem.kind === 'saved-clip' ? Math.max(0, libraryItem.derivedFrom?.inMs ?? 0) : 0
      const clipDurationMs =
        libraryItem.kind === 'saved-clip'
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
          libraryItem.kind !== 'saved-clip' &&
          libraryItem.variableTempo !== true &&
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

      sendBridge('CLIP_ADD', {
        trackId,
        clipId,
        libraryItemId: libraryItem.id,
        positionMs: snapped,
        ...(clipInMs > 0 || libraryItem.kind === 'saved-clip' ? { inMs: clipInMs } : {}),
        ...(libraryItem.kind === 'saved-clip' ? { durationMs: clipDurationMs } : {})
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
      if (libraryItem.kind === 'saved-clip') {
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
        sampleMode?: 'sample' | 'music'
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
          `lowConfidence=${src.lowConfidence ?? false} sampleMode=${src.sampleMode ?? 'auto'} ` +
          `inheritedWarpEnabled=${src.warpEnabled ?? 'undef'} ` +
          `inheritedTempoRatio=${src.tempoRatio ?? 'undef'}`
      )
      // Saved-clip warp defaults are explicit user choices, not auto-match.
      if (src.kind === 'saved-clip' && (
        src.warpEnabled !== undefined ||
        src.warpMode !== undefined ||
        src.tempoRatio !== undefined ||
        src.semitones !== undefined ||
        src.cents !== undefined
      )) {
        log.info('warp', `applyDropTimeWarp clip=${clipId} → saved-clip inheritance branch`)
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
      const sampleClassified = libraryItemIsSample(
        {
          sampleMode: src.sampleMode,
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
        if (src.kind !== 'saved-clip' && src.variableTempo !== true) {
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
