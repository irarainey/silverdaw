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
import { effectiveTempoRatio, isWarpActive } from '@/lib/warp'
import {
  RULER_HEIGHT,
  SCROLLBAR_HEIGHT,
  SCROLLBAR_WIDTH
} from './constants'
import { trackIndexAtWorldY, tracksContentHeight } from './trackLayout'
import { makeLaneHeightOf } from '@/lib/automation/laneLayout'
import type { GridGeometry } from './useGridGeometry'

export interface DropPreview {
  trackIndex: number
  startMs: number
  durationMs: number
  /** False if the drop would overlap an existing clip on the same track. */
  valid: boolean
  /** True when the pointer is in the empty area below the tracks: dropping here
   *  creates a new track for the clip. `trackIndex` is -1 in this mode. */
  createNewTrack?: boolean
}

export interface DropZone {
  /** Current ghost preview (null when no library drag is over the canvas). */
  dropPreview: Ref<DropPreview | null>
}

export interface DropZoneOptions {
  host: Ref<HTMLElement | null>
  app: Readonly<Ref<Application | null>>
  scrollX: Ref<number>
  scrollY: Ref<number>
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
  const { host, app, scrollX, scrollY, showScrollbar, geometry, onPreviewChanged } = opts

  const dropPreview = ref<DropPreview | null>(null)

  function isLibraryDrag(): boolean {
    return library.currentDragItemId !== null
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
    const liveId = library.currentDragItemId
    return liveId ? library.getItem(liveId) : null
  }

  /** Map a pointer to either a valid track drop or, when it is in the empty area below the
   *  tracks (or the project has no tracks), a new-track drop. Returns null when the pointer
   *  is outside the droppable content area or in an inter-row gap. `startMs` is beat-aware
   *  snapped for both. */
  type ResolvedDrop =
    | { createNewTrack: false; trackIndex: number; startMs: number }
    | { createNewTrack: true; startMs: number }

  function resolveDrop(clientX: number, clientY: number, item: LibraryItem): ResolvedDrop | null {
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
    const snap = geometry.msPerSubBeat()
    const referenceBeatOffsetMs = firstSourceBeatOffsetMs(item)
    const startMs =
      referenceBeatOffsetMs !== null
        ? Math.max(0, Math.round((rawMs + referenceBeatOffsetMs) / snap) * snap - referenceBeatOffsetMs)
        : Math.max(0, Math.round(rawMs / snap) * snap)

    const worldY = y + scrollY.value
    const hit = trackIndexAtWorldY(project.tracks, worldY, makeLaneHeightOf())
    if (hit) return { createNewTrack: false, trackIndex: hit.index, startMs }

    // No track under the pointer. If it sits below the last row (or the project has no tracks
    // yet), offer to make a new track; an inter-row gap resolves to nothing.
    const tracksBottom = RULER_HEIGHT + tracksContentHeight(project.tracks, makeLaneHeightOf())
    if (worldY >= tracksBottom) return { createNewTrack: true, startMs }
    return null
  }

  function firstSourceBeatOffsetMs(item: LibraryItem): number | null {
    const beats = item.beats
    const sourceBpm = item.bpm
    const anchorSec = item.beatAnchorSec ?? beats?.[0]
    if (!beats || beats.length === 0 || !sourceBpm || sourceBpm <= 0 || anchorSec === undefined) {
      return null
    }
    const beatSpacingMs = (60 / sourceBpm) * 1000
    if (beatSpacingMs <= 0) return null
    const universalAnchorMs = anchorSec * 1000
    let firstBeatMs = universalAnchorMs + Math.ceil(-universalAnchorMs / beatSpacingMs) * beatSpacingMs
    while (firstBeatMs < 0) firstBeatMs += beatSpacingMs
    if (firstBeatMs > item.durationMs) return null
    // Project the first beat into timeline time using the warp that will apply on drop.
    const ui = useUiStore()
    const projectHasOtherClips = Object.keys(project.clips).length > 0
    const willWarpForSnap =
      item.warpEnabled === true ||
      (ui.matchProjectTempoOnDrop &&
        projectHasOtherClips &&
        item.kind !== 'clip' && item.variableTempo !== true)
    const ratio = isWarpActive({
      warpEnabled: willWarpForSnap,
      tempoRatio: item.tempoRatio,
      sourceBpm,
      projectBpm: transport.bpm
    })
      ? effectiveTempoRatio({
          tempoRatio: item.tempoRatio,
          sourceBpm,
          projectBpm: transport.bpm
        })
      : 1
    return firstBeatMs / ratio
  }

