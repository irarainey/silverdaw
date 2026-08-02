// Project-state snapshot application. Extracted from projectStore.ts: this is the
// PROJECT_STATE -> renderer-state reconciliation (the single largest store action).
// The store action is a thin wrapper that calls applyProjectStateSnapshot then
// resolves any in-flight recovery load.
//
// This orchestrator stays small by delegating each responsibility to a focused
// module, called in the original dependency order:
//   - projectSnapshotMeta     identity, transport, settings, FX, structure reset
//   - projectSnapshotLibrary  library row hydration + media backfill
//   - projectSnapshotTracks   track/clip rebuild + post-reconciliation finalise

import { log } from '@/lib/log'
import type { ProjectStatePayload } from '@shared/bridge-protocol'
import { ScratchPatternSchema } from '@shared/bridge-protocol'
import type { SnapshotTarget } from './projectSnapshotTypes'
import {
  applyProjectFx,
  applyProjectIdentity,
  applyProjectSettings,
  applyProjectStructureReset,
  applyProjectTransport
} from './projectSnapshotMeta'
import {
  applyProjectLibrary,
  refreshProjectLibraryMedia
} from './projectSnapshotLibrary'
import { filePathKey } from './projectHelpers'
import { applyProjectTracks, finalizeProjectSnapshot } from './projectSnapshotTracks'
import { markProjectSnapshotApplied } from '@/lib/timeline/projectOpenPaintProbe'
import { useLibraryStore } from '@/stores/libraryStore'

export type { SnapshotTarget } from './projectSnapshotTypes'

export function applyProjectStateSnapshot(target: SnapshotTarget, snapshot: ProjectStatePayload): void {
  log.info(
    'project',
    `applyProjectStateSnapshot tracks=${snapshot.tracks.length} clips=${snapshot.tracks.reduce((n, t) => n + t.clips.length, 0)} reset=${snapshot.reset === true} path=${snapshot.filePath ?? 'null'} name=${snapshot.name}`
  )
  // Undo/redo soft-replace swaps state wholesale without resetting view identity.
  const isSoftReplace = snapshot.softReplace === true

  // Adopt identity before other snapshot work so observers see post-load values.
  applyProjectIdentity(target, snapshot, isSoftReplace)
  // Transport restore returns the project length to apply after tracks exist
  // because the setter writes each track length.
  const pendingProjectLengthMs = applyProjectTransport(target, snapshot)
  applyProjectSettings(target, snapshot)
  applyProjectFx(target, snapshot)
  // Keep a malformed persisted pattern from contaminating renderer state when
  // a snapshot is injected outside normal bridge validation (tests/recovery).
  target.savedScratchPatterns = (snapshot.scratchPatterns ?? []).flatMap((pattern) => {
    const parsed = ScratchPatternSchema.safeParse(pattern)
    return parsed.success ? [parsed.data] : []
  })
  // An undo/redo soft-replace wipes and rehydrates the library catalogue, but it
  // cannot change the audio files behind it. Carry the decoded peaks and LOD
  // pyramids across the wipe: without this, every library item whose file is NOT
  // placed on the timeline misses the backend `.peaks` cache on rehydration and
  // falls back to `readAudioFile` + `decodeAudioData` on the main thread, which
  // costs seconds of scroll jank per undo on a project with unplaced stems.
  const library = useLibraryStore()
  const preservedPeaks = isSoftReplace ? library.capturePeaksCache() : null
  applyProjectStructureReset(target, snapshot, isSoftReplace)

  // Hydrate library first so clip rebuild can resolve library items.
  const mediaRefreshes = applyProjectLibrary(target, snapshot)
  if (preservedPeaks) library.restorePeaksCache(preservedPeaks)
  const clipsNeedingPeaks = applyProjectTracks(target, snapshot)
  const backendPeakFilePaths = new Set<string>()
  for (const clipId of clipsNeedingPeaks) {
    const filePath = target.clips[clipId]?.filePath
    if (filePath) backendPeakFilePaths.add(filePathKey(filePath))
  }
  // Drop any selected ids the snapshot no longer contains (e.g. an undo/redo removed clips) so a
  // stale id can't corrupt a later multi-clip operation. Selection survives soft-replays.
  if (target.selectedClipIds.size > 0 || target.selectedClipId !== null) {
    const pruned = new Set<string>()
    for (const id of target.selectedClipIds) {
      if (target.clips[id]) pruned.add(id)
    }
    target.selectedClipIds = pruned
    if (target.selectedClipId !== null && !target.clips[target.selectedClipId]) {
      target.selectedClipId = pruned.values().next().value ?? null
    }
  }
  finalizeProjectSnapshot(target, snapshot, clipsNeedingPeaks, pendingProjectLengthMs)
  markProjectSnapshotApplied(snapshot.name ?? 'Untitled')
  refreshProjectLibraryMedia(mediaRefreshes, backendPeakFilePaths)
}
