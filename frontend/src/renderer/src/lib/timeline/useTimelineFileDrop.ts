// File-drop handling for the timeline. Covers both an Explorer drag and a row
// dragged from the Files tab: neither is in the library yet, so both import
// through the shared Library pipeline first, then use the captured drop target
// to place the new clips.

import { watch, type Ref } from 'vue'
import {
  hasDroppedFiles,
  importDroppedAudioFiles,
  importDroppedAudioPaths,
  libraryItemToClipPlacement
} from '@/lib/importAudio'
import { runInUndoGroup } from '@/lib/undo/undoGroup'
import { useFileBrowserStore, MIME_FILE_BROWSER_PATH } from '@/stores/fileBrowserStore'
import { useProjectStore } from '@/stores/projectStore'
import type { LibraryItem } from '@/stores/libraryStore'
import type { TimelineDropTarget } from './useDropZone'

export interface TimelineFileDropOptions {
  host: Ref<HTMLElement | null>
  resolveDropTarget: (clientX: number, clientY: number) => TimelineDropTarget | null
  startMsForItem: (rawMs: number, item: LibraryItem) => number
  /** Drives the same drop ghost the library drag uses, so every timeline drop looks alike.
   *  Returns the drop effect the cursor should show, as the library path does. */
  previewExternalDrop: (
    clientX: number,
    clientY: number,
    durationMs: number | null
  ) => 'copy' | 'none'
  clearExternalDrop: () => void
  onPlaced: () => void
}

export interface TimelineFileDrop {
  dispose: () => void
}

export function useTimelineFileDrop(options: TimelineFileDropOptions): TimelineFileDrop {
  const project = useProjectStore()
  const fileBrowser = useFileBrowserStore()
  let attachedHost: HTMLElement | null = null

  /** A browsed row is recognised by the store flag, because `dragover` cannot
   *  read `dataTransfer` and so cannot see the row's MIME payload. */
  function isBrowserRowDrag(): boolean {
    return fileBrowser.draggingPath !== null
  }

  function isImportDrag(event: DragEvent): boolean {
    return hasDroppedFiles(event) || isBrowserRowDrag()
  }

  /** Length for the ghost. A browsed row may already have one from its tags; an
   *  Explorer drag never does, because `dragover` hides the file entirely. */
  function draggedDurationMs(): number | null {
    const path = fileBrowser.draggingPath
    if (path === null) return null
    return fileBrowser.info[path]?.durationMs ?? null
  }

  /** Import whatever the drag carried, whichever source it came from. */
  async function importDraggedAudio(event: DragEvent): Promise<LibraryItem[]> {
    if (hasDroppedFiles(event)) {
      return importDroppedAudioFiles(Array.from(event.dataTransfer?.files ?? []))
    }
    // Prefer the MIME payload, which is readable on drop, and fall back to the
    // store flag for the same reason `useDropZone` does.
    const path = event.dataTransfer?.getData(MIME_FILE_BROWSER_PATH) || fileBrowser.draggingPath
    return path ? importDroppedAudioPaths([path]) : []
  }

  function clearDragState(): void {
    options.clearExternalDrop()
  }

  function onDragEnter(event: DragEvent): void {
    if (!isImportDrag(event)) return
    event.preventDefault()
    options.previewExternalDrop(event.clientX, event.clientY, draggedDurationMs())
  }

  function onDragOver(event: DragEvent): void {
    if (!isImportDrag(event)) return
    event.preventDefault()
    const effect = options.previewExternalDrop(event.clientX, event.clientY, draggedDurationMs())
    if (event.dataTransfer) event.dataTransfer.dropEffect = effect
  }

  function onDragLeave(event: DragEvent): void {
    if (!isImportDrag(event)) return
    const related = event.relatedTarget as Node | null
    if (related && options.host.value?.contains(related)) return
    clearDragState()
  }

  async function onDrop(event: DragEvent): Promise<void> {
    if (!isImportDrag(event)) return
    event.preventDefault()
    clearDragState()

    const target = options.resolveDropTarget(event.clientX, event.clientY)
    if (!target) return
    const targetTrackId =
      target.createNewTrack ? null : project.tracks[target.trackIndex]?.id ?? null
    const items = await importDraggedAudio(event)
    if (items.length === 0) return

    let placed = false
    if (target.createNewTrack || items.length > 1) {
      runInUndoGroup('Add dropped audio to tracks', () => {
        for (const item of items) {
          const trackId = project.addTrack()
          const clipId = project.addClipFromLibrary(
            trackId,
            libraryItemToClipPlacement(item),
            options.startMsForItem(target.rawMs, item)
          )
          placed ||= clipId !== null
        }
      })
    } else if (targetTrackId) {
      const clipId = project.addClipFromLibrary(
        targetTrackId,
        libraryItemToClipPlacement(items[0]!),
        options.startMsForItem(target.rawMs, items[0]!)
      )
      placed = clipId !== null
    }

    if (placed) options.onPlaced()
  }

  function detachHostListeners(): void {
    if (!attachedHost) return
    attachedHost.removeEventListener('dragenter', onDragEnter)
    attachedHost.removeEventListener('dragover', onDragOver)
    attachedHost.removeEventListener('dragleave', onDragLeave)
    attachedHost.removeEventListener('drop', onDrop)
    attachedHost = null
  }

  const stopHostWatch = watch(
    options.host,
    (element) => {
      detachHostListeners()
      if (element) {
        element.addEventListener('dragenter', onDragEnter)
        element.addEventListener('dragover', onDragOver)
        element.addEventListener('dragleave', onDragLeave)
        element.addEventListener('drop', onDrop)
        attachedHost = element
      }
    },
    { immediate: true }
  )

  function dispose(): void {
    stopHostWatch()
    detachHostListeners()
    clearDragState()
  }

  return { dispose }
}
