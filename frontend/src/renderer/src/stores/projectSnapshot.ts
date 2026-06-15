// Project-state snapshot application. Extracted from projectStore.ts: this is the
// PROJECT_STATE -> renderer-state reconciliation (the single largest store action).
// The store action is a thin wrapper that calls applyProjectStateSnapshot then
// resolves any in-flight recovery load.

import { decodeAudioToPeaks } from '@/lib/audioDecode'
import { send as sendBridge } from '@/lib/bridgeService'
import { sanitizeEnvelopePoints } from '@/lib/envelope'
import { log } from '@/lib/log'
import { useLibraryStore } from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'
import type { ProjectStatePayload } from '@shared/bridge-protocol'
import type { AudioMetadata } from '@shared/types'
import {
  DEFAULT_PROJECT_NAME,
  DEFAULT_TRACK_LENGTH_MS,
  MAX_TRACK_VOLUME,
  TRACK_PALETTE
} from './projectTypes'
import type { Clip, ProjectState } from './projectTypes'
import {
  deriveProjectIdFromPath,
  filePathToBasename,
  filePathToDisplayName,
  freshUntitledProjectId,
  hydrateTransitions
} from './projectHelpers'

/** Subset of the project store this module mutates: state plus one sibling action. */
type SnapshotTarget = ProjectState & {
  setProjectLengthMs(ms: number): void
}

/** The stem-folder path for a stem WAV (its sibling sidecar lives there). */
function stemDirOf(filePath: string): string {
  return filePath.replace(/[\\/][^\\/]*$/, '')
}

/** Strip the source file's audio geometry from inherited metadata so a stem keeps
 *  its OWN duration/sample-rate/channel-count (decoded from its own file) while
 *  still inheriting identity tags + cover art. */
function withoutAudioGeometry(meta: AudioMetadata): AudioMetadata {
  const { durationMs: _d, sampleRate: _s, channelCount: _c, ...rest } = meta
  return rest
}

async function refreshLibraryItemMedia(
  itemId: string,
  filePath: string,
  opts?: { stem?: boolean }
): Promise<void> {
  const library = useLibraryStore()
  try {
    let metadata: AudioMetadata | null = null
    // A separated stem's WAV carries no tags; prefer the sidecar copy written at
    // separation time so the inherited identity survives source removal. The
    // sidecar's audio geometry describes the SOURCE, so drop it and let the
    // stem's own decode below supply duration/peaks.
    if (opts?.stem) {
      try {
        const sidecar = await window.silverdaw.readStemSidecar(stemDirOf(filePath))
        if (sidecar) metadata = withoutAudioGeometry(sidecar)
      } catch (err) {
        log.warn('library', `readStemSidecar failed for ${filePath}: ${String(err)}`)
      }
    }
    if (!metadata) metadata = await window.silverdaw.readAudioMetadata(filePath)
    library.setItemMetadata(itemId, metadata)
  } catch (err) {
    log.warn('library', `readAudioMetadata failed for ${filePath}: ${String(err)}`)
  }

  const item = library.getItem(itemId)
  if (!item || item.durationMs > 0) return

  try {
    const opened = await window.silverdaw.readAudioFile(filePath)
    if (!opened) return
    const decoded = await decodeAudioToPeaks(opened.data)
    library.setItemAudioDetails(itemId, decoded.durationMs, decoded.sampleRate, decoded.channelCount)
    if (item.peaks.length === 0) {
      library.setItemPeaks(itemId, decoded.peaks, decoded.sampleRate, decoded.peaksPerSecond)
    }
    // Populate the stereo display map from the renderer-side decode so the
    // L/R lanes are available without waiting for a backend WAVEFORM_READY.
    // Non-stereo decodes pass an empty array, which clears any prior entry.
    if (decoded.peaksPerSecond > 0) {
      library.setItemChannelPeaks(itemId, decoded.channelPeaks ?? [], decoded.peaksPerSecond)
    }
  } catch (err) {
    log.warn('library', `readAudioFile/decode failed for ${filePath}: ${String(err)}`)
  }
}

