// Timeline pointer handlers for clip/marker drag, trim, and ruler seek.
// Hit-testing uses clip rectangles populated by the drawing pass.

import { onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { Application } from 'pixi.js'
import { effectiveClipTempoRatio, isClipTempoWarpActive, useProjectStore } from '@/stores/projectStore'
import { trackStaticAutomationValue } from '@/stores/projectTrackActions'
import { useLibraryStore } from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { clipFirstBeatOffsetMs, effectiveClipDurationMs } from '@/lib/clip/clipTiming'
import { buildTrackRowLayout } from './trackLayout'
import { makeLaneHeightOf } from '@/lib/automation/laneLayout'
import { laneRegion, laneYToValue } from './automationLaneRenderer'
import { AUTOMATION_PARAMS } from '@/lib/automation/automationParams'
import { flatCurve, insertBreakpoint, moveBreakpoint, removeBreakpoint } from '@/lib/automation/breakpoints'
import { RULER_HEIGHT, SCROLLBAR_HEIGHT } from './constants'
import type { GridGeometry } from './useGridGeometry'
import { createTimelineQueries } from './timelineQueries'

/** Minimum clip length, ms. A trim drag can't shrink below this. */
const MIN_CLIP_MS = 50

/** Pixel threshold between click-to-seek and actual drag. */
const DRAG_THRESHOLD_PX = 3

/** World-space rectangle of a drawn clip block. */
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
  /** CSS cursor for live hover affordance. */
  hoverCursor: Ref<'default' | 'ew-resize' | 'grab' | 'grabbing'>
  /** Right-click delete of an automation breakpoint; true if one was removed. */
  removeAutomationPointAt(clientX: number, clientY: number): boolean
}

export interface DragHandlersOptions {
  host: Ref<HTMLElement | null>
  app: Readonly<Ref<Application | null>>
  scrollX: Ref<number>
  scrollY: Ref<number>
  maxScrollX: ComputedRef<number>
  showScrollbar: ComputedRef<boolean>
  geometry: GridGeometry
  getClipHitRegions: () => readonly ClipHitRegion[]
  /** Fires after clip geometry changes so the component can repaint. */
  onClipMoved: () => void
  /** Fires after marker geometry changes so the component can repaint. */
  onMarkerMoved: () => void
  /** Fires after the playhead position was updated. */
  onPlayheadMoved: () => void
}

interface ClipDragPointer {
  clientX: number
  clientY: number
  altKey: boolean
}

