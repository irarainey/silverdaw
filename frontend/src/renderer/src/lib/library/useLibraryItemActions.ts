// Library-item actions for the LibraryPanel, extracted from LibraryPanel.vue:
// the right-click context menu plus the Info and Editor dialog open/close
// state. Owns the `contextMenu`, `infoItemId` and `editorItemId` refs and the
// derived menu rows, and routes the menu commands (edit / info / rename /
// reanalyse / classify / save-as-sample / remove) to the library store. Rename
// is delegated to the caller because it owns the inline-edit lifecycle.
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { useLibraryStore, type LibraryItem } from '@/stores/libraryStore'
import { reanalyseLibraryItem } from '@/lib/importAudio'
import { requestStemSeparationForLibraryItem } from '@/lib/stems/stemSeparationFlow'
import { type ClipContextMenuItem } from '@/components/ClipContextMenu.vue'

export interface LibraryItemActionsDeps {
  /** Begin the inline rename gesture (owned by the rename composable; async). */
  startRename: (item: LibraryItem) => void | Promise<void>
}

export interface LibraryItemActions {
  infoItemId: Ref<string | null>
  editorItemId: Ref<string | null>
  contextMenu: Ref<{ itemId: string; x: number; y: number } | null>
  infoItem: ComputedRef<LibraryItem | null>
  editorItem: ComputedRef<LibraryItem | null>
  contextMenuItem: ComputedRef<LibraryItem | null>
  contextMenuItems: ComputedRef<ClipContextMenuItem[]>
  openItemInfo: (item: LibraryItem) => void
  closeItemInfo: () => void
  openItemEditor: (item: LibraryItem) => void
  closeItemEditor: () => void
  openItemContextMenu: (e: MouseEvent, item: LibraryItem) => void
  closeItemContextMenu: () => void
  onContextMenuCommand: (command: string) => void
}

export function useLibraryItemActions(deps: LibraryItemActionsDeps): LibraryItemActions {
  const library = useLibraryStore()

  const infoItemId = ref<string | null>(null)
  const editorItemId = ref<string | null>(null)
  const contextMenu = ref<{ itemId: string; x: number; y: number } | null>(null)

  const infoItem = computed(() => (infoItemId.value ? library.byId[infoItemId.value] ?? null : null))
  const editorItem = computed(() =>
    editorItemId.value ? library.byId[editorItemId.value] ?? null : null
  )
  const contextMenuItem = computed(() =>
    contextMenu.value ? library.byId[contextMenu.value?.itemId] ?? null : null
  )

  const contextMenuItems = computed<ClipContextMenuItem[]>(() => {
    const item = contextMenuItem.value
    if (!item) return []
    const inUse = library.isItemInUse(item.id)
    const items: ClipContextMenuItem[] = [
      { command: 'library.edit', label: 'Open in Editor' },
      { command: 'library.info', label: 'Show Information' },
      { command: 'library.rename', label: 'Rename', separatorAbove: true }
    ]
    if (item.kind === 'audio-file') {
      items.push({ command: 'library.reanalyse', label: 'Reanalyse File' })
      items.push({
        command: 'library.separateStems',
        label: 'Separate Stems',
        title:
          'Extract vocals, drums, bass, and other into separate stems added to the library. ' +
          'Add them to the timeline yourself afterwards.'
      })
    } else if (item.kind === 'saved-clip') {
      items.push({
        command: 'library.saveSample',
        label: 'Save as Sample',
        title:
          'Bakes the saved clip\u2019s current trim, warp, and pitch into a new independent WAV file. ' +
          'Re-running it always creates another fresh sample \u2014 baked samples are not linked back ' +
          'to this clip, so future edits to the saved clip do not affect previously-baked samples.'
      })
    }
    // Sample / music classification submenu. Audio-file items only —
    // saved clips inherit from their source unless the source is
    // missing (then they edit their own override here).
    if (item.kind === 'audio-file') {
      const auto = item.sampleMode === undefined
      items.push({
        command: 'library.classifyAuto',
        label: auto
          ? `Auto-classify (currently ${item.lowConfidence ? 'music, tempo unverified' : 'music'})`
          : 'Auto-classify',
        separatorAbove: true,
        disabled: auto
      })
      items.push({
        command: 'library.classifyMusic',
        label: 'Treat as Music',
        disabled: item.sampleMode === 'music'
      })
      items.push({
        command: 'library.classifySample',
        label: 'Treat as Sample',
        title:
          'Hide BPM / key / beat markers, and skip auto-warp on drop. Warp and pitch dialogs still work manually.',
        disabled: item.sampleMode === 'sample'
      })
    }
    // Saved clips can always be removed — doing so just unlinks any
    // timeline clips that reference them (they keep their audio and
    // become independent). Audio-file sources stay gated because
    // removing them would orphan the actual sound data.
    const isSavedClip = item.kind === 'saved-clip'
    const blockRemove = inUse && !isSavedClip
    items.push({
      command: 'library.delete',
      label: 'Remove',
      disabled: blockRemove,
      separatorAbove: true
    })
    return items
  })

  function openItemInfo(item: LibraryItem): void {
    closeItemContextMenu()
    infoItemId.value = item.id
  }

  function closeItemInfo(): void {
    infoItemId.value = null
  }

  function openItemEditor(item: LibraryItem): void {
    closeItemContextMenu()
    editorItemId.value = item.id
  }

  function closeItemEditor(): void {
    editorItemId.value = null
  }

  function openItemContextMenu(e: MouseEvent, item: LibraryItem): void {
    contextMenu.value = {
      itemId: item.id,
      x: e.clientX,
      y: e.clientY
    }
  }

  function closeItemContextMenu(): void {
    contextMenu.value = null
  }

  function onContextMenuCommand(command: string): void {
    const item = contextMenuItem.value
    if (!item) return
    if (command === 'library.edit') {
      openItemEditor(item)
      return
    }
    if (command === 'library.info') {
      openItemInfo(item)
      return
    }
    if (command === 'library.rename') {
      closeItemContextMenu()
      void deps.startRename(item)
      return
    }
    if (command === 'library.reanalyse') {
      closeItemContextMenu()
      void reanalyseLibraryItem(item.id)
      return
    }
    if (command === 'library.separateStems') {
      closeItemContextMenu()
      requestStemSeparationForLibraryItem(item.id)
      return
    }
    if (command === 'library.saveSample') {
      closeItemContextMenu()
      void library.saveLibraryItemAsSample(item.id)
      return
    }
    if (command === 'library.classifyAuto') {
      closeItemContextMenu()
      library.setItemSampleMode(item.id, 'auto')
      return
    }
    if (command === 'library.classifyMusic') {
      closeItemContextMenu()
      library.setItemSampleMode(item.id, 'music')
      return
    }
    if (command === 'library.classifySample') {
      closeItemContextMenu()
      library.setItemSampleMode(item.id, 'sample')
      return
    }
    if (command === 'library.delete') {
      const removed = library.removeItem(item.id)
      if (removed && infoItemId.value === item.id) closeItemInfo()
    }
  }

  return {
    infoItemId,
    editorItemId,
    contextMenu,
    infoItem,
    editorItem,
    contextMenuItem,
    contextMenuItems,
    openItemInfo,
    closeItemInfo,
    openItemEditor,
    closeItemEditor,
    openItemContextMenu,
    closeItemContextMenu,
    onContextMenuCommand
  }
}
