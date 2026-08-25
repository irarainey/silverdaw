// Drag-and-drop landing zone for library items on the timeline.
// `dragover` uses the store-tracked item id because DataTransfer hides custom MIME data until drop.

import { onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { Application } from 'pixi.js'
import { libraryItemDisplayName, libraryItemIsSimple, useLibraryStore, type LibraryItem } from '@/stores/libraryStore'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { useUiStore } from '@/stores/uiStore'
import { log } from '@/lib/log'
import { runInUndoGroup } from '@/lib/undo/undoGroup'
import { effectiveDurationMs, effectiveTempoRatio, isWarpActive, shouldAutoWarpOnDrop } from '@/lib/warp'
import { firstSourceBeatMsAtOrAfter, resolveSourceBeatGrid } from '@/lib/clip/sourceBeatGrid'
import { startMsForAlignedBeat } from '@/lib/musicTime'
import { libraryItemSourceBpm } from '@/stores/libraryItemHelpers'
import {
  RULER_HEIGHT,
  SCROLLBAR_HEIGHT,
  SCROLLBAR_WIDTH
} from './constants'
import { edgeAutoScrollDelta } from './edgeAutoScroll'
import { trackIndexAtWorldY, tracksContentHeight } from './trackLayout'
import { makeLaneHeightOf } from '@/lib/automation/laneLayout'
import type { GridGeometry } from './useGridGeometry'

export interface DropPreview {
  trackIndex: number
  startMs: number
  /** Null when the drag carries no length yet, which is every drop of a file that
   *  is not in the library. The ghost then runs to the edge of the view rather than
   *  changing shape: a clip that long has its end off-screen either way, so it reads
   *  exactly like any other drop. */
  durationMs: number | null
  /** False if the drop would overlap an existing clip on the same track. */
  valid: boolean
  /** True when the pointer is in the empty area below the tracks: dropping here
   *  creates a new track for the clip. `trackIndex` is -1 in this mode. */
  createNewTrack?: boolean
}

export interface DropZone {
  /** Current ghost preview (null when no drag is over the canvas). */
  dropPreview: Ref<DropPreview | null>
  /** Resolve a pointer position before an external file is imported. */
  resolveDropTarget: (clientX: number, clientY: number) => TimelineDropTarget | null
  /** Convert a raw timeline position to a beat-aware clip start for an imported item. */
  startMsForItem: (rawMs: number, item: LibraryItem) => number
  /** Drive the same ghost for a drag that is not a library item yet (a file being
   *  imported). `durationMs` is null when the length is not known until import. */
  previewExternalDrop: (
    clientX: number,
    clientY: number,
    durationMs: number | null
  ) => 'copy' | 'none'
  /** End an external drag, clearing its ghost and any edge auto-scroll. */
  clearExternalDrop: () => void
}

export type TimelineDropTarget =
  | { createNewTrack: false; trackIndex: number; rawMs: number }
  | { createNewTrack: true; rawMs: number }

export interface DropZoneOptions {
  host: Ref<HTMLElement | null>
  app: Readonly<Ref<Application | null>>
  scrollX: Ref<number>
  scrollY: Ref<number>
  maxScrollX: ComputedRef<number>
  showScrollbar: ComputedRef<boolean>
  geometry: GridGeometry
  /** Fires when the ghost preview changes so the host can repaint. */
  onPreviewChanged: () => void
}

const MIME_LIBRARY_ITEM = 'application/x-silverdaw-library-item'

export function useDropZone(opts: DropZoneOptions): DropZone {
  const library = useLibraryStore()
  const project = useProjectStore()
  const transport = useTransportStore()
  const { host, app, scrollX, scrollY, maxScrollX, showScrollbar, geometry, onPreviewChanged } = opts

  const dropPreview = ref<DropPreview | null>(null)

  // Latest dragover pointer, so the edge auto-scroll loop (which runs while the pointer is
  // held still near an edge, when no dragover events fire) can keep re-probing the position.
  let lastDragClientX = 0
  let lastDragClientY = 0
  let autoScrollFrame: number | null = null

  function isLibraryDrag(): boolean {
    return library.currentDragItemId !== null
  }

  // A file dragged in from Explorer or the Files tab drives the same ghost. Its length
  // is unknown until it is imported, which the preview reports as a null duration.
  let externalDragActive = false
  let externalDragDurationMs: number | null = null

  function isDragActive(): boolean {
    return isLibraryDrag() || externalDragActive
  }

  /** The item currently being dragged from the library (from the live store id). */
  function currentDragItem(): LibraryItem | null {
    const liveId = library.currentDragItemId
    return liveId ? library.getItem(liveId) : null
  }

  /** Resolve the dragged item from MIME on drop, otherwise from the live store id. */
  function resolveDragItem(e: DragEvent, viaGetData = false): LibraryItem | null {
    if (viaGetData) {
      const id = e.dataTransfer?.getData(MIME_LIBRARY_ITEM) ?? ''
      if (id) {
        const item = library.getItem(id)
        if (item) return item
      }
    }
    return currentDragItem()
  }

  /** Map a pointer to either a valid track drop or, when it is in the empty area below the
   *  tracks (or the project has no tracks), a new-track drop. Returns null when the pointer
   *  is outside the droppable content area or in an inter-row gap. */
  function resolveDropTarget(clientX: number, clientY: number): TimelineDropTarget | null {
    const a = app.value
    if (!host.value || !a) return null
    const rect = host.value.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top

    const rightEdge = a.renderer.screen.width - SCROLLBAR_WIDTH
    if (x < geometry.headerWidth() || x > rightEdge) return null
    if (y < RULER_HEIGHT) return null
    const bottomLimit = a.renderer.screen.height - (showScrollbar.value ? SCROLLBAR_HEIGHT : 0)
    if (y > bottomLimit) return null

    const trackLocalX = x - geometry.headerWidth()
    const rawMs = ((scrollX.value + trackLocalX) / geometry.pxPerSecond.value) * 1000

    const worldY = y + scrollY.value
    const hit = trackIndexAtWorldY(project.tracks, worldY, makeLaneHeightOf())
    if (hit) return { createNewTrack: false, trackIndex: hit.index, rawMs }

    // No track under the pointer. If it sits below the last row (or the project has no tracks
    // yet), offer to make a new track; an inter-row gap resolves to nothing.
    const tracksBottom = RULER_HEIGHT + tracksContentHeight(project.tracks, makeLaneHeightOf())
    if (worldY >= tracksBottom) return { createNewTrack: true, rawMs }
    return null
  }

  // Beat-aware items align their first source beat, rather than their left edge,
  // to the grid; a Free grid leaves the drop exactly where it landed.
  function startMsForItem(rawMs: number, item: LibraryItem): number {
    const referenceBeatOffsetMs = firstSourceBeatOffsetMs(item)
    if (referenceBeatOffsetMs === null) return geometry.snapTimelineMs(rawMs, false)
    return startMsForAlignedBeat(
      geometry.snapTimelineMs(rawMs + referenceBeatOffsetMs, false),
      referenceBeatOffsetMs,
      transport.bpm,
      useUiStore().snapGrid
    )
  }

  type ResolvedDrop =
    | { createNewTrack: false; trackIndex: number; startMs: number }
    | { createNewTrack: true; startMs: number }

  function resolveDrop(clientX: number, clientY: number, item: LibraryItem): ResolvedDrop | null {
    const target = resolveDropTarget(clientX, clientY)
    if (!target) return null
    const startMs = startMsForItem(target.rawMs, item)
    return target.createNewTrack
      ? { createNewTrack: true, startMs }
      : { createNewTrack: false, trackIndex: target.trackIndex, startMs }
  }

  function firstSourceBeatOffsetMs(item: LibraryItem): number | null {
    const grid = resolveSourceBeatGrid(item, library.byId)
    if (!grid) return null
    const firstBeatMs = firstSourceBeatMsAtOrAfter(grid, 0)
    if (firstBeatMs > item.durationMs) return null
    // Project the first beat into timeline time using the warp that will apply on
    // drop. Snap, ghost preview and placement all resolve the original BPM through
    // the one shared resolver — when they disagreed, a snap computed against a
    // ratio the drop never applied landed the first beat off the grid by exactly
    // that ratio.
    const ui = useUiStore()
    const snapSourceBpm = libraryItemSourceBpm(item, library.byId)
    const willWarpForSnap =
      item.warpEnabled === true ||
      shouldAutoWarpOnDrop({
        preferenceEnabled: ui.matchProjectTempoOnDrop,
        projectBpmSeeded: transport.bpmSeeded,
        sourceKind: item.kind,
        sourceIsSimple: libraryItemIsSimple(item, library.byId),
        sourceBpm: snapSourceBpm,
        projectBpm: transport.bpm,
        variableTempo: item.variableTempo,
        sourceDurationMs: item.durationMs
      })
    const warpInputs = {
      warpEnabled: willWarpForSnap,
      tempoRatio: item.tempoRatio,
      sourceBpm: snapSourceBpm,
      projectBpm: transport.bpm,
      nativeDurationMs: item.durationMs
    }
    const ratio = isWarpActive(warpInputs) ? effectiveTempoRatio(warpInputs) : 1
    return firstBeatMs / ratio
  }

  function clearPreview(): void {
    commitPreview(null)
  }

  /** Publish a preview, skipping the repaint when nothing about it changed. */
  function commitPreview(next: DropPreview | null): void {
    const cur = dropPreview.value
    if (cur === null && next === null) return
    if (
      cur !== null &&
      next !== null &&
      cur.trackIndex === next.trackIndex &&
      cur.startMs === next.startMs &&
      cur.durationMs === next.durationMs &&
      cur.valid === next.valid &&
      (cur.createNewTrack ?? false) === (next.createNewTrack ?? false)
    ) {
      return
    }
    dropPreview.value = next
    onPreviewChanged()
  }

  function onDragEnter(e: DragEvent): void {
    if (!isLibraryDrag()) return
    e.preventDefault()
  }

  /** Recompute the ghost preview for a pointer position and return the drop effect the
   *  cursor should show. Split out of `onDragOver` so the edge auto-scroll loop can refresh
   *  the ghost while the timeline slides under a stationary pointer. */
  function refreshPreview(clientX: number, clientY: number): 'copy' | 'none' {
    const item = currentDragItem()
    const target = item ? resolveDrop(clientX, clientY, item) : null
    if (!target || !item) {
      clearPreview()
      return 'none'
    }

    // Mirror drop-time warp so the ghost width matches the landed clip.
    const ui = useUiStore()
    // Simple samples skip auto-warp on drop, so the preview must too.
    const dropIsSample = libraryItemIsSimple(item, library.byId)
    const previewSourceBpm = libraryItemSourceBpm(item, library.byId)
    const willWarp =
      (item.warpEnabled === true) ||
      shouldAutoWarpOnDrop({
        preferenceEnabled: ui.matchProjectTempoOnDrop,
        projectBpmSeeded: transport.bpmSeeded,
        sourceKind: item.kind,
        sourceIsSimple: dropIsSample,
        sourceBpm: previewSourceBpm,
        projectBpm: transport.bpm,
        variableTempo: item.variableTempo,
        sourceDurationMs: item.durationMs
      })
    const effectiveDurMs = willWarp
      ? effectiveDurationMs(item.durationMs, {
          warpEnabled: true,
          tempoRatio: item.tempoRatio,
          sourceBpm: previewSourceBpm,
          projectBpm: transport.bpm,
          nativeDurationMs: item.durationMs
        })
      : item.durationMs

    // A new track is always empty, so a new-track drop can never overlap.
    const overlaps = target.createNewTrack
      ? false
      : project.wouldClipOverlap(
          project.tracks[target.trackIndex]!.id,
          target.startMs,
          effectiveDurMs
        )

    // Avoid repainting the Pixi ghost on unchanged dragover events.
    const next: DropPreview = {
      trackIndex: target.createNewTrack ? -1 : target.trackIndex,
      startMs: target.startMs,
      durationMs: effectiveDurMs,
      valid: !overlaps,
      createNewTrack: target.createNewTrack
    }
    commitPreview(next)
    return overlaps ? 'none' : 'copy'
  }

  /** The same ghost for a file drag. There is no library item to read a beat grid or
   *  drop-time warp from, so the start is plainly snapped and the length is whatever
   *  the drag could tell us — often nothing until the file is imported. */
  function refreshExternalPreview(clientX: number, clientY: number): 'copy' | 'none' {
    const target = resolveDropTarget(clientX, clientY)
    if (!target) {
      clearPreview()
      return 'none'
    }
    const startMs = geometry.snapTimelineMs(target.rawMs, false)
    const durationMs = externalDragDurationMs
    // A new track is always empty, and an unknown length cannot be collision-tested.
    const overlaps =
      target.createNewTrack || durationMs === null
        ? false
        : project.wouldClipOverlap(project.tracks[target.trackIndex]!.id, startMs, durationMs)
    commitPreview({
      trackIndex: target.createNewTrack ? -1 : target.trackIndex,
      startMs,
      durationMs,
      valid: !overlaps,
      createNewTrack: target.createNewTrack
    })
    return overlaps ? 'none' : 'copy'
  }

  function previewExternalDrop(
    clientX: number,
    clientY: number,
    durationMs: number | null
  ): 'copy' | 'none' {
    externalDragActive = true
    externalDragDurationMs = durationMs
    lastDragClientX = clientX
    lastDragClientY = clientY
    const effect = refreshExternalPreview(clientX, clientY)
    if (edgeDelta(clientX) !== 0) startAutoScroll()
    else stopAutoScroll()
    return effect
  }

  function clearExternalDrop(): void {
    externalDragActive = false
    externalDragDurationMs = null
    stopAutoScroll()
    clearPreview()
  }

  /** Edge auto-scroll pressure for a client x (0 in the clear middle, non-zero near an edge). */
  function edgeDelta(clientX: number): number {
    const a = app.value
    if (!host.value || !a || maxScrollX.value <= 0) return 0
    const rect = host.value.getBoundingClientRect()
    const leftEdge = geometry.headerWidth()
    const rightEdge = a.renderer.screen.width - SCROLLBAR_WIDTH
    return edgeAutoScrollDelta(clientX - rect.left, leftEdge, rightEdge)
  }

  function stopAutoScroll(): void {
    if (autoScrollFrame !== null) {
      window.cancelAnimationFrame(autoScrollFrame)
      autoScrollFrame = null
    }
  }

  function startAutoScroll(): void {
    if (autoScrollFrame === null) autoScrollFrame = window.requestAnimationFrame(runAutoScroll)
  }

  // While the drag pointer hovers near a horizontal edge, keep scrolling the timeline so a
  // clip can be dropped at the very start (or anywhere), not just within the current view.
  // dragover doesn't fire for a stationary pointer, so this rAF loop drives it; the ghost is
  // refreshed each step because the timeline moves under the still pointer.
  function runAutoScroll(): void {
    autoScrollFrame = null
    if (!isDragActive()) return
    const delta = edgeDelta(lastDragClientX)
    if (delta === 0) return
    const nextScroll = Math.max(0, Math.min(maxScrollX.value, scrollX.value + delta))
    if (nextScroll === scrollX.value) return // clamped at the start/end — nothing more to scroll
    scrollX.value = nextScroll
    if (externalDragActive) refreshExternalPreview(lastDragClientX, lastDragClientY)
    else refreshPreview(lastDragClientX, lastDragClientY)
    autoScrollFrame = window.requestAnimationFrame(runAutoScroll)
  }

  function onDragOver(e: DragEvent): void {
    if (!isLibraryDrag()) return
    e.preventDefault()
    if (!e.dataTransfer) return

    lastDragClientX = e.clientX
    lastDragClientY = e.clientY
    e.dataTransfer.dropEffect = refreshPreview(e.clientX, e.clientY)

    if (edgeDelta(e.clientX) !== 0) startAutoScroll()
    else stopAutoScroll()
  }

  function onDragLeave(e: DragEvent): void {
    if (!isLibraryDrag()) return
    // Ignore child-to-child dragleave; clear only when leaving the host.
    const related = e.relatedTarget as Node | null
    if (related && host.value && host.value.contains(related)) return
    clearPreview()
    stopAutoScroll()
  }

  function onDrop(e: DragEvent): void {
    if (!isLibraryDrag()) return
    e.preventDefault()
    stopAutoScroll()

    // Clear the ghost before the drop repaint.
    dropPreview.value = null

    // On drop, prefer MIME data and fall back to the store id.
    const item = resolveDragItem(e, true)
    if (!item) {
      onPreviewChanged()
      return
    }

    const target = resolveDrop(e.clientX, e.clientY, item)
    if (!target) {
      onPreviewChanged()
      return
    }

    const placement = { ...item, fileName: libraryItemDisplayName(item) }
    if (target.createNewTrack) {
      // Create the track and place the clip as ONE undo step so Ctrl+Z removes both.
      runInUndoGroup('Add clip to new track', () => {
        const trackId = project.addTrack()
        project.addClipFromLibrary(trackId, placement, target.startMs)
      })
      log.info('dropzone', `drop new-track startMs=${target.startMs} item=${item.id}`)
      onPreviewChanged()
      return
    }

    project.addClipFromLibrary(
      project.tracks[target.trackIndex]!.id,
      placement,
      target.startMs
    )
    log.info('dropzone', `drop trackIndex=${target.trackIndex} startMs=${target.startMs} item=${item.id}`)
    onPreviewChanged()
  }

  const stopHostWatch = watch(
    host,
    (el, prev) => {
      if (prev) {
        prev.removeEventListener('dragenter', onDragEnter)
        prev.removeEventListener('dragover', onDragOver)
        prev.removeEventListener('dragleave', onDragLeave)
        prev.removeEventListener('drop', onDrop)
      }
      if (el) {
        el.addEventListener('dragenter', onDragEnter)
        el.addEventListener('dragover', onDragOver)
        el.addEventListener('dragleave', onDragLeave)
        el.addEventListener('drop', onDrop)
      }
    },
    { immediate: true }
  )

  onBeforeUnmount(() => {
    stopHostWatch()
    stopAutoScroll()
    const el = host.value
    if (el) {
      el.removeEventListener('dragenter', onDragEnter)
      el.removeEventListener('dragover', onDragOver)
      el.removeEventListener('dragleave', onDragLeave)
      el.removeEventListener('drop', onDrop)
    }
  })

  return { dropPreview, resolveDropTarget, startMsForItem, previewExternalDrop, clearExternalDrop }
}
