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

  // True when the tile has a cover image to hide — its own, or (for a derived stem /
  // sample) the origin source's shared cover. Ignores `coverArtHidden` so a hidden
  // tile still reports it has art to restore.
  function hasEffectiveCoverArt(item: LibraryItem): boolean {
    if (item.coverArtUrl) return true
    const originId = item.derivedFrom?.sourceItemId
    return !!(originId && library.byId[originId]?.coverArtUrl)
  }

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
    const isFile = item.kind === 'source' || item.kind === 'sample' || item.kind === 'stem'
    if (isFile) {
      items.push({ command: 'library.reanalyse', label: 'Reanalyse File' })
    }
    // Separate Stems applies to whole source files (and samples), but never to a
    // stem itself — a stem is already a separated part, so it is hidden there.
    if (item.kind === 'source' || item.kind === 'sample') {
      items.push({
        command: 'library.separateStems',
        label: 'Separate Stems',
        title:
          'Extract vocals, drums, bass, and other into separate stems added to the library. ' +
          'Add them to the timeline yourself afterwards.'
      })
    } else if (item.kind === 'clip') {
      items.push({
        command: 'library.saveMusicSample',
        label: 'Save as Sample (Music)',
        title:
          'Create a new independent WAV sample from the saved clip that keeps the source ' +
          'tempo, beat markers, key, and cover art, so it warps to the project tempo when ' +
          'dropped onto a track. Samples are not linked back to this clip.'
      })
      items.push({
        command: 'library.saveSimpleSample',
        label: 'Save as Sample (Simple)',
        title:
          'Create a new independent WAV sample from the saved clip as a bare one-shot \u2014 ' +
          'a sound effect or vocal snippet with no tempo or beat metadata that is never ' +
          'warped when dropped onto a track. Samples are not linked back to this clip.'
      })
    }
    // Simple / music classification submenu. Source, sample, and stem files —
    // saved clips inherit from their source unless the source is
    // missing (then they edit their own override here).
    if (isFile) {
      const auto = item.audioType === undefined
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
        disabled: item.audioType === 'music'
      })
      items.push({
        command: 'library.classifySimple',
        label: 'Treat as Simple',
        title:
          'Hide BPM / key / beat markers, and skip auto-warp on drop. Warp and pitch dialogs still work manually.',
        disabled: item.audioType === 'simple'
      })
    }
    // Cover-art visibility. Tiles that show a cover image (imported sources, saved
    // samples, and stems) can hide it — a per-item project setting that never deletes
    // the shared media-store image, so it can always be restored from the original.
    if (isFile) {
      items.push({
        command: 'library.updateImage',
        label: 'Update Image\u2026',
        separatorAbove: true,
        title: 'Choose a new cover image for this tile. Copied into the project; affects only this tile.'
      })
      if (item.coverArtHidden) {
        items.push({
          command: 'library.restoreImage',
          label: 'Restore Image',
          title: 'Show this tile\u2019s cover art again from the original source.'
        })
      } else if (hasEffectiveCoverArt(item)) {
        items.push({
          command: 'library.removeImage',
          label: 'Remove Image',
          title: 'Hide this tile\u2019s cover art. The image file is not deleted and can be restored.'
        })
      }
    }
    // Saved clips can always be removed — doing so just unlinks any
    // timeline clips that reference them (they keep their audio and
    // become independent). Source + sample files stay gated because
    // removing them would orphan the actual sound data.
    const isLibraryClip = item.kind === 'clip'
    const blockRemove = inUse && !isLibraryClip
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
    if (command === 'library.saveMusicSample') {
      closeItemContextMenu()
      void library.saveLibraryItemAsSample(item.id, 'music')
      return
    }
    if (command === 'library.saveSimpleSample') {
      closeItemContextMenu()
      void library.saveLibraryItemAsSample(item.id, 'simple')
      return
    }
    if (command === 'library.classifyAuto') {
      closeItemContextMenu()
      library.setItemAudioType(item.id, 'auto')
      return
    }
    if (command === 'library.classifyMusic') {
      closeItemContextMenu()
      library.setItemAudioType(item.id, 'music')
      return
    }
    if (command === 'library.classifySimple') {
      closeItemContextMenu()
      library.setItemAudioType(item.id, 'simple')
      return
    }
    if (command === 'library.removeImage') {
      closeItemContextMenu()
      library.setItemCoverArtHidden(item.id, true)
      return
    }
    if (command === 'library.restoreImage') {
      closeItemContextMenu()
      library.setItemCoverArtHidden(item.id, false)
      return
    }
    if (command === 'library.updateImage') {
      closeItemContextMenu()
      void library.updateItemCoverArt(item.id)
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
