// Clip Editor "Save" commands, extracted from ClipEditorDialog.vue. Save commits
// the whole dialog draft atomically: until the user saves, trim/crop/warp/pitch/
// volume only affect the local view and preview voice — timeline clips and
// library items remain untouched. This module owns the reconstruction of the
// persisted warp patch, the target trim window, the overlap-conflict check, and
// the two save entry points (Save changes / Save as new).
import { clampNumber, pitchNeedsProcessor } from '@/lib/clipEditor/useClipEditorWarpDraft'
import { runInUndoGroup } from '@/lib/undo/undoGroup'
import { effectiveDurationMs } from '@/lib/warp'
import { effectiveClipDurationMs, type Clip } from '@/stores/projectStore'
import type { useProjectStore } from '@/stores/projectStore'
import type { useLibraryStore, LibraryItem } from '@/stores/libraryStore'
import type { useNotificationsStore } from '@/stores/notificationsStore'
import type { ClipWarpMode, ClipEnvelopePoint } from '@shared/bridge-protocol'

type ProjectStore = ReturnType<typeof useProjectStore>
type LibraryStore = ReturnType<typeof useLibraryStore>
type NotificationsStore = ReturnType<typeof useNotificationsStore>

export interface LibraryClipWarpPatch {
  warpEnabled: boolean
  warpMode: ClipWarpMode
  tempoRatio: number | null
  semitones: number
  cents: number
}

export interface ClipEditorSaveDeps {
  project: ProjectStore
  library: LibraryStore
  notifications: NotificationsStore
  close: () => void

  editorItem: () => LibraryItem | null
  timelineClip: () => Clip | null
  sourceItem: () => LibraryItem | null
  titleText: () => string
  editsSingleTimelineClip: () => boolean
  editsLibraryClipLibrary: () => boolean
  editsTimelineClip: () => boolean
  hasWarpPitchChanged: () => boolean
  sourceBpm: () => number | undefined
  projectBpm: () => number

  canApplyCrop: () => boolean
  selectionInMs: () => number
  selectionDurationMs: () => number
  cropViewInMs: () => number
  cropViewDurationMs: () => number

  draftSemitones: () => number
  draftCents: () => number
  draftTempoEnabled: () => boolean
  draftMode: () => ClipWarpMode
  draftTempoPinned: () => boolean
  tempoRatioFromPinnedBpm: () => number | undefined

  volumeShapeCommittedPoints: () => ClipEnvelopePoint[]
  reverseCommitted: () => boolean
  brakeCommitted: () => boolean
  backspinCommitted: () => boolean
}

export interface ClipEditorSave {
  onSaveChanges: () => void
  onSaveAsNew: () => void
}

