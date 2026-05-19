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
import { useLibraryStore } from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { RULER_HEIGHT, SCROLLBAR_HEIGHT, SCROLLBAR_WIDTH, TRACK_HEIGHT, TRACK_GAP } from './constants'
import type { GridGeometry } from './useGridGeometry'

/** Edge-zone width in PIXELS for trim-vs-move hit detection. A click
 *  within this many pixels of a clip's left/right edge enters trim
 *  mode; anything further in is a move drag. Chosen so a careful user
 *  can still grab the body of a narrow clip without accidentally
 *  trimming. */
const TRIM_EDGE_PX = 8

/** Minimum clip length, ms. A trim drag can't shrink below this. */
const MIN_CLIP_MS = 50

/** Pointer-movement threshold (px) above which a clip pointerdown
 *  transitions from "potential click → seek" to "actual drag". Below
 *  the threshold, releasing the mouse counts as a click and seeks the
 *  playhead to that ms position. 3 px matches the OS-typical
 *  click-tolerance and is small enough that an intentional drag is
 *  detected almost instantly. */
const DRAG_THRESHOLD_PX = 3

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
  /**
   * CSS cursor name to apply to the timeline host. Updates live as the
   * pointer hovers a clip's edge (`ew-resize`) vs body (`default`) so
   * the user gets feedback about the available action without clicking.
   */
  hoverCursor: Ref<'default' | 'ew-resize'>
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
  const library = useLibraryStore()
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
  const hoverCursor = ref<'default' | 'ew-resize'>('default')
  // Active clip-drag state. `clipGrabOffsetMs` is the ms inside the clip
  // where the user originally clicked, so the clip's leading edge follows
  // the cursor minus that grab offset (then snaps to grid).
  let draggedClipId: string | null = null
  let clipGrabOffsetMs = 0
  // Active trim-drag state. Captured at pointerdown so we can compute
  // each move-delta against the original clip geometry, not the
  // already-mutated values.
  let trimClipId: string | null = null
  let trimEdge: 'left' | 'right' | null = null
  let trimOrigStartMs = 0
  let trimOrigInMs = 0
  let trimOrigDurationMs = 0
  let trimSourceDurationMs = 0
  let trimPointerStartMs = 0

  // Pending-drag state. A pointerdown on a clip enters this state
  // first; only once the cursor moves more than DRAG_THRESHOLD_PX do
  // we commit to either a move or trim drag. If the user releases the
  // mouse before crossing the threshold the gesture is treated as a
  // click → seek to that ms position.
  let pendingDragClipId: string | null = null
  let pendingDragEdge: 'left' | 'right' | null = null
  let pendingDragStartX = 0
  let pendingDragStartY = 0
  let pendingDragStartMs = 0

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

  /**
   * Returns 'left' or 'right' if the pointer is within `TRIM_EDGE_PX`
   * of the clip's corresponding edge in screen-space; null otherwise.
   * Edge zones are computed in pixels (not ms) so they stay
   * comfortable to hit regardless of clip duration / zoom level.
   * Very narrow clips degrade gracefully: if the body would be less
   * than 2 px wide, the right edge wins (you can still trim a tiny
   * clip, but moving it requires zooming in first).
   */
  function hitTestClipEdge(clientX: number, region: ClipHitRegion): 'left' | 'right' | null {
    if (!host.value) return null
    const rect = host.value.getBoundingClientRect()
    const worldX = (clientX - rect.left) + scrollX.value
    const leftDist = worldX - region.x
    const rightDist = region.x + region.w - worldX
    // Cap the edge zone at a third of the clip width so a tiny clip
    // doesn't become "all edge" (impossible to move). For very wide
    // clips the cap never kicks in.
    const edge = Math.min(TRIM_EDGE_PX, region.w / 3)
    if (leftDist <= edge) return 'left'
    if (rightDist <= edge) return 'right'
    return null
  }

  /** Source-file duration for a clip's underlying audio in ms. Used to
   *  clamp the right-edge trim so we can't ask the engine to play
   *  beyond the file's end. Falls back to the clip's current `inMs +
   *  durationMs` (i.e. assume "we're already at the end") if the
   *  library doesn't know about it yet — defensive: that gives the
   *  user no extra right-stretch room until library metadata loads. */
  function getSourceDurationMs(clip: { filePath: string; inMs: number; durationMs: number }): number {
    const item = library.items.find((i) => i.filePath === clip.filePath)
    if (item && item.durationMs > 0) return item.durationMs
    // Peaks fallback: same PEAKS_PER_SECOND constant as the renderer.
    return clip.inMs + clip.durationMs
  }

  /** Which track row the pointer's clientY currently lies inside, or
   *  null if the pointer is in the ruler band, in the inter-track gap
   *  between rows, or below the last row. Used by clip drag to allow
   *  cross-track moves: as the cursor moves into a different row,
   *  moveClip is called with the new trackId so the clip re-parents. */
  function pointerToTrackId(clientY: number): string | null {
    if (!host.value) return null
    const rect = host.value.getBoundingClientRect()
    const y = clientY - rect.top
    if (y < RULER_HEIGHT) return null
    const contentY = y + scrollY.value - RULER_HEIGHT
    const slot = TRACK_HEIGHT + TRACK_GAP
    const trackIndex = Math.floor(contentY / slot)
    if (trackIndex < 0 || trackIndex >= project.tracks.length) return null
    const yWithinSlot = contentY - trackIndex * slot
    // Pointer in the inter-track gap: no decisive answer — keep the
    // current track (caller sees `null`).
    if (yWithinSlot >= TRACK_HEIGHT) return null
    return project.tracks[trackIndex]?.id ?? null
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

    // Clip-hit branch — defer drag vs click decision until pointer-move
    // crosses the threshold. A static click (no move) on the clip body
    // seeks the playhead to that ms position; a click on an edge does
    // the same (you'd have to move to actually trim). This means clicks
    // anywhere on a clip act as seek points without sacrificing drag
    // affordance.
    const hit = hitTestClip(e.clientX, e.clientY)
    if (hit) {
      const clip = project.clips[hit.clipId]
      if (clip) {
        const pointerMs = pointerToRawMs(e.clientX)
        if (pointerMs !== null) {
          // Clip click — select both the clip and its host track so
          // a subsequent paste lands on this track. Selecting the
          // track at the same time means "the obvious target" matches
          // what the user just clicked on.
          project.selectClip(clip.id)
          project.selectTrack(clip.trackId)
          pendingDragClipId = clip.id
          pendingDragEdge = hitTestClipEdge(e.clientX, hit)
          pendingDragStartX = e.clientX
          pendingDragStartY = e.clientY
          pendingDragStartMs = pointerMs
          window.addEventListener('pointermove', onPendingPointerMove)
          window.addEventListener('pointerup', onPendingPointerUp)
          window.addEventListener('pointercancel', onPendingPointerUp)
          e.preventDefault()
          return
        }
      }
    }

    // Pointer landed somewhere in the track area but not on a clip.
    // Decide whether it was inside a track row (→ select that track
    // and clear clip selection) or in an inter-track gap / below the
    // last row (→ clear both selections).
    const rowTrackId = pointerToTrackId(e.clientY)
    if (rowTrackId !== null) {
      project.selectClip(null)
      project.selectTrack(rowTrackId)
    } else if (y >= RULER_HEIGHT) {
      // In the track area but in a gap / below the last row.
      project.selectClip(null)
      project.selectTrack(null)
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
    let target: number
    if (e.altKey) {
      // Alt = fine drag (1 ms resolution, no snap). Read per move so
      // the user can flip in and out of fine mode without restarting.
      target = Math.max(0, Math.round(rawStartMs))
    } else {
      const snap = geometry.msPerSubBeat()
      // Beat-aware snap: when the clip's source file has detected
      // beats and at least one of them falls inside the clip's trim
      // window, snap so that beat lines up with a project sub-beat
      // (instead of snapping the raw clip edge). The reference beat
      // is the first detected beat inside the window — usually the
      // musically meaningful downbeat of the clip.
      const referenceBeatOffsetMs = firstBeatOffsetMs(clip)
      if (referenceBeatOffsetMs !== null) {
        const projectBeat = rawStartMs + referenceBeatOffsetMs
        const snappedBeat = Math.round(projectBeat / snap) * snap
        target = Math.max(0, snappedBeat - referenceBeatOffsetMs)
      } else {
        // No source beats known — fall back to the legacy edge-snap.
        target = Math.max(0, Math.round(rawStartMs / snap) * snap)
      }
    }
    const destTrackId = pointerToTrackId(e.clientY) ?? clip.trackId
    project.moveClip(clip.id, target, destTrackId)
    onClipMoved()
  }

  /** Returns the offset (ms) from the clip's left edge to the first
   *  source-grid beat inside the clip's window, or null if the clip's
   *  source file has no detected beats / BPM yet. Uses the *same
   *  source-global beat grid* as `useTimelineDrawing.drawClip` — both
   *  views anchor on `beats[0]` and step by `60/sourceBpm`, so the
   *  snap target is exactly the first drawn marker. */
  function firstBeatOffsetMs(clip: {
    filePath: string
    inMs: number
    durationMs: number
  }): number | null {
    const item = library.items.find((i) => i.filePath === clip.filePath)
    const beats = item?.beats
    const sourceBpm = item?.bpm
    const anchorSec = item?.beatAnchorSec ?? beats?.[0]
    if (!beats || beats.length === 0 || !sourceBpm || sourceBpm <= 0 || anchorSec === undefined) {
      return null
    }
    const inMs = clip.inMs
    const outMs = inMs + clip.durationMs
    const beatSpacingMs = (60 / sourceBpm) * 1000
    const universalAnchorMs = anchorSec * 1000
    let firstBeatMs =
      universalAnchorMs +
      Math.ceil((inMs - universalAnchorMs) / beatSpacingMs) * beatSpacingMs
    while (firstBeatMs < inMs) firstBeatMs += beatSpacingMs
    if (firstBeatMs > outMs) return null
    return firstBeatMs - inMs
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

  /** Detach the pending-drag listeners. Called from both the "promoted
   *  to real drag" path and the "released as a click" path. */
  function clearPendingDrag(): void {
    pendingDragClipId = null
    pendingDragEdge = null
    window.removeEventListener('pointermove', onPendingPointerMove)
    window.removeEventListener('pointerup', onPendingPointerUp)
    window.removeEventListener('pointercancel', onPendingPointerUp)
  }

  function onPendingPointerMove(e: PointerEvent): void {
    if (pendingDragClipId === null) return
    const dx = e.clientX - pendingDragStartX
    const dy = e.clientY - pendingDragStartY
    if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return

    const clip = project.clips[pendingDragClipId]
    const edge = pendingDragEdge
    const startMs = pendingDragStartMs
    clearPendingDrag()
    if (!clip) return

    if (edge) {
      // Threshold crossed in trim mode.
      trimClipId = clip.id
      trimEdge = edge
      trimOrigStartMs = clip.startMs
      trimOrigInMs = clip.inMs
      trimOrigDurationMs = clip.durationMs
      trimSourceDurationMs = getSourceDurationMs(clip)
      trimPointerStartMs = startMs
      log.info(
        'drag',
        `clip trim start id=${clip.id} edge=${edge} src=${trimSourceDurationMs}ms`
      )
      window.addEventListener('pointermove', onTrimPointerMove)
      window.addEventListener('pointerup', onTrimPointerUp)
      window.addEventListener('pointercancel', onTrimPointerUp)
      // Replay the current move so the first delta is applied immediately.
      onTrimPointerMove(e)
      return
    }

    // Threshold crossed in move mode.
    draggedClipId = clip.id
    clipGrabOffsetMs = startMs - clip.startMs
    log.info('drag', `clip drag start id=${clip.id} from=${clip.startMs}ms`)
    window.addEventListener('pointermove', onClipPointerMove)
    window.addEventListener('pointerup', onClipPointerUp)
    window.addEventListener('pointercancel', onClipPointerUp)
    onClipPointerMove(e)
  }

  /** Pointer released before the drag threshold was crossed — treat as
   *  a click on the clip and seek the playhead to the click's ms
   *  position. Snaps to the grid unless Alt is held (consistent with
   *  the ruler seek). */
  function onPendingPointerUp(e: PointerEvent): void {
    if (pendingDragClipId === null) return
    clearPendingDrag()
    const ms = pointerToMs(e.clientX, e.altKey)
    if (ms !== null) seekTo(ms)
  }

  function onTrimPointerMove(e: PointerEvent): void {
    if (trimClipId === null || trimEdge === null) return
    const clip = project.clips[trimClipId]
    if (!clip) return
    const pointerMs = pointerToRawMs(e.clientX)
    if (pointerMs === null) return
    // Round pointer delta to whole milliseconds — the user asked for
    // ms-precision trim, not grid snap.
    const deltaMs = Math.round(pointerMs - trimPointerStartMs)

    if (trimEdge === 'left') {
      // Left-edge trim: dragging right (positive delta) shrinks from
      // the left — `startMs` moves right by delta, `inMs` increases by
      // delta, `durationMs` decreases by delta. Constraints:
      //   - inMs >= 0   (can't read before the start of the source)
      //   - durationMs >= MIN_CLIP_MS
      // Both reduce to clamping `delta` into a permitted range.
      const minDelta = -trimOrigInMs
      const maxDelta = trimOrigDurationMs - MIN_CLIP_MS
      const clamped = Math.max(minDelta, Math.min(maxDelta, deltaMs))
      const newStartMs = trimOrigStartMs + clamped
      const newInMs = trimOrigInMs + clamped
      const newDurationMs = trimOrigDurationMs - clamped
      if (
        newStartMs === clip.startMs &&
        newInMs === clip.inMs &&
        newDurationMs === clip.durationMs
      ) {
        return
      }
      project.trimClip(clip.id, newStartMs, newInMs, newDurationMs)
    } else {
      // Right-edge trim: positive delta grows the clip from the right,
      // negative shrinks it. `startMs` and `inMs` stay put.
      // Constraints:
      //   - durationMs >= MIN_CLIP_MS
      //   - inMs + durationMs <= sourceDurationMs
      const minDelta = MIN_CLIP_MS - trimOrigDurationMs
      const maxDelta = trimSourceDurationMs - (trimOrigInMs + trimOrigDurationMs)
      const clamped = Math.max(minDelta, Math.min(maxDelta, deltaMs))
      const newDurationMs = trimOrigDurationMs + clamped
      if (newDurationMs === clip.durationMs) return
      project.trimClip(clip.id, trimOrigStartMs, trimOrigInMs, newDurationMs)
    }
    onClipMoved()
  }

  function onTrimPointerUp(_e: PointerEvent): void {
    if (trimClipId === null) return
    const clip = project.clips[trimClipId]
    log.info(
      'drag',
      `clip trim end id=${trimClipId} edge=${trimEdge} -> start=${clip?.startMs ?? '?'}ms in=${clip?.inMs ?? '?'}ms dur=${clip?.durationMs ?? '?'}ms`
    )
    trimClipId = null
    trimEdge = null
    window.removeEventListener('pointermove', onTrimPointerMove)
    window.removeEventListener('pointerup', onTrimPointerUp)
    window.removeEventListener('pointercancel', onTrimPointerUp)
  }

  /** Track cursor hover state so the host can show `ew-resize` over
   *  clip edges. Skipped while any drag is active to keep the cursor
   *  stable mid-drag. */
  function onHostPointerMove(e: PointerEvent): void {
    if (
      draggedClipId !== null ||
      trimClipId !== null ||
      isDraggingPlayhead.value
    ) {
      return
    }
    const hit = hitTestClip(e.clientX, e.clientY)
    if (!hit) {
      if (hoverCursor.value !== 'default') hoverCursor.value = 'default'
      return
    }
    const edge = hitTestClipEdge(e.clientX, hit)
    const next = edge ? 'ew-resize' : 'default'
    if (hoverCursor.value !== next) hoverCursor.value = next
  }

  function onHostPointerLeave(): void {
    if (hoverCursor.value !== 'default') hoverCursor.value = 'default'
  }

  // Attach `pointerdown` once the host element is available. Using a
  // `watch` rather than `onMounted` keeps us safe if the host ref is
  // populated asynchronously (template ref under a v-if etc.).
  const stopHostWatch = watch(
    host,
    (el, prev) => {
      prev?.removeEventListener('pointerdown', onPointerDown)
      prev?.removeEventListener('pointermove', onHostPointerMove)
      prev?.removeEventListener('pointerleave', onHostPointerLeave)
      el?.addEventListener('pointerdown', onPointerDown)
      el?.addEventListener('pointermove', onHostPointerMove)
      el?.addEventListener('pointerleave', onHostPointerLeave)
    },
    { immediate: true }
  )

  onBeforeUnmount(() => {
    stopHostWatch()
    host.value?.removeEventListener('pointerdown', onPointerDown)
    host.value?.removeEventListener('pointermove', onHostPointerMove)
    host.value?.removeEventListener('pointerleave', onHostPointerLeave)
    window.removeEventListener('pointermove', onPlayheadPointerMove)
    window.removeEventListener('pointerup', onPlayheadPointerUp)
    window.removeEventListener('pointercancel', onPlayheadPointerUp)
    window.removeEventListener('pointermove', onClipPointerMove)
    window.removeEventListener('pointerup', onClipPointerUp)
    window.removeEventListener('pointercancel', onClipPointerUp)
    window.removeEventListener('pointermove', onTrimPointerMove)
    window.removeEventListener('pointerup', onTrimPointerUp)
    window.removeEventListener('pointercancel', onTrimPointerUp)
    window.removeEventListener('pointermove', onPendingPointerMove)
    window.removeEventListener('pointerup', onPendingPointerUp)
    window.removeEventListener('pointercancel', onPendingPointerUp)
  })

  return { isDraggingPlayhead, hoverCursor }
}
