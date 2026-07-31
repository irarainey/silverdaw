// Reactive grid + zoom geometry for the timeline. Owns horizontal zoom
// (`pxPerSecond`) and derived pixel/ms/beat/sub-beat conversions for the
// renderer, drag handlers and drop zone, plus the snap unit, which follows the
// user's Snap grid selection. Reads project duration, transport BPM, snap grid
// and header width via Pinia.

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { msPerSnapUnit, snapMs } from '@/lib/musicTime'
import { gridSubdivisionsPerBeat } from '@shared/snapGrid'
import {
  DEFAULT_PX_PER_SECOND,
  MAX_PX_PER_SECOND,
  MIN_PX_PER_SECOND,
  ZOOM_STEP_PX_PER_SECOND,
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
  /** Sub-beat tier currently drawn, following the Snap grid. */
  subsPerBeat: ComputedRef<number>
  /** Pixels per drawn sub-beat. */
  pxPerSub: ComputedRef<number>
  /** Number of drawn sub-beats in one bar. */
  subsPerBar: ComputedRef<number>
  /** Snap step in milliseconds at the current BPM and Snap grid; 0 means Free. */
  snapUnitMs: () => number
  /** Quantise a timeline position, honouring the Snap grid and Alt fine mode. */
  snapTimelineMs: (positionMs: number, fineMode: boolean) => number
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
  const subsPerBeat = computed(() => gridSubdivisionsPerBeat(ui.snapGrid))
  const pxPerSub = computed(() => pxPerBeat.value / subsPerBeat.value)
  const subsPerBar = computed(() => subsPerBeat.value * TIME_SIG_NUM)

  // Functions (not computeds) so callers always read the *latest* BPM and snap
  // grid even mid-drag without each handler having to wire up its own watcher.
  // Single source of truth lives in `lib/musicTime.ts`.
  const snapUnitMs = (): number => msPerSnapUnit(transport.bpm, ui.snapGrid)
  const snapTimelineMs = (positionMs: number, fineMode: boolean): number =>
    snapMs(positionMs, transport.bpm, ui.snapGrid, fineMode)

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
    subsPerBeat,
    pxPerSub,
    subsPerBar,
    snapUnitMs,
    snapTimelineMs,
    setPxPerSecond
  }
}
