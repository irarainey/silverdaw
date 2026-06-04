// OS drag-and-drop import zone for the LibraryPanel, extracted from
// LibraryPanel.vue. Tracks hover state (with nested dragenter/dragleave depth
// counting) and routes dropped audio files through the sample-rate preflight
// and the shared import pipeline. Inner library-item drags (which carry no
// filesystem files) are ignored so they don't trigger an import.
import { ref, type Ref } from 'vue'
import { useLibraryStore } from '@/stores/libraryStore'
import { importAudioIntoLibrary, preflightSampleRates } from '@/lib/importAudio'
import { log } from '@/lib/log'

export interface LibraryDropZone {
  isDragOver: Ref<boolean>
  onPanelDragEnter: (e: DragEvent) => void
  onPanelDragOver: (e: DragEvent) => void
  onPanelDragLeave: (e: DragEvent) => void
  onPanelDrop: (e: DragEvent) => Promise<void>
}

/** True if the dragged payload includes filesystem files (vs an inner drag). */
function hasFiles(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  if (!types) return false
  for (let i = 0; i < types.length; i++) {
    if (types[i] === 'Files') return true
  }
  return false
}

export function useLibraryDropZone(): LibraryDropZone {
  const library = useLibraryStore()

  // True while an OS drag is hovering over the panel — used to highlight the
  // drop zone. We track depth to handle nested dragenter/dragleave correctly.
  const isDragOver = ref(false)
  let dragDepth = 0

  function onPanelDragEnter(e: DragEvent): void {
    if (!hasFiles(e)) return
    dragDepth++
    isDragOver.value = true
    e.preventDefault()
  }

  function onPanelDragOver(e: DragEvent): void {
    if (!hasFiles(e)) return
    // Required to allow `drop` to fire.
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }

  function onPanelDragLeave(e: DragEvent): void {
    if (!hasFiles(e)) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) isDragOver.value = false
  }

  async function onPanelDrop(e: DragEvent): Promise<void> {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth = 0
    isDragOver.value = false

    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) return
    // Resolve file paths first so the preflight probe has something to
    // hand the backend. Drops that lack a path (rare; usually only
    // in-browser drags) are filtered out before the preflight so they
    // don't skew the rate buckets.
    const pairs: { file: File; path: string }[] = []
    for (const file of files) {
      const path = window.silverdaw.getPathForFile(file)
      if (!path) {
        log.warn('library', `dropped file has no path: ${file.name}`)
        continue
      }
      pairs.push({ file, path })
    }
    if (pairs.length === 0) return
    const decision = await preflightSampleRates(pairs.map((p) => p.path))
    if (decision === 'cancel') {
      log.info('library', 'import (drag/drop) cancelled at sample-rate prompt')
      return
    }
    // Count every dropped file towards the progress total, even ones that
    // turn out to fail to read — we call `noteImportFinished()` for
    // those too so the bar still completes.
    library.beginImportBatch(pairs.length)
    for (const { path } of pairs) {
      const opened = await window.silverdaw.readAudioFile(path)
      if (!opened) {
        library.noteImportFinished()
        continue
      }
      await importAudioIntoLibrary(opened)
    }
  }

  return { isDragOver, onPanelDragEnter, onPanelDragOver, onPanelDragLeave, onPanelDrop }
}
