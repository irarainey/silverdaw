// Reactive grid + zoom geometry for the timeline. Owns horizontal zoom
// (`pxPerSecond`) and derived pixel/ms/beat/sub-beat conversions for the
// renderer, drag handlers and drop zone, plus the snap unit (a quarter-beat at
// 4/4). Reads project duration, transport BPM and header width via Pinia.

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { msPerSubBeat as msPerSubBeatAt } from '@/lib/musicTime'
import {
  DEFAULT_PX_PER_SECOND,
  MAX_PX_PER_SECOND,
  MIN_PX_PER_SECOND,
  ZOOM_STEP_PX_PER_SECOND,
  SUBDIVISIONS_PER_BEAT,
  TIME_SIG_NUM
} from './constants'

export interface GridGeometry {
  /** Current horizontal zoom level. Writable so the wheel handler can mutate. */
  pxPerSecond: Ref<number>
  /** Reactive width of the (user-resizable) track-header column. */
  headerWidthRef: ComputedRef<number>
  /** Convenience getter for non-reactive call sites (`headerWidth()`). */
  headerWidth: () => number
  /** Total horizontal pixels of content past the header column. */
  contentPx: ComputedRef<number>
  /** Pixels per beat at the current BPM + zoom. */
  pxPerBeat: ComputedRef<number>
  /** Pixels per sub-beat (1/16 of a bar at 4/4). */
  pxPerSub: ComputedRef<number>
  /** Number of sub-beats in one bar (e.g. 16 at 4/4). */
  subsPerBar: number
  /** Snap unit in milliseconds (one sub-beat at the current BPM). */
  msPerSubBeat: () => number
  /** Clamp + apply a new zoom; returns the value actually applied. */
  setPxPerSecond: (next: number) => number
}

export function useGridGeometry(): GridGeometry {
  const project = useProjectStore()
  const transport = useTransportStore()
  const ui = useUiStore()

  const pxPerSecond = ref(DEFAULT_PX_PER_SECOND)

  const headerWidthRef = computed(() => ui.trackHeaderWidth)
  const headerWidth = (): number => ui.trackHeaderWidth

  const contentPx = computed(() => Math.max(0, (project.durationMs / 1000) * pxPerSecond.value))

  const pxPerBeat = computed(() => (60 / transport.bpm) * pxPerSecond.value)
  const pxPerSub = computed(() => pxPerBeat.value / SUBDIVISIONS_PER_BEAT)
  const subsPerBar = SUBDIVISIONS_PER_BEAT * TIME_SIG_NUM

  // Function (not computed) so callers always read the *latest* BPM even
  // mid-drag without each handler having to wire up its own watcher.
  // Single source of truth lives in `lib/musicTime.ts`.
  const msPerSubBeat = (): number => msPerSubBeatAt(transport.bpm, SUBDIVISIONS_PER_BEAT)

  function setPxPerSecond(next: number): number {
    const stepped = Math.round(next / ZOOM_STEP_PX_PER_SECOND) * ZOOM_STEP_PX_PER_SECOND
    const clamped = Math.min(MAX_PX_PER_SECOND, Math.max(MIN_PX_PER_SECOND, stepped))
    pxPerSecond.value = clamped
    return clamped
  }

  return {
    pxPerSecond,
    headerWidthRef,
    headerWidth,
    contentPx,
    pxPerBeat,
    pxPerSub,
    subsPerBar,
    msPerSubBeat,
    setPxPerSecond
  }
}
