// Missing-file detection for the app shell: watches unresolved library source
// paths and opens the relink dialog (plus a toast) whenever a fresh or grown
// set of missing files appears. Extracted from App.vue so the shell stays thin.

import { computed, ref, watch, type Ref } from 'vue'
import { useLibraryStore } from '@/stores/libraryStore'
import { useNotificationsStore } from '@/stores/notificationsStore'

export interface MissingFileRelink {
  relinkDialogOpen: Ref<boolean>
}

export function useMissingFileRelink(): MissingFileRelink {
  const library = useLibraryStore()
  const notifications = useNotificationsStore()

  const relinkDialogOpen = ref(false)

  // Watch unresolved library ids so every persisted source path can trigger relinking.
  const unresolvedLibraryItemIds = computed(() =>
    library.items
      .filter((i) => i.unresolved)
      .map((i) => i.id)
      .sort()
      .join('|')
  )

  watch(unresolvedLibraryItemIds, (next, prev) => {
    if (!next || next === prev) return
    const ids = next.split('|').filter((s) => s.length > 0)
    if (ids.length === 0) return
    // Only announce fresh or grown missing-file sets.
    const prevIds = (prev ?? '').split('|').filter((s) => s.length > 0)
    const isNew = ids.some((id) => !prevIds.includes(id))
    if (!isNew) return
    relinkDialogOpen.value = true
    // Count unique paths so the toast matches RelinkDialog rows.
    const uniqueMissingPaths = new Set<string>()
    for (const id of ids) {
      const item = library.byId[id]
      if (item) uniqueMissingPaths.add(item.filePath)
    }
    const fileCount = uniqueMissingPaths.size
    notifications.push(
      'error',
      `${fileCount} ${fileCount === 1 ? 'audio file is' : 'audio files are'} missing — locate or relink to play.`
    )
  })

  return { relinkDialogOpen }
}
