// Draft volume-shape (per-clip gain envelope) state for the Clip Editor.
//
// Mirrors the transactional draft contract used elsewhere in the Clip
// Editor: every
// breakpoint edit lives here until the user clicks **Save**, at which point
// `committedPoints()` is persisted via `project.setClipEnvelope`. Cancel
// simply discards the draft.
//
// Units: breakpoint `timeMs` is clip-local **post-warp / timeline ms** —
// the same basis the backend `OffsetSource::applyEnvelopeGain` consumes and
// `setClipEnvelope` persists. `gain` is a
// linear multiplier in `[0, ENVELOPE_MAX_GAIN]`.
//
// A freshly-opened editor seeds a flat unity two-point shape so the user has
// anchor handles to bend. Because a flat unity shape is semantically "no
// shape" (see `isFlatUnityEnvelope`), `hasChanged` treats it as equivalent
// to a clip with no envelope and `committedPoints()` returns an empty array
// so the backend clears the property — the project stays clean until a real
// bend is made.

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { ClipEnvelopePoint } from '@shared/bridge-protocol'
import type { Clip } from '@/stores/projectStore'
import {
  defaultEnvelope,
  envelopesEqual,
  insertEnvelopePoint,
  isFlatUnityEnvelope,
  moveEnvelopePoint,
  removeEnvelopePoint,
  sanitizeEnvelopePoints
} from '@/lib/envelope'

export interface ClipEditorVolumeShapeDraft {
  /** The working breakpoints, ordered ascending by `timeMs`. */
  draftPoints: Ref<ClipEnvelopePoint[]>

  /** True when the draft differs from the clip's persisted envelope. A flat
   *  unity draft compares equal to "no envelope". */
  hasChanged: ComputedRef<boolean>

  /** Seed the draft from a clip's persisted envelope (or a flat unity shape
   *  spanning `durationMs` when the clip has none). `null` resets to a flat
   *  shape over `durationMs`. */
  initialise: (current: Clip | null, durationMs: number) => void

  /** Insert a breakpoint, returning its index in the new array. */
  addPoint: (timeMs: number, gain: number) => number

  /** Move the breakpoint at `index` (endpoints keep their pinned time). */
  movePoint: (index: number, timeMs: number, gain: number) => void

  /** Remove the breakpoint at `index` (pinned endpoints are never removed). */
  removePoint: (index: number) => void

  /** Reset the draft back to a flat unity shape spanning `durationMs`. */
  reset: (durationMs: number) => void

  /** The points to persist on Save — empty when the shape is flat unity so
   *  the backend clears the envelope property. */
  committedPoints: () => ClipEnvelopePoint[]
}

export function useClipEditorVolumeShapeDraft(): ClipEditorVolumeShapeDraft {
  const draftPoints = ref<ClipEnvelopePoint[]>(defaultEnvelope(1000))

  // Closure over the live clip so `hasChanged` always compares against the
  // latest persisted state (a Save that mutates the clip then settles the
  // dirty flag without an explicit reset).
  let getCurrentClip: () => Clip | null = () => null

  function normalisedDraft(): ClipEnvelopePoint[] {
    return isFlatUnityEnvelope(draftPoints.value) ? [] : sanitizeEnvelopePoints(draftPoints.value)
  }

  const hasChanged = computed<boolean>(() => {
    const persisted = getCurrentClip()?.envelopePoints
    return !envelopesEqual(normalisedDraft(), persisted)
  })

  function initialise(current: Clip | null, durationMs: number): void {
    getCurrentClip = () => current
    const existing = current?.envelopePoints
    draftPoints.value =
      existing && existing.length >= 2
        ? existing.map((p) => ({ ...p }))
        : defaultEnvelope(durationMs)
  }

  function addPoint(timeMs: number, gain: number): number {
    const { points, index } = insertEnvelopePoint(draftPoints.value, timeMs, gain)
    draftPoints.value = points
    return index
  }

  function movePoint(index: number, timeMs: number, gain: number): void {
    draftPoints.value = moveEnvelopePoint(draftPoints.value, index, timeMs, gain)
  }

  function removePoint(index: number): void {
    draftPoints.value = removeEnvelopePoint(draftPoints.value, index)
  }

  function reset(durationMs: number): void {
    draftPoints.value = defaultEnvelope(durationMs)
  }

  function committedPoints(): ClipEnvelopePoint[] {
    return normalisedDraft()
  }

  return {
    draftPoints,
    hasChanged,
    initialise,
    addPoint,
    movePoint,
    removePoint,
    reset,
    committedPoints
  }
}
