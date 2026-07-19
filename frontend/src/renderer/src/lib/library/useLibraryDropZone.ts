// OS drag-and-drop import zone for the LibraryPanel, extracted from
// LibraryPanel.vue. Tracks hover state (with nested dragenter/dragleave depth
// counting) and routes dropped audio files through the sample-rate preflight
// and the shared import pipeline. Inner library-item drags (which carry no
// filesystem files) are ignored so they don't trigger an import.
import { ref, type Ref } from 'vue'
import { hasDroppedFiles, importDroppedAudioFiles } from '@/lib/importAudio'

export interface LibraryDropZone {
  isDragOver: Ref<boolean>
  onPanelDragEnter: (e: DragEvent) => void
  onPanelDragOver: (e: DragEvent) => void
  onPanelDragLeave: (e: DragEvent) => void
  onPanelDrop: (e: DragEvent) => Promise<void>
}

export function useLibraryDropZone(): LibraryDropZone {
  // True while an OS drag is hovering over the panel — used to highlight the
  // drop zone. We track depth to handle nested dragenter/dragleave correctly.
  const isDragOver = ref(false)
  let dragDepth = 0

  function onPanelDragEnter(e: DragEvent): void {
    if (!hasDroppedFiles(e)) return
    dragDepth++
    isDragOver.value = true
    e.preventDefault()
  }

  function onPanelDragOver(e: DragEvent): void {
    if (!hasDroppedFiles(e)) return
    // Required to allow `drop` to fire.
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }

  function onPanelDragLeave(e: DragEvent): void {
    if (!hasDroppedFiles(e)) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) isDragOver.value = false
  }

  async function onPanelDrop(e: DragEvent): Promise<void> {
    if (!hasDroppedFiles(e)) return
    e.preventDefault()
    dragDepth = 0
    isDragOver.value = false

    await importDroppedAudioFiles(Array.from(e.dataTransfer?.files ?? []))
  }

  return { isDragOver, onPanelDragEnter, onPanelDragOver, onPanelDragLeave, onPanelDrop }
}