  function clearPreview(): void {
    if (dropPreview.value !== null) {
      dropPreview.value = null
      onPreviewChanged()
    }
  }

  function onDragEnter(e: DragEvent): void {
    if (!isLibraryDrag()) return
    e.preventDefault()
  }

  function onDragOver(e: DragEvent): void {
    if (!isLibraryDrag()) return
    e.preventDefault()
    if (!e.dataTransfer) return

    const item = resolveDragItem(e)
    const target = item ? resolveDrop(e.clientX, e.clientY, item) : null
    if (!target || !item) {
      e.dataTransfer.dropEffect = 'none'
      clearPreview()
      return
    }

    // Mirror drop-time warp so the ghost width matches the landed clip.
    const ui = useUiStore()
    const projectHasOtherClips = Object.keys(project.clips).length > 0
    // Samples skip auto-warp on drop, so the preview must too.
    const dropIsSample = libraryItemIsSimple(item, library.byId)
    const willWarp =
      (item.warpEnabled === true) ||
      (ui.matchProjectTempoOnDrop &&
        projectHasOtherClips &&
        !dropIsSample &&
        item.kind !== 'clip' && item.variableTempo !== true &&
        typeof item.bpm === 'number' && item.bpm > 0 && transport.bpm > 0)
    const previewRatio = willWarp
      ? effectiveTempoRatio({
          tempoRatio: item.tempoRatio,
          sourceBpm: item.bpm,
          projectBpm: transport.bpm
        })
      : 1
    const effectiveDurMs =
      previewRatio > 0 && Math.abs(previewRatio - 1) > 1e-4
        ? item.durationMs / previewRatio
        : item.durationMs

    // A new track is always empty, so a new-track drop can never overlap.
    const overlaps = target.createNewTrack
      ? false
      : project.wouldClipOverlap(
          project.tracks[target.trackIndex]!.id,
          target.startMs,
          effectiveDurMs
        )
    e.dataTransfer.dropEffect = overlaps ? 'none' : 'copy'

    // Avoid repainting the Pixi ghost on unchanged dragover events.
    const next: DropPreview = {
      trackIndex: target.createNewTrack ? -1 : target.trackIndex,
      startMs: target.startMs,
      durationMs: effectiveDurMs,
      valid: !overlaps,
      createNewTrack: target.createNewTrack
    }
    const cur = dropPreview.value
    if (
      cur === null ||
      cur.trackIndex !== next.trackIndex ||
      cur.startMs !== next.startMs ||
      cur.durationMs !== next.durationMs ||
      cur.valid !== next.valid ||
      (cur.createNewTrack ?? false) !== (next.createNewTrack ?? false)
    ) {
      dropPreview.value = next
      onPreviewChanged()
    }
  }

  function onDragLeave(e: DragEvent): void {
    if (!isLibraryDrag()) return
    // Ignore child-to-child dragleave; clear only when leaving the host.
    const related = e.relatedTarget as Node | null
    if (related && host.value && host.value.contains(related)) return
    clearPreview()
  }

  function onDrop(e: DragEvent): void {
    if (!isLibraryDrag()) return
    e.preventDefault()

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
    const el = host.value
    if (el) {
      el.removeEventListener('dragenter', onDragEnter)
      el.removeEventListener('dragover', onDragOver)
      el.removeEventListener('dragleave', onDragLeave)
      el.removeEventListener('drop', onDrop)
    }
  })

  return { dropPreview }
}