export function applyProjectStateSnapshot(target: SnapshotTarget, snapshot: ProjectStatePayload): void {
      log.info(
        'project',
        `applyProjectStateSnapshot tracks=${snapshot.tracks.length} clips=${snapshot.tracks.reduce((n, t) => n + t.clips.length, 0)} reset=${snapshot.reset === true} path=${snapshot.filePath ?? 'null'} name=${snapshot.name}`
      )
      // Apply after tracks exist because the setter writes each track length.
      let pendingProjectLengthMs: number | null = null
      // Undo/redo soft-replace swaps state wholesale without resetting view identity.
      const isSoftReplace = snapshot.softReplace === true
      // Adopt identity before other snapshot work so observers see post-load values.
      const previousFilePath = target.currentFilePath
      target.currentFilePath = snapshot.filePath
      target.projectName = snapshot.name?.trim() ? snapshot.name : DEFAULT_PROJECT_NAME
      // Trust the backend's authoritative dirty flag when present: incremental
      // PROJECT_STATE rebroadcasts (transition create, reconcile, reconnect)
      // must not silently clear unsaved-change state. Legacy backends without
      // the field fall back to the previous reset-on-replace behaviour.
      if (typeof snapshot.dirty === 'boolean') {
        target.isDirty = snapshot.dirty
      } else if (!isSoftReplace) {
        target.isDirty = false
      }
      // Rotate autosave buckets when load/new/save-as changes project identity.
      const pathChanged = snapshot.filePath !== previousFilePath
      const shouldRotateId = (snapshot.reset === true || pathChanged) && !isSoftReplace
      if (shouldRotateId) {
        target.previousProjectId = target.projectId
        if (snapshot.filePath) {
          // Async path hashing keeps autosave disabled until the id resolves.
          const targetPath = snapshot.filePath
          target.projectId = null
          void deriveProjectIdFromPath(targetPath).then((id) => {
            // A later load may race the hash result.
            if (target.currentFilePath === targetPath) target.projectId = id
          })
        } else {
          target.projectId = target.pendingRecoveredProjectId ?? freshUntitledProjectId()
        }
      }
      target.pendingRecoveredProjectId = null
      target.viewPxPerSecond =
        typeof snapshot.viewPxPerSecond === 'number' && snapshot.viewPxPerSecond > 0
          ? snapshot.viewPxPerSecond
          : null
      target.viewScrollX =
        typeof snapshot.viewScrollX === 'number' && snapshot.viewScrollX >= 0
          ? snapshot.viewScrollX
          : null
      // PROJECT_STATE restores transport and project dimensions across stores.
      if (typeof snapshot.bpm === 'number' && snapshot.bpm > 0) {
        useTransportStore().setBpm(snapshot.bpm)
      }
      if (typeof snapshot.playheadMs === 'number' && snapshot.playheadMs >= 0) {
        useTransportStore().setPosition(snapshot.playheadMs)
      }
      if (typeof snapshot.projectLengthMs === 'number' && snapshot.projectLengthMs > 0) {
        pendingProjectLengthMs = snapshot.projectLengthMs
      } else {
        pendingProjectLengthMs = null
      }
      // Normalise audio-output preference to all-set or null/null.
      const nextAudioType = typeof snapshot.audioOutputTypeName === 'string' && snapshot.audioOutputTypeName.length > 0
        ? snapshot.audioOutputTypeName
        : null
      const nextAudioDevice = typeof snapshot.audioOutputDeviceName === 'string' && snapshot.audioOutputDeviceName.length > 0
        ? snapshot.audioOutputDeviceName
        : null
      if (nextAudioType !== null && nextAudioDevice !== null) {
        target.audioOutputTypeName = nextAudioType
        target.audioOutputDeviceName = nextAudioDevice
      } else {
        target.audioOutputTypeName = null
        target.audioOutputDeviceName = null
      }
      // Only supported rates survive; absent/invalid means no project override.
      const incomingRate = snapshot.targetSampleRate
      target.targetSampleRate =
        typeof incomingRate === 'number' && (incomingRate === 44100 || incomingRate === 48000)
          ? incomingRate
          : null
      // The dialog parses this opaque JSON defensively on open.
      const incomingExportSettings = snapshot.exportSettingsJson
      target.exportSettingsJson =
        typeof incomingExportSettings === 'string' && incomingExportSettings.length > 0
          ? incomingExportSettings
          : null
      // Missing means unity; the backend omits default master volume.
      const incomingMasterVolume = snapshot.masterVolume
      target.masterVolume =
        typeof incomingMasterVolume === 'number' && Number.isFinite(incomingMasterVolume)
          ? Math.min(1, Math.max(0, incomingMasterVolume))
          : 1.0
      // Missing means default 0; the backend omits default bar settings.
      const incomingBarCounterStart = snapshot.barCounterStart
      target.barCounterStart =
        typeof incomingBarCounterStart === 'number' && Number.isFinite(incomingBarCounterStart)
          ? Math.min(0, Math.max(-64, Math.round(incomingBarCounterStart)))
          : 0
      const incomingMixdownStartBar = snapshot.mixdownStartBar
      target.mixdownStartBar =
        typeof incomingMixdownStartBar === 'number' && Number.isFinite(incomingMixdownStartBar)
          ? Math.min(4096, Math.max(-64, Math.round(incomingMixdownStartBar)))
          : 0
      // Mutate FX objects in place so PROJECT_STATE refreshes do not end drags.
      const unit = (v: unknown): number =>
        typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
      target.projectReverb.size = unit(snapshot.reverbSize)
      target.projectReverb.decay = unit(snapshot.reverbDecay)
      target.projectReverb.tone = unit(snapshot.reverbTone)
      target.projectReverb.mix = unit(snapshot.reverbMix)
      target.projectDelay.noteValue = snapshot.delayNoteValue ?? '1/8'
      target.projectDelay.feedback = unit(snapshot.delayFeedback)
      target.projectDelay.tone = unit(snapshot.delayTone)
      target.projectDelay.mix = unit(snapshot.delayMix)
      const library = useLibraryStore()
      // Reset/soft-replace wipe ValueTree-backed mirrors; undo/redo preserves view state.
      if (snapshot.reset === true || isSoftReplace) {
        target.tracks = []
        target.clips = {}
        target.markers = []
        if (!isSoftReplace) {
          target.selectedClipId = null
          target.selectedTrackId = null
          target.clipboardClip = null
        }
        target.duplicateTailBySource = {}
        target.peaksRevision++
        library.clear()
      }

      target.markers = Array.isArray(snapshot.markers)
        ? snapshot.markers
            .filter((marker) => marker.positionMs >= 0)
            .map((marker) => ({ id: marker.id, positionMs: marker.positionMs }))
            .sort((a, b) => a.positionMs - b.positionMs)
        : []

      // Hydrate library first and suppress echoing snapshot items back to the backend.
      if (snapshot.library) {
        for (const item of snapshot.library) {
          const already = library.byId[item.id]
          if (already) {
            // Existing items still need relinked path/unresolved fields refreshed.
            already.filePath = item.filePath
            already.fileName = item.fileName?.trim()
              ? item.fileName
              : filePathToBasename(item.filePath)
            already.playbackFilePath = item.filePath
            already.unresolved = item.unresolved === true ? true : undefined
            continue
          }
          const libId = library.addItem({
            id: item.id,
            kind: item.kind ?? 'audio-file',
            name: item.name,
            filePath: item.filePath,
            fileName: item.fileName?.trim() ? item.fileName : filePathToBasename(item.filePath),
            durationMs: Math.max(0, item.durationMs ?? 0),
            sampleRate: Math.max(0, item.sampleRate ?? 0),
            channelCount: Math.max(0, item.channelCount ?? 0),
            peaks: new Float32Array(0),
            key: item.key,
            unresolved: item.unresolved === true,
            // Keep CLIP_ADD keyed by source path; cached WAV paths are backend-internal.
            playbackFilePath: item.filePath,
            derivedFrom:
              item.kind === 'saved-clip' || item.kind === 'stem'
                ? {
                    sourceItemId: item.sourceItemId,
                    sourceClipId: item.sourceClipId,
                    inMs: Math.max(0, item.sourceInMs ?? 0),
                    durationMs: Math.max(0, item.sourceDurationMs ?? item.durationMs ?? 0)
                  }
                : undefined,
            collapsed: item.collapsed === true ? true : undefined,
            warpEnabled: item.kind === 'saved-clip' && typeof item.warpEnabled === 'boolean'
              ? item.warpEnabled
              : undefined,
            warpMode: item.kind === 'saved-clip' ? item.warpMode : undefined,
            tempoRatio: item.kind === 'saved-clip' && typeof item.tempoRatio === 'number'
              ? item.tempoRatio
              : undefined,
            semitones: item.kind === 'saved-clip' && typeof item.semitones === 'number'
              ? item.semitones
              : undefined,
            cents: item.kind === 'saved-clip' && typeof item.cents === 'number'
              ? item.cents
              : undefined,
            fromSnapshot: true
          })
          // Persisted analysis hydrates immediately; new imports use LIBRARY_ITEM_ANALYSIS.
          if (typeof item.bpm === 'number' && item.bpm > 0) {
            const persistedBeats = Array.isArray(item.beats) ? item.beats : []
            const anchor =
              typeof item.beatAnchorSec === 'number'
                ? item.beatAnchorSec
                : (persistedBeats[0] ?? 0)
            library.setItemAnalysis(
              libId,
              item.bpm,
              anchor,
              persistedBeats,
              item.variableTempo === true,
              item.playbackFilePath,
              item.lowConfidence === true
            )
          }
          if (item.sampleMode === 'sample' || item.sampleMode === 'music') {
            const target = library.items.find((i) => i.id === libId)
            if (target) target.sampleMode = item.sampleMode
          }
          // Backfill metadata for older projects missing persisted duration.
          // Stems are standalone files too, so refresh their media like sources.
          const reloadKind = item.kind ?? 'audio-file'
          if (reloadKind === 'audio-file') {
            void refreshLibraryItemMedia(libId, item.filePath)
          } else if (reloadKind === 'stem') {
            void refreshLibraryItemMedia(libId, item.filePath, { stem: true })
          }
        }
        for (const item of library.items) {
          if (item.kind !== 'saved-clip' || item.bpm !== undefined) continue
          const sourceId = item.derivedFrom?.sourceItemId
          if (!sourceId) continue
          const source = library.byId[sourceId]
          if (!source || typeof source.bpm !== 'number' || source.bpm <= 0) continue
          library.setItemAnalysis(
            item.id,
            source.bpm,
            source.beatAnchorSec ?? source.beats?.[0] ?? 0,
            source.beats ?? [],
            source.variableTempo === true,
            source.decodedCacheFilePath,
            source.lowConfidence === true
          )
        }
      }

      // Batch missing-peak requests after reconciliation.
      const clipsNeedingPeaks: string[] = []
      for (const t of snapshot.tracks) {
        // Rebuild missing renderer tracks from the backend snapshot.
        let track = target.tracks.find((x) => x.id === t.id)
        if (!track) {
          const index = target.tracks.length
          const persistedName = t.name?.trim()
          track = {
            id: t.id,
            name: persistedName && persistedName.length > 0 ? persistedName : `Track ${index + 1}`,
            clipIds: [],
            muted: t.muted === true && t.soloed !== true,
            soloed: t.soloed === true,
            volume: Math.min(MAX_TRACK_VOLUME, Math.max(0, t.gain)),
            colorIndex: index % TRACK_PALETTE.length,
            lengthMs: DEFAULT_TRACK_LENGTH_MS,
            heightPx: typeof t.heightPx === 'number' && t.heightPx > 0 ? t.heightPx : undefined,
            toneBassDb: typeof t.toneBassDb === 'number' && t.toneBassDb !== 0 ? t.toneBassDb : undefined,
            toneMidDb: typeof t.toneMidDb === 'number' && t.toneMidDb !== 0 ? t.toneMidDb : undefined,
            toneTrebleDb:
              typeof t.toneTrebleDb === 'number' && t.toneTrebleDb !== 0 ? t.toneTrebleDb : undefined,
            toneFilter: typeof t.toneFilter === 'number' && t.toneFilter !== 0 ? t.toneFilter : undefined,
            reverbSend:
              typeof t.sendReverb === 'number' && t.sendReverb !== 0 ? t.sendReverb : undefined,
            delaySend:
              typeof t.sendDelay === 'number' && t.sendDelay !== 0 ? t.sendDelay : undefined,
            pan: typeof t.pan === 'number' && t.pan !== 0 ? t.pan : undefined,
            levelerAmount:
              typeof t.levelerAmount === 'number' && t.levelerAmount !== 0
                ? t.levelerAmount
                : undefined
          }
          target.tracks.push(track)
        } else {
          const persistedName = t.name?.trim()
          if (persistedName && persistedName.length > 0) {
            track.name = persistedName
          }
          if (typeof t.heightPx === 'number' && t.heightPx > 0) {
            track.heightPx = t.heightPx
          }
          // Mute/solo acks arrive as PROJECT_STATE refreshes. Mute and solo are mutually
          // exclusive; if a legacy project carries both, solo wins (clears mute).
          track.muted = t.muted === true && t.soloed !== true
          track.soloed = t.soloed === true
          track.volume = Math.min(MAX_TRACK_VOLUME, Math.max(0, t.gain))
          track.toneBassDb =
            typeof t.toneBassDb === 'number' && t.toneBassDb !== 0 ? t.toneBassDb : undefined
          track.toneMidDb =
            typeof t.toneMidDb === 'number' && t.toneMidDb !== 0 ? t.toneMidDb : undefined
          track.toneTrebleDb =
            typeof t.toneTrebleDb === 'number' && t.toneTrebleDb !== 0 ? t.toneTrebleDb : undefined
          track.toneFilter =
            typeof t.toneFilter === 'number' && t.toneFilter !== 0 ? t.toneFilter : undefined
          track.reverbSend =
            typeof t.sendReverb === 'number' && t.sendReverb !== 0 ? t.sendReverb : undefined
          track.delaySend =
            typeof t.sendDelay === 'number' && t.sendDelay !== 0 ? t.sendDelay : undefined
          track.pan = typeof t.pan === 'number' && t.pan !== 0 ? t.pan : undefined
          track.levelerAmount =
            typeof t.levelerAmount === 'number' && t.levelerAmount !== 0
              ? t.levelerAmount
              : undefined
        }
        // Transitions are backend-authoritative and cleared by absent snapshot data.
        track.transitions = hydrateTransitions(t.transitions)
        for (const c of t.clips) {
          const offset = Math.max(0, c.offsetMs)
          // Library item id is the clip source of truth; skip unknown ids.
          const libItem = library.byId[c.libraryItemId]
          if (!libItem) {
            log.warn(
              'project',
              `skip clip ${c.id} — unknown libraryItemId=${c.libraryItemId}`
            )
            continue
          }
          const clipFilePath = libItem.filePath
          const existing = target.clips[c.id]
          if (existing) {
            existing.startMs = offset
            existing.inMs = Math.max(0, c.inMs ?? 0)
            existing.durationMs = Math.max(0, c.durationMs)
            existing.unresolved = c.unresolved === true
            // Relinked library items must refresh existing clip path/name caches.
            existing.filePath = clipFilePath
            existing.fileName = filePathToDisplayName(clipFilePath)
            existing.playbackFilePath = libItem.playbackFilePath
            existing.colorIndex = typeof c.colorIndex === 'number' ? c.colorIndex : undefined
            existing.name = typeof c.name === 'string' && c.name.trim().length > 0 ? c.name : undefined
            existing.warpEnabled = typeof c.warpEnabled === 'boolean' ? c.warpEnabled : undefined
            existing.warpMode = c.warpMode
            existing.tempoRatio = typeof c.tempoRatio === 'number' ? c.tempoRatio : undefined
            existing.semitones = typeof c.semitones === 'number' ? c.semitones : undefined
            existing.cents = typeof c.cents === 'number' ? c.cents : undefined
            existing.envelopePoints =
              Array.isArray(c.envelopePoints) && c.envelopePoints.length >= 2
                ? sanitizeEnvelopePoints(c.envelopePoints)
                : undefined
            existing.effectiveDurationMs =
              typeof c.effectiveDurationMs === 'number' ? c.effectiveDurationMs : undefined
            existing.effectiveTempoRatio =
              typeof c.effectiveTempoRatio === 'number' ? c.effectiveTempoRatio : undefined
            existing.effectiveWarpActive =
              typeof c.effectiveWarpActive === 'boolean' ? c.effectiveWarpActive : undefined
            existing.pendingAutoWarp =
              c.pendingAutoWarp === true && existing.warpEnabled !== true ? true : undefined
            existing.locked = c.locked === true ? true : undefined
            if (existing.peaks.length === 0) clipsNeedingPeaks.push(c.id)
            continue
          }
          // Placeholder draws immediately; peaks are requested later.
          const fileName = filePathToDisplayName(clipFilePath)
          const placeholder: Clip = {
            id: c.id,
            trackId: t.id,
            libraryItemId: c.libraryItemId,
            filePath: clipFilePath,
            playbackFilePath: libItem.playbackFilePath,
            fileName,
            startMs: offset,
            inMs: Math.max(0, c.inMs ?? 0),
            durationMs: Math.max(0, c.durationMs),
            sampleRate: libItem.sampleRate,
            channelCount: libItem.channelCount,
            peaks: libItem.peaks.length > 0 ? libItem.peaks : new Float32Array(0),
            unresolved: c.unresolved === true,
            colorIndex: typeof c.colorIndex === 'number' ? c.colorIndex : undefined,
            name: typeof c.name === 'string' && c.name.trim().length > 0 ? c.name : undefined,
            warpEnabled: typeof c.warpEnabled === 'boolean' ? c.warpEnabled : undefined,
            warpMode: c.warpMode,
            tempoRatio: typeof c.tempoRatio === 'number' ? c.tempoRatio : undefined,
            semitones: typeof c.semitones === 'number' ? c.semitones : undefined,
            cents: typeof c.cents === 'number' ? c.cents : undefined,
            envelopePoints:
              Array.isArray(c.envelopePoints) && c.envelopePoints.length >= 2
                ? sanitizeEnvelopePoints(c.envelopePoints)
                : undefined,
            effectiveDurationMs:
              typeof c.effectiveDurationMs === 'number' ? c.effectiveDurationMs : undefined,
            effectiveTempoRatio:
              typeof c.effectiveTempoRatio === 'number' ? c.effectiveTempoRatio : undefined,
            effectiveWarpActive:
              typeof c.effectiveWarpActive === 'boolean' ? c.effectiveWarpActive : undefined,
            pendingAutoWarp:
              c.pendingAutoWarp === true && c.warpEnabled !== true ? true : undefined,
            locked: c.locked === true ? true : undefined,
            reversed: c.reversed === true ? true : undefined
          }
          target.clips[c.id] = placeholder
          track.clipIds.push(c.id)
          // Missing sources cannot produce peaks.
          if (!placeholder.unresolved) clipsNeedingPeaks.push(c.id)
          const clipEnd = placeholder.startMs + placeholder.durationMs
          if (clipEnd > track.lengthMs) track.lengthMs = clipEnd
          if (track.clipIds.length === 1 && /^Track \d+$/.test(track.name)) {
            track.name = fileName
          }
        }
      }
      // Backend order wins; optimistic local-only tracks stay appended.
      if (snapshot.tracks.length > 0) {
        const indexOf = new Map<string, number>()
        for (let i = 0; i < snapshot.tracks.length; i++) {
          const id = snapshot.tracks[i]?.id
          if (id) indexOf.set(id, i)
        }
        const SENTINEL = Number.MAX_SAFE_INTEGER
        target.tracks.sort((a, b) => {
          const ai = indexOf.has(a.id) ? indexOf.get(a.id)! : SENTINEL
          const bi = indexOf.has(b.id) ? indexOf.get(b.id)! : SENTINEL
          return ai - bi
        })
      }
      // Additive snapshots must not drop optimistic local tracks/clips.
      // Missing peaks are requested after reconciliation and arrive as WAVEFORM_DATA.
      for (const clipId of clipsNeedingPeaks) {
        sendBridge('WAVEFORM_REQUEST', { clipId })
      }

      // Project length applies after tracks exist and clamps above clip ends.
      if (pendingProjectLengthMs !== null && target.tracks.length > 0) {
        target.setProjectLengthMs(pendingProjectLengthMs)
      }

      // Restore reset-only view state directly so it does not echo to the backend.
      if (snapshot.reset === true) {
        const savedSelected =
          typeof snapshot.viewSelectedTrack === 'string' && snapshot.viewSelectedTrack.length > 0
            ? snapshot.viewSelectedTrack
            : null
        target.selectedTrackId =
          savedSelected !== null && target.tracks.some((t) => t.id === savedSelected)
            ? savedSelected
            : null
        target.fxPanelOpen = snapshot.viewFxPanelOpen === true
        target.fxTab = 'track'
        target.peaksRevision++
      }

      // Migration: rebind pre-existing saved-clip windows to their saved item.
      if (snapshot.reset === true || isSoftReplace) {
        for (const clipId in target.clips) {
          const clip = target.clips[clipId]
          if (!clip) continue
          const candidate = library.items.find(
            (i) =>
              i.kind === 'saved-clip' &&
              i.derivedFrom?.sourceItemId === clip.libraryItemId &&
              Math.abs((i.derivedFrom?.inMs ?? 0) - clip.inMs) < 0.5 &&
              Math.abs((i.derivedFrom?.durationMs ?? 0) - clip.durationMs) < 0.5
          )
          if (candidate && candidate.id !== clip.libraryItemId) {
            log.info(
              'project',
              `migrate clip ${clipId} libraryItemId=${clip.libraryItemId} -> ${candidate.id} (saved-clip window match)`
            )
            clip.libraryItemId = candidate.id
            sendBridge('CLIP_REBIND', { clipId, libraryItemId: candidate.id })
          }
        }
      }
}
