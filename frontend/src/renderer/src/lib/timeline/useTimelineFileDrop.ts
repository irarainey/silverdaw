// Explorer-file drop handling for the timeline. Imports through the shared
// Library pipeline, then uses the captured drop target to place the new clips.

import { ref, watch, type Ref } from 'vue'
import { hasDroppedFiles, importDroppedAudioFiles, libraryItemToClipPlacement } from '@/lib/importAudio'
import { runInUndoGroup } from '@/lib/undo/undoGroup'
import { useProjectStore } from '@/stores/projectStore'
import type { LibraryItem } from '@/stores/libraryStore'
import type { TimelineDropTarget } from './useDropZone'

export interface TimelineFileDropOptions {
  host: Ref<HTMLElement | null>
  resolveDropTarget: (clientX: number, clientY: number) => TimelineDropTarget | null
  startMsForItem: (rawMs: number, item: LibraryItem) => number
  onPlaced: () => void
}

export interface TimelineFileDrop {
  isFileDragOver: Ref<boolean>
  dispose: () => void
}

export function useTimelineFileDrop(options: TimelineFileDropOptions): TimelineFileDrop {
  const project = useProjectStore()
  const isFileDragOver = ref(false)

  function clearDragState(): void {
    isFileDragOver.value = false
  }

  function onDragEnter(event: DragEvent): void {
    if (!hasDroppedFiles(event)) return
    isFileDragOver.value = true
    event.preventDefault()
  }

  function onDragOver(event: DragEvent): void {
    if (!hasDroppedFiles(event)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  }

  function onDragLeave(event: DragEvent): void {
    if (!hasDroppedFiles(event)) return
    const related = event.relatedTarget as Node | null
    if (related && options.host.value?.contains(related)) return
    clearDragState()
  }

  async function onDrop(event: DragEvent): Promise<void> {
    if (!hasDroppedFiles(event)) return
    event.preventDefault()
    clearDragState()

    const target = options.resolveDropTarget(event.clientX, event.clientY)
    if (!target) return
    const targetTrackId =
      target.createNewTrack ? null : project.tracks[target.trackIndex]?.id ?? null
    const items = await importDroppedAudioFiles(Array.from(event.dataTransfer?.files ?? []))
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

  const stopHostWatch = watch(
    options.host,
    (element, previous) => {
      if (previous) {
        previous.removeEventListener('dragenter', onDragEnter)
        previous.removeEventListener('dragover', onDragOver)
        previous.removeEventListener('dragleave', onDragLeave)
        previous.removeEventListener('drop', onDrop)
      }
      if (element) {
        element.addEventListener('dragenter', onDragEnter)
        element.addEventListener('dragover', onDragOver)
        element.addEventListener('dragleave', onDragLeave)
        element.addEventListener('drop', onDrop)
      }
    },
    { immediate: true }
  )

  function dispose(): void {
    stopHostWatch()
    clearDragState()
  }

  return { isFileDragOver, dispose }
}