export function useClipEditorSave(deps: ClipEditorSaveDeps): ClipEditorSave {
  function libraryClipWarpPatch(): LibraryClipWarpPatch {
    const nextSemitones = clampNumber(deps.draftSemitones(), -12, 12)
    const nextCents = clampNumber(deps.draftCents(), -100, 100)
    const pitchActive = pitchNeedsProcessor(nextSemitones, nextCents)
    // When the tempo is pinned but the source BPM is unknown, the draft can't
    // re-derive a ratio from the pinned BPM (`tempoRatioFromPinnedBpm` returns
    // undefined). Fall back to the clip's existing pinned ratio so reconstructing
    // this patch on save preserves the warp instead of clearing it to null —
    // otherwise a volume- or trim-only save would silently drop the warp.
    const current = deps.timelineClip() ?? deps.editorItem()
    const existingPinnedRatio =
      typeof current?.tempoRatio === 'number' && current.tempoRatio > 0 && current.tempoRatio !== 1
        ? current.tempoRatio
        : null
    const tempoEnabled = deps.draftTempoEnabled()
    return {
      warpEnabled: tempoEnabled || pitchActive,
      warpMode: deps.draftMode(),
      tempoRatio: tempoEnabled
        ? (deps.draftTempoPinned() ? deps.tempoRatioFromPinnedBpm() ?? existingPinnedRatio : null)
        : (pitchActive ? 1 : null),
      semitones: nextSemitones,
      cents: nextCents
    }
  }

  function draftTargetWindow(): { inMs: number; durationMs: number } {
    const useSelection = deps.canApplyCrop() || deps.selectionDurationMs() > 0
    return {
      inMs: useSelection ? deps.selectionInMs() : deps.cropViewInMs(),
      durationMs: useSelection ? deps.selectionDurationMs() : deps.cropViewDurationMs()
    }
  }

  function conflictingTrackNameForTimelineClip(
    clip: Clip,
    nextDurationMs: number,
    tempoRatio: number | null
  ): string | null {
    const project = deps.project
    const track = project.tracks.find((candidate) => candidate.id === clip.trackId)
    if (!track) return null
    const effectiveMs = effectiveDurationMs(nextDurationMs, {
      warpEnabled: deps.draftTempoEnabled(),
      tempoRatio: tempoRatio ?? undefined,
      sourceBpm: deps.sourceBpm(),
      projectBpm: deps.projectBpm()
    })
    const nextStart = clip.startMs
    const nextEnd = nextStart + effectiveMs
    for (const otherId of track.clipIds) {
      if (otherId === clip.id) continue
      const other = project.clips[otherId]
      if (!other) continue
      const otherEnd = other.startMs + effectiveClipDurationMs(other)
      if (nextStart < otherEnd && nextEnd > other.startMs) return track.name
    }
    return null
  }

  function onSaveChanges(): void {
    const entry = deps.editorItem()
    if (!entry) return
    const { inMs: targetIn, durationMs: targetDur } = draftTargetWindow()
    const warpPatch = libraryClipWarpPatch()
    if (deps.editsSingleTimelineClip()) {
      const clip = deps.timelineClip()
      if (!clip) {
        deps.notifications.pushError('Cannot save changes — clip is no longer available.')
        return
      }
      const conflictTrack = conflictingTrackNameForTimelineClip(clip, targetDur, warpPatch.tempoRatio)
      if (conflictTrack) {
        deps.notifications.pushError(`Cannot save changes — they would overlap clips on ${conflictTrack}.`)
        return
      }
      // Save commits the whole draft as ONE undo step.
      runInUndoGroup('Save clip changes', () => {
        deps.project.trimClip(clip.id, clip.startMs, targetIn, targetDur)
        // Only re-apply warp when the user actually changed it. `libraryClipWarpPatch`
        // reconstructs the patch from the draft, which is lossy for follow-project
        // clips (it emits `tempoRatio: null`); re-applying it on a volume-only save
        // would clear an existing warp on the backend, leaving the clip flagged as
        // warped but playing at its original tempo. `trimClip` self-guards and
        // `setClipEnvelope` round-trips, so only warp needs gating here.
        if (deps.hasWarpPitchChanged()) {
          deps.project.setClipWarp(clip.id, warpPatch)
        }
        // Volume shape is stored in clip-local timeline-ms basis; a flat unity
        // draft commits as an empty array, clearing it.
        deps.project.setClipEnvelope(clip.id, deps.volumeShapeCommittedPoints())
        // Reverse is a non-destructive per-clip flag; `setClipReversed` self-guards
        // against a no-op change.
        deps.project.setClipReversed(clip.id, deps.reverseCommitted())
        // Brake/backspin are non-destructive tail flags; each self-guards and
        // clears the other (they are mutually exclusive). This is the unlinked
        // clip, so it is set directly (the linked branch below propagates).
        deps.project.setClipBrake(clip.id, deps.brakeCommitted())
        deps.project.setClipBackspin(clip.id, deps.backspinCommitted())
      })
      deps.notifications.pushInfo(`Saved changes for "${deps.titleText()}".`)
      deps.close()
      return
    }
    if (!deps.editsLibraryClipLibrary()) return
    // Persist the saved-clip edit and its envelope/reverse propagation as ONE undo step; the
    // nested groups inside the library actions fold into this outer transaction.
    const result = runInUndoGroup('Save clip changes', () => {
      const editResult = deps.library.updateLibraryClipEdit(entry.id, {
        inMs: targetIn,
        durationMs: targetDur,
        ...warpPatch
      })
      if (editResult.ok && deps.editsTimelineClip()) {
        // A linked timeline clip also shares the saved clip's volume envelope:
        // persist it to every linked instance after trim/warp reflows their
        // durations, so the post-warp ms basis is current. Saved-library edits
        // (no placed instance) skip this — they have no volume control.
        deps.library.updateLibraryClipEnvelope(entry.id, deps.volumeShapeCommittedPoints())
        deps.library.updateLibraryClipReversed(entry.id, deps.reverseCommitted())
        // Brake/backspin propagate across every linked instance too (like reverse).
        deps.library.updateLibraryClipBrake(entry.id, deps.brakeCommitted())
        deps.library.updateLibraryClipBackspin(entry.id, deps.backspinCommitted())
      }
      return editResult
    })
    if (result.ok) {
      deps.notifications.pushInfo(`Saved changes for "${deps.titleText()}".`)
      deps.close()
    } else if (result.conflictingTrackNames && result.conflictingTrackNames.length > 0) {
      deps.notifications.pushError(
        `Cannot save changes — they would overlap clips on ${result.conflictingTrackNames.join(', ')}.`
      )
    } else {
      deps.notifications.pushError('Cannot save changes — invalid edit.')
    }
  }

  function onSaveAsNew(): void {
    const src = deps.sourceItem()
    if (!src) return
    const id = deps.library.addLibraryClipFromSelection(
      src.id,
      deps.selectionInMs(),
      deps.selectionDurationMs()
    )
    if (id) {
      deps.notifications.pushInfo(`Saved selection as new clip.`)
      deps.close()
    }
  }

  return { onSaveChanges, onSaveAsNew }
}
