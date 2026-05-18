// Pointer-down drag handlers for the timeline canvas.
//
// Handles two overlapping interactions on `pointerdown`:
//   1. Clip drag — if the pointer lands on a drawn clip block, drag it
//      to a new start time (snapped to the project sub-beat).
//   2. Playhead seek-drag — otherwise, snap the playhead to the nearest
//      sub-beat and keep re-seeking on pointer-move.
//
// Hit-testing for (1) reads the clip rectangles populated by the
// component's `drawClip` pass; the caller passes a getter so the
// composable doesn't need to know about the rendering internals.
//
// `isDraggingPlayhead` is exposed (read-only) because the playhead
// auto-follow logic in the component needs to keep scrolling while the
// user is dragging, even though `transport.isPlaying` is false.

import { onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { Application } from 'pixi.js'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { RULER_HEIGHT, SCROLLBAR_HEIGHT, SCROLLBAR_WIDTH } from './constants'
import type { GridGeometry } from './useGridGeometry'

/**
 * World-space rectangle of a single drawn clip block. `x` / `y` are in
 * absolute timeline-content coordinates; the hit-test below converts to
 * viewport space using the current `scrollX/Y` so we can keep the
 * regions stable across scroll without redrawing.
 */
export interface ClipHitRegion {
  clipId: string
  x: number
  y: number
  w: number
  h: number
}

export interface DragHandlers {
  /** True while the user is dragging the playhead (used for auto-follow). */
  isDraggingPlayhead: Ref<boolean>
}

export interface DragHandlersOptions {
  host: Ref<HTMLElement | null>
  app: Readonly<Ref<Application | null>>
  scrollX: Ref<number>
  scrollY: Ref<number>
  showScrollbar: ComputedRef<boolean>
  geometry: GridGeometry
  /** Returns the latest clip-hit-regions array (populated by drawClip). */
  getClipHitRegions: () => readonly ClipHitRegion[]
  /** Fires after a clip's `startMs` was updated so the component can repaint. */
  onClipMoved: () => void
  /** Fires after the playhead position was updated. */
  onPlayheadMoved: () => void
}

export function useDragHandlers(opts: DragHandlersOptions): DragHandlers {
  const project = useProjectStore()
  const transport = useTransportStore()
  const {
    host,
    app,
    scrollX,
    scrollY,
    showScrollbar,
    geometry,
    getClipHitRegions,
    onClipMoved,
    onPlayheadMoved
  } = opts

  const isDraggingPlayhead = ref(false)
  // Active clip-drag state. `clipGrabOffsetMs` is the ms inside the clip
  // where the user originally clicked, so the clip's leading edge follows
  // the cursor minus that grab offset (then snaps to grid).
  let draggedClipId: string | null = null
  let clipGrabOffsetMs = 0

  // ─── Pixel ↔ ms helpers ──────────────────────────────────────────────
  /**
   * Convert a pointer client-x to a timeline-ms position, either snapped
   * to the sub-beat grid (Alt key NOT held — default behaviour for
   * click-to-seek and playhead drag) or rounded to the nearest whole
   * millisecond when the user is holding Alt. The latter is the
   * finest meaningful resolution for seeking and future clip-split
   * operations — at the maximum zoom of 480 px/sec, 1 ms ≈ 0.5 px,
   * which is sub-pixel and below human-perception threshold either
   * way. Returns null when the pointer is outside the track-content
   * area.
   */
  function pointerToMs(clientX: number, fineMode: boolean): number | null {
    const a = app.value
    if (!host.value || !a) return null
    const rect = host.value.getBoundingClientRect()
    const x = clientX - rect.left
    const rightEdge = a.renderer.screen.width - SCROLLBAR_WIDTH
    if (x < geometry.headerWidth() || x > rightEdge) return null
    const trackLocalX = x - geometry.headerWidth()
    const rawMs = ((scrollX.value + trackLocalX) / geometry.pxPerSecond.value) * 1000
    if (fineMode) {
      // Whole-millisecond resolution. Caller (Alt-modifier seek) wants
      // sample-accurate placement, not grid-snap.
      return Math.max(0, Math.round(rawMs))
    }
    const snap = geometry.msPerSubBeat()
    return Math.max(0, Math.round(rawMs / snap) * snap)
  }

  /**
   * Unsnapped pointer-X → timeline ms. Used by clip drag where we want raw
   * ms (so we can subtract the grab offset before snapping the clip's
   * leading edge). Returns null outside the track-content area.
   */
  function pointerToRawMs(clientX: number): number | null {
    const a = app.value
    if (!host.value || !a) return null
    const rect = host.value.getBoundingClientRect()
    const x = clientX - rect.left
    const rightEdge = a.renderer.screen.width - SCROLLBAR_WIDTH
    if (x < geometry.headerWidth() || x > rightEdge) return null
    return ((scrollX.value + x - geometry.headerWidth()) / geometry.pxPerSecond.value) * 1000
  }

  function seekTo(positionMs: number): void {
    transport.setPosition(positionMs)
    sendBridge('TRANSPORT_SEEK', { positionMs })
    onPlayheadMoved()
  }

  function hitTestClip(clientX: number, clientY: number): ClipHitRegion | null {
    if (!host.value) return null
    const rect = host.value.getBoundingClientRect()
    // Convert pointer to WORLD coordinates by adding the current scroll.
    // The hit regions are stored in world coords by `drawClip`.
    const worldX = (clientX - rect.left) + scrollX.value
    const worldY = (clientY - rect.top) + scrollY.value
    const regions = getClipHitRegions()
    // Iterate in reverse so the top-most drawn clip wins if any overlap.
    for (let i = regions.length - 1; i >= 0; i--) {
      const r = regions[i]
      if (!r) continue
      if (worldX >= r.x && worldX <= r.x + r.w && worldY >= r.y && worldY <= r.y + r.h) return r
    }
    return null
  }

  // ─── Pointer event handlers ──────────────────────────────────────────
  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return
    if (project.tracks.length === 0) return
    const a = app.value
    if (!host.value || !a) return

    // Ignore clicks below the horizontal scrollbar lane so dragging the
    // scrollbar thumb doesn't double-trigger a seek.
    const rect = host.value.getBoundingClientRect()
    const y = e.clientY - rect.top
    const bottomLimit = a.renderer.screen.height - (showScrollbar.value ? SCROLLBAR_HEIGHT : 0)
    if (y > bottomLimit) return

    // Clip drag takes priority anywhere in the track rows — if pointer
    // lands on a clip block, start a clip drag.
    const hit = hitTestClip(e.clientX, e.clientY)
    if (hit) {
      const clip = project.clips[hit.clipId]
      if (clip) {
        const pointerMs = pointerToRawMs(e.clientX)
        if (pointerMs !== null) {
          draggedClipId = clip.id
          clipGrabOffsetMs = pointerMs - clip.startMs
          log.info('drag', `clip drag start id=${clip.id} from=${clip.startMs}ms`)
          window.addEventListener('pointermove', onClipPointerMove)
          window.addEventListener('pointerup', onClipPointerUp)
          window.addEventListener('pointercancel', onClipPointerUp)
          e.preventDefault()
          return
        }
      }
    }

    // Playhead seek is constrained to the ruler band. Clicking in the
    // empty area of a track row no longer moves the playhead — it would
    // otherwise be too easy to lose your position while trying to click
    // near (but not on) a clip. The ruler is the canonical "timeline
    // ribbon" in every other DAW so users already expect this.
    if (y >= RULER_HEIGHT) return

    const ms = pointerToMs(e.clientX, e.altKey)
    if (ms === null) return

    isDraggingPlayhead.value = true
    window.addEventListener('pointermove', onPlayheadPointerMove)
    window.addEventListener('pointerup', onPlayheadPointerUp)
    window.addEventListener('pointercancel', onPlayheadPointerUp)
    seekTo(ms)
    e.preventDefault()
  }

  function onPlayheadPointerMove(e: PointerEvent): void {
    if (!isDraggingPlayhead.value) return
    // Honour Alt LIVE — the user can toggle fine mode mid-drag by
    // pressing / releasing the key without restarting the drag.
    const ms = pointerToMs(e.clientX, e.altKey)
    if (ms === null) return
    if (ms === transport.positionMs) return
    seekTo(ms)
  }

  function onPlayheadPointerUp(_e: PointerEvent): void {
    if (!isDraggingPlayhead.value) return
    isDraggingPlayhead.value = false
    window.removeEventListener('pointermove', onPlayheadPointerMove)
    window.removeEventListener('pointerup', onPlayheadPointerUp)
    window.removeEventListener('pointercancel', onPlayheadPointerUp)
  }

  function onClipPointerMove(e: PointerEvent): void {
    if (draggedClipId === null) return
    const clip = project.clips[draggedClipId]
    if (!clip) return
    const pointerMs = pointerToRawMs(e.clientX)
    if (pointerMs === null) return

    const rawStartMs = pointerMs - clipGrabOffsetMs
    // Alt = fine drag (1 ms resolution, no grid snap). Read per move so
    // the user can flip in and out of fine mode without restarting the
    // drag. Releasing the drag at an unsnapped position keeps the
    // clip exactly where the pointer was — the next plain drag will
    // re-snap relative to the new position.
    let target: number
    if (e.altKey) {
      target = Math.max(0, Math.round(rawStartMs))
    } else {
      const snap = geometry.msPerSubBeat()
      target = Math.max(0, Math.round(rawStartMs / snap) * snap)
    }
    if (target === clip.startMs) return
    project.moveClip(clip.id, target)
    onClipMoved()
  }

  function onClipPointerUp(_e: PointerEvent): void {
    if (draggedClipId === null) return
    const endClip = project.clips[draggedClipId]
    log.info('drag', `clip drag end id=${draggedClipId} to=${endClip?.startMs ?? '?'}ms`)
    draggedClipId = null
    window.removeEventListener('pointermove', onClipPointerMove)
    window.removeEventListener('pointerup', onClipPointerUp)
    window.removeEventListener('pointercancel', onClipPointerUp)
  }

  // Attach `pointerdown` once the host element is available. Using a
  // `watch` rather than `onMounted` keeps us safe if the host ref is
  // populated asynchronously (template ref under a v-if etc.).
  const stopHostWatch = watch(
    host,
    (el, prev) => {
      prev?.removeEventListener('pointerdown', onPointerDown)
      el?.addEventListener('pointerdown', onPointerDown)
    },
    { immediate: true }
  )

  onBeforeUnmount(() => {
    stopHostWatch()
    host.value?.removeEventListener('pointerdown', onPointerDown)
    window.removeEventListener('pointermove', onPlayheadPointerMove)
    window.removeEventListener('pointerup', onPlayheadPointerUp)
    window.removeEventListener('pointercancel', onPlayheadPointerUp)
    window.removeEventListener('pointermove', onClipPointerMove)
    window.removeEventListener('pointerup', onClipPointerUp)
    window.removeEventListener('pointercancel', onClipPointerUp)
  })

  return { isDraggingPlayhead }
}
