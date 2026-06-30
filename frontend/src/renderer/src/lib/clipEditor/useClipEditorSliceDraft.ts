// Draft loop-slice state for the Clip Editor.
//
// Transactional draft: slice markers live here until the user commits a slice
// action (to timeline or to samples); closing Slice mode discards them. Markers
// are SOURCE-ABSOLUTE ms (the viewport's native space) so they stay glued to the
// audio regardless of warp, and are kept sorted, edge-/neighbour-guarded, and
// capped via the pure `loopSlice` helpers. Manual drags clamp between neighbours
// rather than being dropped mid-gesture; generation and one-shot adds reguard.

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import {
  applySliceGuards,
  generateGridSlices,
  DEFAULT_MIN_SLICE_MS,
  MAX_SLICES,
  type SliceSubdivision
} from '@/lib/clipEditor/loopSlice'

export interface ClipEditorSliceDraft {
  /** Working slice markers, source-absolute ms, ascending and guarded. */
  markers: Ref<number[]>
  /** Subdivision used by "generate to grid". */
  subdivision: Ref<SliceSubdivision>
  /** True when at least one marker exists. */
  hasMarkers: ComputedRef<boolean>
  /** True when the marker count has reached the hard cap. */
  atCap: ComputedRef<boolean>

  /** Reset markers and pin the clip's source window used for all guards. */
  initialise(windowInMs: number, windowDurationMs: number): void
  /** Replace markers with the current subdivision's grid over the window. */
  generateToGrid(sourceBpm: number | undefined, anchorSec: number | undefined): void
  /** Insert a marker (source ms); returns its index, or -1 if guards dropped it. */
  addMarker(sourceMs: number): number
  /** Drag a marker, clamped between its neighbours/edges; returns its index. */
  moveMarker(index: number, sourceMs: number): number
  /** Remove the marker at `index`. */
  removeMarker(index: number): void
  /** Clear all markers. */
  clear(): void
  /** The guarded markers to commit. */
  committedMarkers(): number[]
}

export function useClipEditorSliceDraft(): ClipEditorSliceDraft {
  const markers = ref<number[]>([])
  const subdivision = ref<SliceSubdivision>('1/8')
  const windowInMs = ref(0)
  const windowDurationMs = ref(0)

  const hasMarkers = computed(() => markers.value.length > 0)
  const atCap = computed(() => markers.value.length >= MAX_SLICES)

  function guard(times: readonly number[]): number[] {
    return applySliceGuards(times, windowInMs.value, windowDurationMs.value)
  }

  function initialise(inMs: number, durationMs: number): void {
    windowInMs.value = inMs
    windowDurationMs.value = durationMs
    markers.value = []
  }

  function generateToGrid(sourceBpm: number | undefined, anchorSec: number | undefined): void {
    markers.value = generateGridSlices({
      sourceBpm,
      anchorSec,
      subdivision: subdivision.value,
      windowInMs: windowInMs.value,
      windowDurationMs: windowDurationMs.value
    })
  }

  function addMarker(sourceMs: number): number {
    markers.value = guard([...markers.value, sourceMs])
    return nearestIndex(sourceMs)
  }

  function moveMarker(index: number, sourceMs: number): number {
    const list = markers.value
    if (index < 0 || index >= list.length) return -1
    const prev = list[index - 1]
    const next = list[index + 1]
    const lower = (prev ?? windowInMs.value - DEFAULT_MIN_SLICE_MS) + DEFAULT_MIN_SLICE_MS
    const upper =
      (next ?? windowInMs.value + windowDurationMs.value + DEFAULT_MIN_SLICE_MS) - DEFAULT_MIN_SLICE_MS
    if (lower > upper) return index
    const clamped = Math.max(lower, Math.min(upper, sourceMs))
    const updated = [...list]
    updated[index] = clamped
    markers.value = updated
    return index
  }

  function removeMarker(index: number): void {
    if (index < 0 || index >= markers.value.length) return
    markers.value = markers.value.filter((_, i) => i !== index)
  }

  function clear(): void {
    markers.value = []
  }

  function committedMarkers(): number[] {
    return guard(markers.value)
  }

  function nearestIndex(sourceMs: number): number {
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < markers.value.length; i++) {
      const d = Math.abs((markers.value[i] ?? Infinity) - sourceMs)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return best
  }

  return {
    markers,
    subdivision,
    hasMarkers,
    atCap,
    initialise,
    generateToGrid,
    addMarker,
    moveMarker,
    removeMarker,
    clear,
    committedMarkers
  }
}
