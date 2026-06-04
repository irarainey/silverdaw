// Inline library-item rename, extracted from LibraryPanel.vue. Double-clicking
// (or the context-menu "Rename") opens an in-place <input>; Enter / click-away
// commits via `library.renameItem`, Escape cancels. Commit / cancel gestures
// are detected with capture-phase document listeners (more robust than the
// input's own keydown/blur, which interactive draggable rows can intercept).
//
// The SFC keeps ownership of the `editingItemId` watch that adds/removes the
// capture-phase document listeners (preserving listener identity); this module
// supplies the handlers and the rename state.
import { nextTick, ref, type ComponentPublicInstance, type Ref } from 'vue'
import { libraryItemDisplayName, useLibraryStore, type LibraryItem } from '@/stores/libraryStore'
import { log } from '@/lib/log'

export interface LibraryItemRename {
  editingItemId: Ref<string | null>
  editingValue: Ref<string>
  setNameInputEl: (el: Element | ComponentPublicInstance | null) => void
  startRename: (item: LibraryItem) => Promise<void>
  commitRename: () => void
  cancelRename: () => void
  onDocumentKeyDown: (e: KeyboardEvent) => void
  onDocumentPointerDown: (e: PointerEvent) => void
}

export function useLibraryItemRename(): LibraryItemRename {
  const library = useLibraryStore()

  const editingItemId = ref<string | null>(null)
  const editingValue = ref('')
  let nameInputEl: HTMLInputElement | null = null

  function setNameInputEl(el: Element | ComponentPublicInstance | null): void {
    nameInputEl = (el as HTMLInputElement | null) ?? null
  }

  async function startRename(item: LibraryItem): Promise<void> {
    log.info('library', `startRename id=${item.id}`)
    editingItemId.value = item.id
    editingValue.value = libraryItemDisplayName(item)
    await nextTick()
    if (nameInputEl) {
      nameInputEl.focus()
      nameInputEl.select()
    }
  }

  function commitRename(): void {
    const id = editingItemId.value
    if (!id) return
    log.info('library', `commitRename ${id} -> "${editingValue.value}"`)
    library.renameItem(id, editingValue.value)
    editingItemId.value = null
  }

  function cancelRename(): void {
    log.info('library', 'cancelRename')
    editingItemId.value = null
  }

  function onDocumentKeyDown(e: KeyboardEvent): void {
    if (!editingItemId.value) return
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      commitRename()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      cancelRename()
    }
  }

  function onDocumentPointerDown(e: PointerEvent): void {
    if (!editingItemId.value) return
    if (!nameInputEl) return
    if (e.target instanceof Node && nameInputEl.contains(e.target)) return
    commitRename()
  }

  return {
    editingItemId,
    editingValue,
    setNameInputEl,
    startRename,
    commitRename,
    cancelRename,
    onDocumentKeyDown,
    onDocumentPointerDown
  }
}
