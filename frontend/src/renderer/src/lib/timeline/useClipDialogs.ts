// Per-timeline clip-dialog open state for the Clip Editor, Library Item Info and
// Warp/Pitch dialogs. Each is keyed by a `clipId` ref and resolves its
// `LibraryItem` here so the template stays dumb. Exposes intentful actions
// (`openEditor`/`openInfo`/`openWarp`/`closeXxx`) rather than raw refs.

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { useLibraryStore, type LibraryItem } from '@/stores/libraryStore'
import { useProjectStore } from '@/stores/projectStore'
import { useScratchEditorStore } from '@/stores/scratchEditorStore'

export type WarpDialogPanel = 'tempo' | 'pitch'

export interface ClipDialogActions {
  openEditor(clipId: string): void
  openScratchEditor(clipId: string): void
  openInfo(clipId: string): void
  openWarp(clipId: string, panel: WarpDialogPanel): void
  openSampleType(clipId: string): void
}

export interface ClipDialogs extends ClipDialogActions {
  editorClipId: Ref<string | null>
  infoClipId: Ref<string | null>
  warpDialogOpen: Ref<boolean>
  warpDialogClipId: Ref<string | null>
  warpDialogPanel: Ref<WarpDialogPanel>
  sampleTypeOpen: Ref<boolean>
  sampleTypeClipId: Ref<string | null>
  editorItem: ComputedRef<LibraryItem | null>
  infoItem: ComputedRef<LibraryItem | null>
  closeEditor(): void
  closeInfo(): void
  closeWarp(): void
  closeSampleType(): void
}

export function useClipDialogs(): ClipDialogs {
  const project = useProjectStore()
  const library = useLibraryStore()

  const editorClipId = ref<string | null>(null)
  const infoClipId = ref<string | null>(null)
  const warpDialogOpen = ref(false)
  const warpDialogClipId = ref<string | null>(null)
  const warpDialogPanel = ref<WarpDialogPanel>('tempo')
  const sampleTypeOpen = ref(false)
  const sampleTypeClipId = ref<string | null>(null)

  function resolveItem(clipId: string | null): LibraryItem | null {
    if (!clipId) return null
    const clip = project.clips[clipId]
    if (!clip) return null
    return library.byId[clip.libraryItemId] ?? null
  }

  const editorItem = computed(() => resolveItem(editorClipId.value))
  const infoItem = computed(() => resolveItem(infoClipId.value))

  function openEditor(clipId: string): void {
    editorClipId.value = clipId
  }
  function closeEditor(): void {
    editorClipId.value = null
  }
  function openScratchEditor(clipId: string): void {
    useScratchEditorStore().openClip(clipId)
  }

  function openInfo(clipId: string): void {
    infoClipId.value = clipId
  }
  function closeInfo(): void {
    infoClipId.value = null
  }

  function openWarp(clipId: string, panel: WarpDialogPanel): void {
    warpDialogClipId.value = clipId
    warpDialogPanel.value = panel
    warpDialogOpen.value = true
  }
  function closeWarp(): void {
    warpDialogOpen.value = false
  }

  function openSampleType(clipId: string): void {
    sampleTypeClipId.value = clipId
    sampleTypeOpen.value = true
  }
  function closeSampleType(): void {
    sampleTypeOpen.value = false
  }

  return {
    editorClipId,
    infoClipId,
    warpDialogOpen,
    warpDialogClipId,
    warpDialogPanel,
    sampleTypeOpen,
    sampleTypeClipId,
    editorItem,
    infoItem,
    openEditor,
    closeEditor,
    openScratchEditor,
    openInfo,
    closeInfo,
    openWarp,
    closeWarp,
    openSampleType,
    closeSampleType
  }
}