export function useDragHandlers(opts: DragHandlersOptions): DragHandlers {
  const project = useProjectStore()
  const library = useLibraryStore()
  const transport = useTransportStore()
  const ui = useUiStore()
  const {
    host,
    app,
    scrollX,
    scrollY,
    maxScrollX,
    showScrollbar,
    geometry,
    getClipHitRegions,
    onClipMoved,
    onMarkerMoved,
    onPlayheadMoved
  } = opts

  const {
    pointerToMs,
    pointerToRawMs,
    pointerToRawMsClamped,
    snapTimelineMs,
    clipAutoScrollDelta,
    clipAutoScrollDeltaAtMs,
    hitTestClip,
    hitTestMarker,
    hitTestPlayhead,
    hitTestTrimEdge,
    getSourceDurationMs,
    pointerToTrackId
  } = createTimelineQueries({
    host,
    app,
    scrollX,
    scrollY,
    maxScrollX,
    geometry,
    getClipHitRegions
  })

  const isDraggingPlayhead = ref(false)
  // The playhead gesture is active from pointer-down, but the follow-scroll flag
  // (isDraggingPlayhead) only flips on once the pointer crosses the drag threshold,
  // so a plain click seeks without the view jumping to re-centre it.
  let playheadPointerActive = false
  let playheadPointerStartX = 0
  let playheadPointerStartY = 0
  const hoverCursor = ref<'default' | 'ew-resize' | 'grab' | 'grabbing'>('default')
  // Clip drag keeps the original grab offset before snapping the leading edge.
  let draggedClipId: string | null = null
  let clipGrabOffsetMs = 0
  let latestClipDragPointer: ClipDragPointer | null = null
  // Group drag (Phase 2): dragging a clip that's part of a multi-selection moves the whole group
  // by a uniform delta from these captured origins, validated atomically by `moveClipGroup`.
  let groupDragActive = false
  let groupDragOrigins: { clipId: string; startMs: number; trackIndex: number }[] = []
  let groupDragAnchorId: string | null = null
  let groupDragAnchorOrigStartMs = 0
  let groupDragAnchorOrigTrackIndex = 0
  let groupAnchorGrabOffsetMs = 0
  // Sign of the group's net requested drag (+1 right, -1 left, 0 none) — picks which edge of the
  // group leads auto-scroll so the view follows the furthest clip.
  let groupDragDirection = 0
  let clipAutoScrollFrame: number | null = null
  // Edge auto-scroll while dragging the playhead, mirroring the clip drag loop.
  let latestPlayheadDragPointer: { clientX: number; altKey: boolean } | null = null
  let playheadAutoScrollFrame: number | null = null
  // Trim drags compare each move against original clip geometry.
  let trimClipId: string | null = null
  let trimEdge: 'left' | 'right' | null = null
  let trimOrigStartMs = 0
  let trimOrigInMs = 0
  let trimOrigDurationMs = 0
  let trimSourceDurationMs = 0
  let trimPointerStartMs = 0

  // Pending drag resolves to move/trim only after crossing the threshold.
  let pendingDragClipId: string | null = null
  let pendingDragEdge: 'left' | 'right' | null = null
  let pendingDragStartX = 0
  let pendingDragStartY = 0
  let pendingDragStartMs = 0
  // Locked clips can click-seek, but threshold-crossing drags suppress release seek.
  let pendingDragLocked = false
  let pendingDragSuppressSeek = false
  // True when the pending drag began on a clip that is part of a multi-selection via a PLAIN
  // click: the selection collapses to just that clip only once we know it's a drag or a click
  // (not on pointerdown), so a press-and-drag on one clip of a group doesn't discard the rest.
  let pendingDragCollapseMulti = false
  let draggedMarkerId: string | null = null
  // Pending marker drag: a press over a marker resolves to a move only after
  // crossing the threshold; a plain click falls through to a playhead seek.
  let pendingMarkerId: string | null = null
  let pendingMarkerStartX = 0
  let pendingMarkerStartY = 0

  // ── Automation lane editing (bottom strip of a track row) ───────────────────
  let autoTrackId: string | null = null
  let autoParam: import('@shared/bridge-protocol').AutomationParamId | null = null
  let autoPointIndex = -1
  let autoGestureId = ''

  /** If the pointer is inside a track's expanded automation lane, begin an add /
   *  move / remove edit and return true. Otherwise return false. */
  function tryBeginAutomationEdit(e: PointerEvent): boolean {
    if (!host.value) return false
    const trackId = pointerToTrackId(e.clientY)
    if (!trackId) return false
    const param = ui.automationLanes[trackId]
    if (!param) return false
    const idx = project.tracks.findIndex((t) => t.id === trackId)
    const slot = buildTrackRowLayout(project.tracks, makeLaneHeightOf())[idx]
    if (!slot) return false
    const rect = host.value.getBoundingClientRect()
    const worldY = e.clientY - rect.top + scrollY.value
    const { top, bottom } = laneRegion(slot.top, slot.clipHeight)
    if (worldY < top || worldY > bottom) return false
    const ms = pointerToRawMsClamped(e.clientX)
    if (ms === null) return false

    let points = (project.tracks[idx]?.automation?.[param] ?? []).map((p) => ({ ...p }))
    if (points.length < 2) {
      const track = project.tracks[idx]
      const baseline = track ? trackStaticAutomationValue(track, param) : AUTOMATION_PARAMS[param].defaultValue
      points = flatCurve(Math.max(1, project.durationMs), baseline)
    }
    const pps = geometry.pxPerSecond.value
    const hitR = 8
    let nearest = -1
    for (let i = 0; i < points.length; i++) {
      const dx = Math.abs(((points[i]!.timeMs - ms) / 1000) * pps)
      const dy = Math.abs(laneYToValue(param, worldY, top) - points[i]!.value)
      if (dx < hitR && nearest < 0) nearest = i
      void dy
    }
    if (e.altKey && nearest >= 0) {
      points = removeBreakpoint(points, nearest)
      project.setTrackAutomation(trackId, param, points)
      return true
    }
    const value = laneYToValue(param, worldY, top)
    const d = AUTOMATION_PARAMS[param]
    autoTrackId = trackId
    autoParam = param
    autoGestureId = `auto-${trackId}-${param}-${Date.now()}`
    if (nearest >= 0) {
      autoPointIndex = nearest
    } else {
      const r = insertBreakpoint(points, ms, value, { min: d.min, max: d.max })
      points = r.points
      autoPointIndex = r.index
    }
    ui.setSelectedAutomationPoint({ trackId, paramId: param, index: autoPointIndex })
    project.setTrackAutomation(trackId, param, points, { gestureId: autoGestureId })
    window.addEventListener('pointermove', onAutoMove)
    window.addEventListener('pointerup', onAutoUp)
    window.addEventListener('pointercancel', onAutoUp)
    e.preventDefault()
    return true
  }

  function onAutoMove(e: PointerEvent): void {
    if (!autoTrackId || !autoParam || !host.value) return
    const idx = project.tracks.findIndex((t) => t.id === autoTrackId)
    const slot = buildTrackRowLayout(project.tracks, makeLaneHeightOf())[idx]
    if (!slot) return
    const rect = host.value.getBoundingClientRect()
    const worldY = e.clientY - rect.top + scrollY.value
    const { top } = laneRegion(slot.top, slot.clipHeight)
    const ms = pointerToRawMsClamped(e.clientX) ?? 0
    const value = laneYToValue(autoParam, worldY, top)
    const d = AUTOMATION_PARAMS[autoParam]
    const points = (project.tracks[idx]?.automation?.[autoParam] ?? []).map((p) => ({ ...p }))
    if (autoPointIndex < 0 || autoPointIndex >= points.length) return
    const next = moveBreakpoint(points, autoPointIndex, ms, value, { min: d.min, max: d.max })
    project.setTrackAutomation(autoTrackId, autoParam, next, { gestureId: autoGestureId })
  }

  function onAutoUp(): void {
    if (autoTrackId && autoParam) {
      const idx = project.tracks.findIndex((t) => t.id === autoTrackId)
      const points = project.tracks[idx]?.automation?.[autoParam] ?? []
      project.setTrackAutomation(autoTrackId, autoParam, [...points], {
        gestureId: autoGestureId,
        gestureEnd: true
      })
    }
    autoTrackId = null
    autoParam = null
    autoPointIndex = -1
    window.removeEventListener('pointermove', onAutoMove)
    window.removeEventListener('pointerup', onAutoUp)
    window.removeEventListener('pointercancel', onAutoUp)
  }

  /** Right-click delete: if the pointer is over an interior breakpoint in an
   *  expanded lane, remove it and return true. Shared with the context menu. */
  function removeAutomationPointAt(clientX: number, clientY: number): boolean {
    if (!host.value) return false
    const trackId = pointerToTrackId(clientY)
    if (!trackId) return false
    const param = ui.automationLanes[trackId]
    if (!param) return false
    const idx = project.tracks.findIndex((t) => t.id === trackId)
    const slot = buildTrackRowLayout(project.tracks, makeLaneHeightOf())[idx]
    if (!slot) return false
    const rect = host.value.getBoundingClientRect()
    const worldY = clientY - rect.top + scrollY.value
    const { top, bottom } = laneRegion(slot.top, slot.clipHeight)
    if (worldY < top || worldY > bottom) return false
    const ms = pointerToRawMsClamped(clientX)
    if (ms === null) return false
    const points = (project.tracks[idx]?.automation?.[param] ?? []).map((p) => ({ ...p }))
    if (points.length < 2) return false
    const pps = geometry.pxPerSecond.value
    let nearest = -1
    for (let i = 0; i < points.length; i++) {
      if (Math.abs(((points[i]!.timeMs - ms) / 1000) * pps) < 8) { nearest = i; break }
    }
    if (nearest < 0) return false
    project.setTrackAutomation(trackId, param, removeBreakpoint(points, nearest))
    return true
  }

  function startClipAutoScroll(pointer: ClipDragPointer): void {
    latestClipDragPointer = pointer
    if (clipAutoScrollFrame !== null) return
    clipAutoScrollFrame = window.requestAnimationFrame(runClipAutoScroll)
  }

  function stopClipAutoScroll(): void {
    latestClipDragPointer = null
    if (clipAutoScrollFrame !== null) {
      window.cancelAnimationFrame(clipAutoScrollFrame)
      clipAutoScrollFrame = null
    }
  }

  function runClipAutoScroll(): void {
    clipAutoScrollFrame = null
    if ((draggedClipId === null && !groupDragActive) || latestClipDragPointer === null) return
    const delta = groupDragActive
      ? groupAutoScrollDelta()
      : clipAutoScrollDelta(latestClipDragPointer.clientX)
    if (delta === 0) return
    const next = Math.max(0, Math.min(maxScrollX.value, scrollX.value + delta))
    if (next === scrollX.value) return
    scrollX.value = next
    if (groupDragActive) applyGroupDrag(latestClipDragPointer)
    else applyClipDrag(latestClipDragPointer)
    onClipMoved()
    clipAutoScrollFrame = window.requestAnimationFrame(runClipAutoScroll)
  }

  function startPlayheadAutoScroll(pointer: { clientX: number; altKey: boolean }): void {
    latestPlayheadDragPointer = pointer
    if (playheadAutoScrollFrame !== null) return
    playheadAutoScrollFrame = window.requestAnimationFrame(runPlayheadAutoScroll)
  }

  // Clamp the pointer into the visible timeline before snapping, so dragging the
  // playhead past a viewport edge keeps seeking to the edge (and stays on-screen)
  // instead of stranding it — pointerToMs returns null for an out-of-bounds pointer,
  // which would otherwise freeze the seek while edge auto-scroll slid the view away.
  function playheadDragSeekMs(clientX: number, fineMode: boolean): number | null {
    const raw = pointerToRawMsClamped(clientX)
    return raw === null ? null : snapTimelineMs(raw, fineMode)
  }

  function stopPlayheadAutoScroll(): void {
    latestPlayheadDragPointer = null
    if (playheadAutoScrollFrame !== null) {
      window.cancelAnimationFrame(playheadAutoScrollFrame)
      playheadAutoScrollFrame = null
    }
  }

  // Continuously edge-scroll while the drag pointer is held near a viewport edge,
  // seeking the playhead to stay under the cursor as the view slides beneath it.
  function runPlayheadAutoScroll(): void {
    playheadAutoScrollFrame = null
    if (!isDraggingPlayhead.value || latestPlayheadDragPointer === null) return
    const delta = clipAutoScrollDelta(latestPlayheadDragPointer.clientX)
    if (delta === 0) return
    const next = Math.max(0, Math.min(maxScrollX.value, scrollX.value + delta))
    if (next === scrollX.value) return
    scrollX.value = next
    const ms = playheadDragSeekMs(latestPlayheadDragPointer.clientX, latestPlayheadDragPointer.altKey)
    if (ms !== null && ms !== transport.positionMs) seekTo(ms)
    playheadAutoScrollFrame = window.requestAnimationFrame(runPlayheadAutoScroll)
  }

  function seekTo(positionMs: number): void {
    transport.setPosition(positionMs)
    sendBridge('TRANSPORT_SEEK', { positionMs })
    onPlayheadMoved()
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return
    if (project.tracks.length === 0) return
    const a = app.value
    if (!host.value || !a) return

    // Ignore the horizontal scrollbar lane.
    const rect = host.value.getBoundingClientRect()
    const y = e.clientY - rect.top
    const bottomLimit = a.renderer.screen.height - (showScrollbar.value ? SCROLLBAR_HEIGHT : 0)
    if (y > bottomLimit) return

    // Automation lane editing claims the bottom strip of an expanded track row.
    if (tryBeginAutomationEdit(e)) return
    ui.setSelectedAutomationPoint(null)

    // Markers are dragged only while Shift is held, so a plain mouse drag always
    // moves the playhead — even directly over a marker (which would otherwise be
    // ambiguous once the playhead sits on top of one). With Shift, a marker hit
    // begins a *pending* drag: a press-and-drag moves the marker, while a plain
    // Shift-click still falls through to a playhead seek.
    const markerId = e.shiftKey ? hitTestMarker(e.clientX, e.clientY) : null
    if (markerId) {
      pendingMarkerId = markerId
      pendingMarkerStartX = e.clientX
      pendingMarkerStartY = e.clientY
      window.addEventListener('pointermove', onPendingMarkerPointerMove)
      window.addEventListener('pointerup', onPendingMarkerPointerUp)
      window.addEventListener('pointercancel', onPendingMarkerPointerUp)
      e.preventDefault()
      return
    }

    // Clip clicks seek unless movement crosses the drag threshold. A trim-edge
    // hit takes precedence so a butt-joined clip's start edge stays grabbable.
    const trimHit = hitTestTrimEdge(e.clientX, e.clientY)
    const hit = trimHit?.region ?? hitTestClip(e.clientX, e.clientY)
    if (hit) {
      const clip = project.clips[hit.clipId]
      if (clip) {
        const pointerMs = pointerToRawMs(e.clientX)
        if (pointerMs !== null) {
          // Ctrl/Cmd-click toggles this clip in the multi-selection; Shift-click extends a
          // same-track range from the anchor. Both are discrete (no drag, no seek).
          if (e.ctrlKey || e.metaKey) {
            project.toggleClipSelection(clip.id)
            project.selectTrack(clip.trackId)
            e.preventDefault()
            return
          }
          if (e.shiftKey) {
            project.selectClipRange(clip.id)
            project.selectTrack(clip.trackId)
            e.preventDefault()
            return
          }
          // Plain click. If the clip is part of a multi-selection, defer collapsing to a single
          // clip until we know this is a plain click or a drag start (see onPendingPointer*).
          const inMultiSelection = project.selectedClipIds.size > 1 && project.isClipSelected(clip.id)
          if (!inMultiSelection) {
            // Select clip and host track so paste targets what the user clicked.
            project.selectClip(clip.id)
          }
          pendingDragCollapseMulti = inMultiSelection
          project.selectTrack(clip.trackId)
          pendingDragClipId = clip.id
          pendingDragEdge = trimHit?.edge ?? null
          pendingDragStartX = e.clientX
          pendingDragStartY = e.clientY
          pendingDragStartMs = pointerMs
          pendingDragLocked = clip.locked === true
          pendingDragSuppressSeek = false
          window.addEventListener('pointermove', onPendingPointerMove)
          window.addEventListener('pointerup', onPendingPointerUp)
          window.addEventListener('pointercancel', onPendingPointerUp)
          e.preventDefault()
          return
        }
      }
    }

    // Empty track area selects the row, or clears selection in gaps.
    const rowTrackId = pointerToTrackId(e.clientY)
    if (rowTrackId !== null) {
      project.selectClip(null)
      project.selectTrack(rowTrackId)
    } else if (y >= RULER_HEIGHT) {
      project.selectClip(null)
      project.selectTrack(null)
    }

    // Ruler band and empty track rows both seek the playhead (and start a
    // playhead drag), so the user can place the playhead anywhere on the
    // timeline — e.g. to choose where a right-click ▸ Paste will land.
    const ms = pointerToMs(e.clientX, e.altKey)
    if (ms === null) return

    // Ruler band and empty track rows both seek the playhead, so the user can
    // place the playhead anywhere on the timeline — e.g. to choose where a
    // right-click ▸ Paste will land. A single click seeks in place without
    // scrolling; a press-and-drag moves it live and enables follow-scroll (set
    // in onPlayheadPointerMove once the drag threshold is crossed). Double-click
    // has no timeline action (markers are toggled at the playhead with the M key).
    playheadPointerActive = true
    playheadPointerStartX = e.clientX
    playheadPointerStartY = e.clientY
    hoverCursor.value = 'grabbing'
    window.addEventListener('pointermove', onPlayheadPointerMove)
    window.addEventListener('pointerup', onPlayheadPointerUp)
    window.addEventListener('pointercancel', onPlayheadPointerUp)
    seekTo(ms)
    e.preventDefault()
  }

  function onPlayheadPointerMove(e: PointerEvent): void {
    if (!playheadPointerActive) return
    // Promote the click into a drag on first movement past the threshold; only
    // then does follow-scroll turn on, so a plain click never auto-scrolls.
    if (!isDraggingPlayhead.value) {
      const dx = e.clientX - playheadPointerStartX
      const dy = e.clientY - playheadPointerStartY
      if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return
      isDraggingPlayhead.value = true
    }
    // Alt fine mode can toggle mid-drag. Clamp to the visible edges so dragging
    // past the viewport keeps the playhead pinned to the edge, not off-screen.
    const ms = playheadDragSeekMs(e.clientX, e.altKey)
    if (ms !== null && ms !== transport.positionMs) seekTo(ms)
    // Edge auto-scroll only when the pointer reaches a viewport edge; a drag that
    // stays within the visible timeline never scrolls the view.
    if (clipAutoScrollDelta(e.clientX) !== 0) {
      startPlayheadAutoScroll({ clientX: e.clientX, altKey: e.altKey })
    } else {
      stopPlayheadAutoScroll()
    }
  }

  function onPlayheadPointerUp(_e: PointerEvent): void {
    if (!playheadPointerActive) return
    playheadPointerActive = false
    isDraggingPlayhead.value = false
    hoverCursor.value = 'default'
    stopPlayheadAutoScroll()
    window.removeEventListener('pointermove', onPlayheadPointerMove)
    window.removeEventListener('pointerup', onPlayheadPointerUp)
    window.removeEventListener('pointercancel', onPlayheadPointerUp)
  }

  function onMarkerPointerMove(e: PointerEvent): void {
    if (draggedMarkerId === null) return
    const pointerMs = pointerToRawMsClamped(e.clientX)
    if (pointerMs === null) return
    const snap = geometry.msPerSubBeat()
    const target = Math.max(0, Math.round(pointerMs / snap) * snap)
    project.moveMarker(draggedMarkerId, target)
    onMarkerMoved()
  }

  function onMarkerPointerUp(_e: PointerEvent): void {
    if (draggedMarkerId === null) return
    log.info('drag', `marker drag end id=${draggedMarkerId}`)
    draggedMarkerId = null
    hoverCursor.value = 'default'
    window.removeEventListener('pointermove', onMarkerPointerMove)
    window.removeEventListener('pointerup', onMarkerPointerUp)
    window.removeEventListener('pointercancel', onMarkerPointerUp)
  }

  /** Detach pending-marker-drag listeners from both promotion and click paths. */
  function clearPendingMarkerDrag(): void {
    pendingMarkerId = null
    window.removeEventListener('pointermove', onPendingMarkerPointerMove)
    window.removeEventListener('pointerup', onPendingMarkerPointerUp)
    window.removeEventListener('pointercancel', onPendingMarkerPointerUp)
  }

  /** Promote a pending marker press to a real marker drag once it crosses the threshold. */
  function onPendingMarkerPointerMove(e: PointerEvent): void {
    if (pendingMarkerId === null) return
    const dx = e.clientX - pendingMarkerStartX
    const dy = e.clientY - pendingMarkerStartY
    if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return

    const markerId = pendingMarkerId
    clearPendingMarkerDrag()
    draggedMarkerId = markerId
    hoverCursor.value = 'grabbing'
    window.addEventListener('pointermove', onMarkerPointerMove)
    window.addEventListener('pointerup', onMarkerPointerUp)
    window.addEventListener('pointercancel', onMarkerPointerUp)
    onMarkerPointerMove(e)
  }

  /** Release before the drag threshold: treat the marker press as a click and seek. */
  function onPendingMarkerPointerUp(e: PointerEvent): void {
    if (pendingMarkerId === null) return
    clearPendingMarkerDrag()
    const ms = pointerToMs(e.clientX, e.altKey)
    if (ms !== null) seekTo(ms)
  }

  function applyClipDrag(pointer: ClipDragPointer): void {
    if (draggedClipId === null) return
    const clip = project.clips[draggedClipId]
    if (!clip) return
    const pointerMs = pointerToRawMsClamped(pointer.clientX)
    if (pointerMs === null) return

    const rawStartMs = pointerMs - clipGrabOffsetMs
    let target: number
    if (pointer.altKey) {
      // Alt fine drag: 1 ms resolution, no snap.
      target = Math.max(0, Math.round(rawStartMs))
    } else {
      const snap = geometry.msPerSubBeat()
      // Beat-aware snap aligns the first in-window source beat to the project grid.
      const referenceBeatOffsetMs = clipFirstBeatOffsetMs(clip, library)
      if (referenceBeatOffsetMs !== null) {
        const projectBeat = rawStartMs + referenceBeatOffsetMs
        const snappedBeat = Math.round(projectBeat / snap) * snap
        target = Math.max(0, snappedBeat - referenceBeatOffsetMs)
      } else {
        target = Math.max(0, Math.round(rawStartMs / snap) * snap)
      }
    }
    const destTrackId = pointerToTrackId(pointer.clientY) ?? clip.trackId
    project.moveClip(clip.id, target, destTrackId)
  }

  function onClipPointerMove(e: PointerEvent): void {
    const pointer = { clientX: e.clientX, clientY: e.clientY, altKey: e.altKey }
    latestClipDragPointer = pointer
    applyClipDrag(pointer)
    onClipMoved()
    if (clipAutoScrollDelta(e.clientX) !== 0) startClipAutoScroll(pointer)
    else stopClipAutoScroll()
  }

  /** Timeline-time offset to the first source-grid beat inside the clip window. */
  function onClipPointerUp(_e: PointerEvent): void {
    if (draggedClipId === null) return
    const endClip = project.clips[draggedClipId]
    log.info('drag', `clip drag end id=${draggedClipId} to=${endClip?.startMs ?? '?'}ms`)
    project.commitClipMove(draggedClipId)
    draggedClipId = null
    stopClipAutoScroll()
    window.removeEventListener('pointermove', onClipPointerMove)
    window.removeEventListener('pointerup', onClipPointerUp)
    window.removeEventListener('pointercancel', onClipPointerUp)
  }

  /** Begin a group drag: capture every selected clip's origin (start + track index) and open one
   *  undo transaction that spans the gesture so the whole move collapses to a single undo step. */
  function beginGroupDrag(anchorId: string, pointerStartMs: number): void {
    const anchor = project.clips[anchorId]
    if (!anchor) return
    groupDragOrigins = Array.from(project.selectedClipIds)
      .map((id) => {
        const c = project.clips[id]
        const trackIndex = c ? project.tracks.findIndex((t) => t.id === c.trackId) : -1
        return c && trackIndex >= 0 ? { clipId: id, startMs: c.startMs, trackIndex } : null
      })
      .filter((o): o is { clipId: string; startMs: number; trackIndex: number } => o !== null)
    groupDragAnchorId = anchorId
    groupDragAnchorOrigStartMs = anchor.startMs
    groupDragAnchorOrigTrackIndex = project.tracks.findIndex((t) => t.id === anchor.trackId)
    groupAnchorGrabOffsetMs = pointerStartMs - anchor.startMs
    groupDragDirection = 0
    groupDragActive = true
    sendBridge('EDIT_GROUP_BEGIN', { label: 'Move clips' })
    window.addEventListener('pointermove', onGroupPointerMove)
    window.addEventListener('pointerup', onGroupPointerUp)
    window.addEventListener('pointercancel', onGroupPointerUp)
  }

  /** Apply the current pointer as a uniform group delta (anchor snapped like a single-clip drag). */
  function applyGroupDrag(pointer: ClipDragPointer): void {
    if (!groupDragActive || groupDragAnchorId === null) return
    const anchor = project.clips[groupDragAnchorId]
    if (!anchor) return
    const pointerMs = pointerToRawMsClamped(pointer.clientX)
    if (pointerMs === null) return

    const rawStartMs = pointerMs - groupAnchorGrabOffsetMs
    let anchorTarget: number
    if (pointer.altKey) {
      anchorTarget = Math.max(0, Math.round(rawStartMs))
    } else {
      const snap = geometry.msPerSubBeat()
      const referenceBeatOffsetMs = clipFirstBeatOffsetMs(anchor, library)
      if (referenceBeatOffsetMs !== null) {
        const projectBeat = rawStartMs + referenceBeatOffsetMs
        anchorTarget = Math.max(0, Math.round(projectBeat / snap) * snap - referenceBeatOffsetMs)
      } else {
        anchorTarget = Math.max(0, Math.round(rawStartMs / snap) * snap)
      }
    }
    const deltaMs = anchorTarget - groupDragAnchorOrigStartMs
    if (deltaMs > 0) groupDragDirection = 1
    else if (deltaMs < 0) groupDragDirection = -1

    const destTrackId = pointerToTrackId(pointer.clientY)
    const destTrackIndex = destTrackId ? project.tracks.findIndex((t) => t.id === destTrackId) : -1
    const deltaTrackIndex =
      destTrackIndex >= 0 ? destTrackIndex - groupDragAnchorOrigTrackIndex : 0

    const clampedDeltaMs = project.clampGroupDeltaMs(groupDragOrigins, deltaMs, deltaTrackIndex)
    project.moveClipGroup(groupDragOrigins, clampedDeltaMs, deltaTrackIndex)
  }

  /** Timeline position (ms) of the group's leading edge in the current drag direction — the
   *  right end of the right-most clip when moving right, the left start of the left-most clip when
   *  moving left. Auto-scroll probes this instead of the cursor so the view follows the furthest
   *  clip. Uses live clip positions so the probe tracks the group as it moves. */
  function groupLeadingEdgeMs(): number | null {
    if (groupDragDirection === 0) return null
    let lead: number | null = null
    for (const o of groupDragOrigins) {
      const clip = project.clips[o.clipId]
      if (!clip) continue
      const edge =
        groupDragDirection > 0 ? clip.startMs + effectiveClipDurationMs(clip) : clip.startMs
      if (lead === null) lead = edge
      else lead = groupDragDirection > 0 ? Math.max(lead, edge) : Math.min(lead, edge)
    }
    return lead
  }

  /** Auto-scroll pressure for a group drag, driven by the leading clip edge rather than the cursor. */
  function groupAutoScrollDelta(): number {
    const leadMs = groupLeadingEdgeMs()
    return leadMs === null ? 0 : clipAutoScrollDeltaAtMs(leadMs)
  }

  function onGroupPointerMove(e: PointerEvent): void {
    if (!groupDragActive) return
    const pointer = { clientX: e.clientX, clientY: e.clientY, altKey: e.altKey }
    latestClipDragPointer = pointer
    applyGroupDrag(pointer)
    onClipMoved()
    if (groupAutoScrollDelta() !== 0) startClipAutoScroll(pointer)
    else stopClipAutoScroll()
  }

  function onGroupPointerUp(_e: PointerEvent): void {
    if (!groupDragActive) return
    groupDragActive = false
    groupDragAnchorId = null
    groupDragOrigins = []
    sendBridge('EDIT_GROUP_END')
    stopClipAutoScroll()
    onClipMoved()
    window.removeEventListener('pointermove', onGroupPointerMove)
    window.removeEventListener('pointerup', onGroupPointerUp)
    window.removeEventListener('pointercancel', onGroupPointerUp)
  }

  /** Detach pending-drag listeners from both promotion and click paths. */
  function clearPendingDrag(): void {
    pendingDragClipId = null
    pendingDragEdge = null
    pendingDragLocked = false
    pendingDragCollapseMulti = false
    window.removeEventListener('pointermove', onPendingPointerMove)
    window.removeEventListener('pointerup', onPendingPointerUp)
    window.removeEventListener('pointercancel', onPendingPointerUp)
  }

  function onPendingPointerMove(e: PointerEvent): void {
    if (pendingDragClipId === null) return
    const dx = e.clientX - pendingDragStartX
    const dy = e.clientY - pendingDragStartY
    if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return

    // A body drag on a clip that's part of a multi-selection moves the whole group (Phase 2),
    // unless any selected clip is locked (then fall back to a single-clip move by collapsing).
    if (
      pendingDragCollapseMulti &&
      pendingDragEdge === null &&
      pendingDragClipId !== null &&
      project.selectedClipIds.size > 1 &&
      !Array.from(project.selectedClipIds).some((id) => project.clips[id]?.locked)
    ) {
      const anchorId = pendingDragClipId
      const startMs = pendingDragStartMs
      clearPendingDrag()
      beginGroupDrag(anchorId, startMs)
      onGroupPointerMove(e)
      return
    }

    // A drag on a clip that was part of a multi-selection collapses to just that clip (no group
    // move — a trim, or a group containing a locked clip), so the gesture moves a single clip.
    if (pendingDragCollapseMulti) project.selectClip(pendingDragClipId)

    if (pendingDragLocked) {
      // Locked drag crossed threshold: refuse drag and suppress release seek.
      pendingDragSuppressSeek = true
      return
    }

    const clip = project.clips[pendingDragClipId]
    const edge = pendingDragEdge
    const startMs = pendingDragStartMs
    clearPendingDrag()
    if (!clip) return

    if (edge) {
      // Linked library-clip instances never reach trim mode.
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
      onTrimPointerMove(e)
      return
    }

    draggedClipId = clip.id
    clipGrabOffsetMs = startMs - clip.startMs
    log.info('drag', `clip drag start id=${clip.id} from=${clip.startMs}ms`)
    window.addEventListener('pointermove', onClipPointerMove)
    window.addEventListener('pointerup', onClipPointerUp)
    window.addEventListener('pointercancel', onClipPointerUp)
    onClipPointerMove(e)
  }

  /** Release before drag threshold: seek to the clicked clip position. */
  function onPendingPointerUp(e: PointerEvent): void {
    if (pendingDragClipId === null) return
    const suppressSeek = pendingDragSuppressSeek
    // A plain click (no drag) on a clip that was part of a multi-selection collapses to just
    // that clip.
    if (pendingDragCollapseMulti) project.selectClip(pendingDragClipId)
    clearPendingDrag()
    if (suppressSeek) return
    const ms = pointerToMs(e.clientX, e.altKey)
    if (ms !== null) seekTo(ms)
  }

  function onTrimPointerMove(e: PointerEvent): void {
    if (trimClipId === null || trimEdge === null) return
    const clip = project.clips[trimClipId]
    if (!clip) return
    const pointerMs = pointerToRawMs(e.clientX)
    if (pointerMs === null) return
    // Edge trims snap in timeline time, then write source-time fields through warp ratio.
    const ratio = isClipTempoWarpActive(clip) ? effectiveClipTempoRatio(clip) : 1

    if (trimEdge === 'left') {
      const rawLeftMs = trimOrigStartMs + (pointerMs - trimPointerStartMs)
      const targetLeftMs = snapTimelineMs(rawLeftMs, e.altKey)
      const deltaTimelineMs = targetLeftMs - trimOrigStartMs
      const deltaSourceMs = Math.round(deltaTimelineMs * ratio)
      // Left trim moves `startMs` in timeline time and adjusts `inMs`/`durationMs` in source time.
      const minDeltaSrc = -trimOrigInMs
      const maxDeltaSrc = trimOrigDurationMs - MIN_CLIP_MS
      const clampedSrc = Math.max(minDeltaSrc, Math.min(maxDeltaSrc, deltaSourceMs))
      const clampedTimeline = ratio > 0 ? Math.round(clampedSrc / ratio) : clampedSrc
      const newStartMs = trimOrigStartMs + clampedTimeline
      const newInMs = trimOrigInMs + clampedSrc
      const newDurationMs = trimOrigDurationMs - clampedSrc
      if (
        newStartMs === clip.startMs &&
        newInMs === clip.inMs &&
        newDurationMs === clip.durationMs
      ) {
        return
      }
      project.trimClip(clip.id, newStartMs, newInMs, newDurationMs)
    } else {
      const origRightMs = trimOrigStartMs + (trimOrigDurationMs / Math.max(1e-9, ratio))
      const rawRightMs = origRightMs + (pointerMs - trimPointerStartMs)
      const targetRightMs = snapTimelineMs(rawRightMs, e.altKey)
      const deltaTimelineMs = targetRightMs - origRightMs
      const deltaSourceMs = Math.round(deltaTimelineMs * ratio)
      // Right trim changes only source-time `durationMs`.
      const minDeltaSrc = MIN_CLIP_MS - trimOrigDurationMs
      const maxDeltaSrc = trimSourceDurationMs - (trimOrigInMs + trimOrigDurationMs)
      const clampedSrc = Math.max(minDeltaSrc, Math.min(maxDeltaSrc, deltaSourceMs))
      const newDurationMs = trimOrigDurationMs + clampedSrc
      if (newDurationMs === clip.durationMs) return
      project.trimClip(clip.id, trimOrigStartMs, trimOrigInMs, newDurationMs)
    }
    onClipMoved()
  }

  function onTrimPointerUp(e: PointerEvent): void {
    if (trimClipId === null) return
    const finishedClipId = trimClipId
    const finishedEdge = trimEdge
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
    // Completed edge drags may create crossfades; cancelled drags must not.
    if (e.type === 'pointerup' && finishedEdge !== null) {
      project.maybeCreateTransitionAfterTrim(finishedClipId, finishedEdge)
    }
  }

  /** Update hover cursor, but keep it stable during active drags. */
  function onHostPointerMove(e: PointerEvent): void {
    if (
      draggedClipId !== null ||
      groupDragActive ||
      trimClipId !== null ||
      draggedMarkerId !== null ||
      isDraggingPlayhead.value
    ) {
      return
    }
    // Markers are draggable only with Shift held, so show the grab cursor for a
    // marker only then; without Shift the pointer falls through to the normal
    // ruler/playhead cursor because a plain drag there moves the playhead.
    if (e.shiftKey && hitTestMarker(e.clientX, e.clientY)) {
      if (hoverCursor.value !== 'grab') hoverCursor.value = 'grab'
      return
    }
    const trimHit = hitTestTrimEdge(e.clientX, e.clientY)
    if (trimHit) {
      if (hoverCursor.value !== 'ew-resize') hoverCursor.value = 'ew-resize'
      updateAutomationHoverTip(e.clientX, e.clientY)
      return
    }
    // The playhead is draggable only where a pointer-down starts a playhead
    // drag — the ruler and empty track areas, not over a clip (clicking a clip
    // seeks/moves it instead). Signal that with a grab (open-hand) cursor.
    if (hitTestPlayhead(e.clientX, e.clientY) && !hitTestClip(e.clientX, e.clientY)) {
      if (hoverCursor.value !== 'grab') hoverCursor.value = 'grab'
      updateAutomationHoverTip(e.clientX, e.clientY)
      return
    }
    if (hoverCursor.value !== 'default') hoverCursor.value = 'default'
    updateAutomationHoverTip(e.clientX, e.clientY)
  }

  /** Show a value readout when hovering a breakpoint in an expanded lane. */
  function updateAutomationHoverTip(clientX: number, clientY: number): void {
    if (!host.value) { ui.automationHoverTip = null; return }
    const trackId = pointerToTrackId(clientY)
    const param = trackId ? ui.automationLanes[trackId] : undefined
    if (!trackId || !param) { ui.automationHoverTip = null; return }
    const idx = project.tracks.findIndex((t) => t.id === trackId)
    const slot = buildTrackRowLayout(project.tracks, makeLaneHeightOf())[idx]
    const pts = project.tracks[idx]?.automation?.[param]
    if (!slot || !pts || pts.length < 2) { ui.automationHoverTip = null; return }
    const { top, bottom } = laneRegion(slot.top, slot.clipHeight)
    const rect = host.value.getBoundingClientRect()
    const worldY = clientY - rect.top + scrollY.value
    if (worldY < top || worldY > bottom) { ui.automationHoverTip = null; return }
    const ms = pointerToRawMsClamped(clientX) ?? 0
    const pps = geometry.pxPerSecond.value
    const hit = pts.find((p) => Math.abs(((p.timeMs - ms) / 1000) * pps) < 8)
    ui.automationHoverTip = hit
      ? { x: clientX, y: clientY, text: AUTOMATION_PARAMS[param].format(hit.value) }
      : null
  }

  function onHostPointerLeave(): void {
    ui.automationHoverTip = null
    // Keep the active-drag cursor (e.g. the playhead grab hand): the pointer can cross the host
    // boundary as the timeline auto-scrolls, but the drag continues on window listeners, so the
    // cursor must not snap back to the arrow mid-drag.
    if (
      draggedClipId !== null ||
      groupDragActive ||
      trimClipId !== null ||
      draggedMarkerId !== null ||
      isDraggingPlayhead.value
    ) {
      return
    }
    if (hoverCursor.value !== 'default') hoverCursor.value = 'default'
  }

  // Watch the host ref because template refs may be populated asynchronously.
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
    window.removeEventListener('pointermove', onMarkerPointerMove)
    window.removeEventListener('pointerup', onMarkerPointerUp)
    window.removeEventListener('pointercancel', onMarkerPointerUp)
    window.removeEventListener('pointermove', onPendingMarkerPointerMove)
    window.removeEventListener('pointerup', onPendingMarkerPointerUp)
    window.removeEventListener('pointercancel', onPendingMarkerPointerUp)
    window.removeEventListener('pointermove', onClipPointerMove)
    window.removeEventListener('pointerup', onClipPointerUp)
    window.removeEventListener('pointercancel', onClipPointerUp)
    window.removeEventListener('pointermove', onGroupPointerMove)
    window.removeEventListener('pointerup', onGroupPointerUp)
    window.removeEventListener('pointercancel', onGroupPointerUp)
    window.removeEventListener('pointermove', onTrimPointerMove)
    window.removeEventListener('pointerup', onTrimPointerUp)
    window.removeEventListener('pointercancel', onTrimPointerUp)
    window.removeEventListener('pointermove', onPendingPointerMove)
    window.removeEventListener('pointerup', onPendingPointerUp)
    window.removeEventListener('pointercancel', onPendingPointerUp)
    stopClipAutoScroll()
    stopPlayheadAutoScroll()
  })

  return { isDraggingPlayhead, hoverCursor, removeAutomationPointAt }
}
