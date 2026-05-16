// Drag-and-drop landing zone for library items → timeline.
//
// When a library card is dragged onto the timeline canvas we compute the
// target track + start time on every `dragover`, expose a "drop preview"
// (consumed by the component's `drawDropPreview` helper) and, on `drop`,
// route the placement through `projectStore.addClipFromLibrary`.
//
// We rely on `library.currentDragItemId` parked by `LibraryPanel`'s
// `dragstart` handler to identify the in-flight item — `DataTransfer`
// goes into "protected mode" during `dragover` and hides custom MIME
// types, which previously caused the drag to fail silently. The MIME
// payload is still set on the drag for round-trip compatibility and is
// the authoritative source on the final `drop` event.

import { onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { Application } from 'pixi.js'
import { libraryItemDisplayName, useLibraryStore, type LibraryItem } from '@/stores/libraryStore'
import { useProjectStore } from '@/stores/projectStore'
import { log } from '@/lib/log'
import {
  RULER_HEIGHT,
  SCROLLBAR_HEIGHT,
  SCROLLBAR_WIDTH,
  TRACK_GAP,
  TRACK_HEIGHT
} from './constants'
import type { GridGeometry } from './useGridGeometry'

export interface DropPreview {
  trackIndex: number
  startMs: number
  durationMs: number
  /** False if the drop would overlap an existing clip on the same track. */
  valid: boolean
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
  /**
   * Fires whenever `dropPreview` changes (or after a drop completes) so
   * the host component can repaint the playhead/ghost layer.
   */
  onPreviewChanged: () => void
}

const MIME_LIBRARY_ITEM = 'application/x-silverdaw-library-item'

export function useDropZone(opts: DropZoneOptions): DropZone {
  const library = useLibraryStore()
  const project = useProjectStore()
  const { host, app, scrollX, scrollY, showScrollbar, geometry, onPreviewChanged } = opts

  const dropPreview = ref<DropPreview | null>(null)

  function isLibraryDrag(): boolean {
    return library.currentDragItemId !== null
  }

  /**
   * Inspect the in-flight drag for the library item being dragged.
   * `dataTransfer.getData(MIME)` returns `''` during `dragover` for
   * security reasons, so we instead read the id parked by `LibraryPanel`.
   * `getData` does work during the final `drop` event; the caller passes
   * `viaGetData = true` there as the more authoritative fallback.
   */
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

  /**
   * Convert a viewport-local pointer position into a target track index +
   * snapped start time. Returns null if the pointer falls outside the
   * scrollable track area, in the inter-track gap, or below the last track.
   */
  function pointerToTrackDrop(
    clientX: number,
    clientY: number
  ): { trackIndex: number; startMs: number } | null {
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

    const contentY = y + scrollY.value - RULER_HEIGHT
    const slot = TRACK_HEIGHT + TRACK_GAP
    const trackIndex = Math.floor(contentY / slot)
    if (trackIndex < 0 || trackIndex >= project.tracks.length) return null
    // Reject the inter-track gap so dropping between rows doesn't pick
    // one arbitrarily — the user has to land in the row proper.
    const yWithinSlot = contentY - trackIndex * slot
    if (yWithinSlot >= TRACK_HEIGHT) return null

    const trackLocalX = x - geometry.headerWidth()
    const rawMs = ((scrollX.value + trackLocalX) / geometry.pxPerSecond.value) * 1000
    const snap = geometry.msPerSubBeat()
    const startMs = Math.max(0, Math.round(rawMs / snap) * snap)
    return { trackIndex, startMs }
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

    const target = pointerToTrackDrop(e.clientX, e.clientY)
    const item = resolveDragItem(e)
    if (!target || !item) {
      e.dataTransfer.dropEffect = 'none'
      clearPreview()
      return
    }

    const overlaps = project.wouldClipOverlap(
      project.tracks[target.trackIndex]!.id,
      target.startMs,
      item.durationMs
    )
    e.dataTransfer.dropEffect = overlaps ? 'none' : 'copy'

    // Only re-render the ghost when the resolved drop changes; dragover
    // fires very frequently and `onPreviewChanged` repaints a Pixi layer.
    const next: DropPreview = {
      trackIndex: target.trackIndex,
      startMs: target.startMs,
      durationMs: item.durationMs,
      valid: !overlaps
    }
    const cur = dropPreview.value
    if (
      cur === null ||
      cur.trackIndex !== next.trackIndex ||
      cur.startMs !== next.startMs ||
      cur.durationMs !== next.durationMs ||
      cur.valid !== next.valid
    ) {
      dropPreview.value = next
      onPreviewChanged()
    }
  }

  function onDragLeave(e: DragEvent): void {
    if (!isLibraryDrag()) return
    // Only clear when the drag actually leaves the host (not when
    // crossing between child elements). `relatedTarget === null` is the
    // cross-window case; the `contains` check covers leaving host bounds.
    const related = e.relatedTarget as Node | null
    if (related && host.value && host.value.contains(related)) return
    clearPreview()
  }

  function onDrop(e: DragEvent): void {
    if (!isLibraryDrag()) return
    e.preventDefault()

    // Clear the ghost first so the timeline doesn't briefly show the old
    // preview after the drop completes.
    dropPreview.value = null

    // Prefer the dataTransfer payload (authoritative on `drop`); fall
    // back to the store-tracked id if the MIME data was somehow empty.
    const item = resolveDragItem(e, true)
    if (!item) {
      onPreviewChanged()
      return
    }

    const target = pointerToTrackDrop(e.clientX, e.clientY)
    if (!target) {
      onPreviewChanged()
      return
    }

    project.addClipFromLibrary(
      project.tracks[target.trackIndex]!.id,
      { ...item, fileName: libraryItemDisplayName(item) },
      target.startMs
    )
    log.info('dropzone', `drop trackIndex=${target.trackIndex} startMs=${target.startMs} item=${item.id}`)
    onPreviewChanged()
  }

  // Attach all four drag events once the host element is available.
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
