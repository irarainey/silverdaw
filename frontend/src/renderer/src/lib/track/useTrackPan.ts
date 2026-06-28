// Track-header pan control: a bipolar equal-power pan in [-1, 1] (centre = 0)
// shown directly under the gain fader. Live editing pushes `setTrackPan` on
// every `input` — coalesced into one undo step *per track* via a `gestureId` —
// and commits with `gestureEnd` on `change`; double-click recentres. Scoped by
// track id so dragging one track's pan never coalesces with another's. Extracted
// so TrackHeaderPanel.vue stays focused on layout + drag.

import { getCurrentInstance, onBeforeUnmount } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useFxGesture } from '@/lib/fx/useFxGesture'

export interface TrackPanControl {
  /** Format a pan value as `C` / `L<n>` / `R<n>` (n = 0..100). */
  panDisplay: (pan: number | undefined) => string
  /** Live drag sample: push pan, keep the per-track gesture open. */
  onPanInput: (trackId: string, value: number) => void
  /** Drag release: push pan and close the per-track gesture (one undo step). */
  onPanChange: (trackId: string, value: number) => void
  /** Double-click: recentre and close the gesture. */
  onPanReset: (trackId: string) => void
}

export function useTrackPan(): TrackPanControl {
  const project = useProjectStore()
  const gesture = useFxGesture('pan')

  function panDisplay(pan: number | undefined): string {
    const v = typeof pan === 'number' ? pan : 0
    const pct = Math.round(Math.abs(v) * 100)
    if (pct === 0) return 'C'
    return v < 0 ? `L${pct}` : `R${pct}`
  }

  function onPanInput(trackId: string, value: number): void {
    if (!Number.isFinite(value)) return
    project.setTrackPan(trackId, value, {
      gestureId: gesture.ensureGesture(trackId),
      gestureEnd: false
    })
  }

  function onPanChange(trackId: string, value: number): void {
    try {
      if (!Number.isFinite(value)) return
      project.setTrackPan(trackId, value, {
        gestureId: gesture.ensureGesture(trackId),
        gestureEnd: true
      })
    } finally {
      gesture.endGesture()
    }
  }

  function onPanReset(trackId: string): void {
    try {
      project.setTrackPan(trackId, 0, { gestureEnd: true })
    } finally {
      gesture.endGesture()
    }
  }

  // Close any open gesture if the header unmounts mid-drag so the next
  // interaction starts a clean undo step. Guarded so the composable can also be
  // used (and unit-tested) outside a component instance.
  if (getCurrentInstance()) onBeforeUnmount(gesture.endGesture)

  return { panDisplay, onPanInput, onPanChange, onPanReset }
}
