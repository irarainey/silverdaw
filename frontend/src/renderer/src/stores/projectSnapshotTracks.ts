// Track + clip rebuild and post-reconciliation finalisation for PROJECT_STATE
// snapshots. applyProjectTracks rebuilds tracks/clips and returns the clip ids
// still needing peaks; finalizeProjectSnapshot requests those peaks, applies the
// project length, restores reset-only view state, and migrates library-clip windows.

import { send as sendBridge } from '@/lib/bridgeService'
import { sanitizeEnvelopePoints } from '@/lib/envelope'
import { sanitizeBreakpoints } from '@/lib/automation/breakpoints'
import { AUTOMATION_PARAMS } from '@/lib/automation/automationParams'
import { log } from '@/lib/log'
import { useLibraryStore } from '@/stores/libraryStore'
import type { ProjectStatePayload } from '@shared/bridge-protocol'
import {
  DEFAULT_TRACK_LENGTH_MS,
  MAX_TRACK_VOLUME,
  TRACK_PALETTE
} from './projectTypes'
import type { AutomationParamId, AutomationPoint, Clip } from './projectTypes'
import { filePathToDisplayName, hydrateTransitions } from './projectHelpers'
import type { SnapshotTarget } from './projectSnapshotTypes'

/** Rebuild a track's automation map from the snapshot lanes (sanitised, lanes with
 *  fewer than two points dropped). Returns undefined when the track has no curves. */
function hydrateAutomation(
  lanes: ReadonlyArray<{ paramId: string; points: ReadonlyArray<{ timeMs: number; value: number }> }> | undefined
): Partial<Record<AutomationParamId, AutomationPoint[]>> | undefined {
  if (!lanes || lanes.length === 0) return undefined
  const out: Partial<Record<AutomationParamId, AutomationPoint[]>> = {}
  for (const lane of lanes) {
    const descriptor = AUTOMATION_PARAMS[lane.paramId as AutomationParamId]
    if (!descriptor) continue
    const pts = sanitizeBreakpoints(lane.points, { min: descriptor.min, max: descriptor.max })
    if (pts.length >= 2) out[lane.paramId as AutomationParamId] = pts
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Rebuild renderer tracks and clips from the backend snapshot, keeping optimistic
 * local-only tracks/clips. Returns the clip ids that still need peaks fetched.
 */
export function applyProjectTracks(target: SnapshotTarget, snapshot: ProjectStatePayload): string[] {
  const library = useLibraryStore()
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
        colorIndex:
          typeof t.colorIndex === 'number' ? t.colorIndex : index % TRACK_PALETTE.length,
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
            : undefined,
        saturationDrive:
          typeof t.saturationDrive === 'number' && t.saturationDrive !== 0
            ? t.saturationDrive
            : undefined,
        saturationMix:
          typeof t.saturationMix === 'number' && t.saturationMix !== 1
            ? t.saturationMix
            : undefined,
        bitCrusherRate:
          typeof t.bitCrusherRate === 'number' && t.bitCrusherRate !== 1
            ? t.bitCrusherRate
            : undefined,
        bitCrusherBits:
          typeof t.bitCrusherBits === 'number' && t.bitCrusherBits !== 16
            ? t.bitCrusherBits
            : undefined,
        bitCrusherBoost:
          typeof t.bitCrusherBoost === 'number' && t.bitCrusherBoost !== 0
            ? t.bitCrusherBoost
            : undefined,
        bitCrusherMix:
          typeof t.bitCrusherMix === 'number' && t.bitCrusherMix !== 0
            ? t.bitCrusherMix
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
      // Adopt a persisted track colour; absent leaves the existing value intact.
      if (typeof t.colorIndex === 'number') {
        track.colorIndex = t.colorIndex
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
      track.saturationDrive =
        typeof t.saturationDrive === 'number' && t.saturationDrive !== 0
          ? t.saturationDrive
          : undefined
      track.saturationMix =
        typeof t.saturationMix === 'number' && t.saturationMix !== 1
          ? t.saturationMix
          : undefined
      track.bitCrusherRate =
        typeof t.bitCrusherRate === 'number' && t.bitCrusherRate !== 1
          ? t.bitCrusherRate
          : undefined
      track.bitCrusherBits =
        typeof t.bitCrusherBits === 'number' && t.bitCrusherBits !== 16
          ? t.bitCrusherBits
          : undefined
      track.bitCrusherBoost =
        typeof t.bitCrusherBoost === 'number' && t.bitCrusherBoost !== 0
          ? t.bitCrusherBoost
          : undefined
      track.bitCrusherMix =
        typeof t.bitCrusherMix === 'number' && t.bitCrusherMix !== 0
          ? t.bitCrusherMix
          : undefined
    }
    // Transitions are backend-authoritative and cleared by absent snapshot data.
    track.transitions = hydrateTransitions(t.transitions)
    // Automation lanes are backend-authoritative too.
    track.automation = hydrateAutomation(t.automation)
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
        reversed: c.reversed === true ? true : undefined,
        brake: c.brake === true ? true : undefined,
        backspin: c.backspin === true ? true : undefined,
        scratchPatternId: typeof c.scratchPatternId === 'string' && c.scratchPatternId
          ? c.scratchPatternId
          : undefined
      }
      target.clips[c.id] = placeholder
      track.clipIds.push(c.id)
      if (!placeholder.unresolved && placeholder.peaks.length === 0) {
        clipsNeedingPeaks.push(c.id)
      }
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
  return clipsNeedingPeaks
}

/**
 * After tracks/clips exist: request missing peaks, apply project length, restore
 * reset-only view state, and migrate library-clip windows to their saved item.
 */
export function finalizeProjectSnapshot(
  target: SnapshotTarget,
  snapshot: ProjectStatePayload,
  clipsNeedingPeaks: string[],
  pendingProjectLengthMs: number | null
): void {
  const library = useLibraryStore()
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
    target.timelineRevision++
  }

  // Migration (project LOAD only): rebind pre-existing library-clip windows to their saved
  // item. This exists purely to reconcile older saved projects on open, where a timeline
  // clip references the source item directly but a saved library-clip now covers the same
  // window. It must NOT run on undo/redo — those broadcast a soft-replace snapshot, and
  // re-issuing the (undoable) CLIP_REBIND there churns the undo stack so it can never reach
  // the clean state, and re-links clips that undo had just detached.
  if (snapshot.reset === true) {
    // First resolve each clip's would-be candidate, and count how many clips map to each
    // candidate. Only unambiguous 1:1 matches are rebound: a window shared by more than one
    // clip can't be attributed to a single origin, so we leave those on the source rather
    // than risk claiming an unrelated clip (they still replay the correct audio).
    const candidateForClip: Record<string, string> = {}
    const clipsPerCandidate: Record<string, number> = {}
    for (const clipId in target.clips) {
      const clip = target.clips[clipId]
      if (!clip) continue
      const candidate = library.items.find(
        (i) =>
          i.kind === 'clip' &&
          i.derivedFrom?.sourceItemId === clip.libraryItemId &&
          Math.abs((i.derivedFrom?.inMs ?? 0) - clip.inMs) < 0.5 &&
          Math.abs((i.derivedFrom?.durationMs ?? 0) - clip.durationMs) < 0.5
      )
      if (candidate && candidate.id !== clip.libraryItemId) {
        candidateForClip[clipId] = candidate.id
        clipsPerCandidate[candidate.id] = (clipsPerCandidate[candidate.id] ?? 0) + 1
      }
    }
    for (const clipId in candidateForClip) {
      const candidateId = candidateForClip[clipId]!
      if (clipsPerCandidate[candidateId] !== 1) {
        log.info(
          'project',
          `skip clip ${clipId} — ambiguous library-clip window match to ${candidateId} (${clipsPerCandidate[candidateId]} clips)`
        )
        continue
      }
      const clip = target.clips[clipId]
      if (!clip) continue
      log.info(
        'project',
        `migrate clip ${clipId} libraryItemId=${clip.libraryItemId} -> ${candidateId} (library-clip window match)`
      )
      clip.libraryItemId = candidateId
      sendBridge('CLIP_REBIND', { clipId, libraryItemId: candidateId })
    }
  }
}
