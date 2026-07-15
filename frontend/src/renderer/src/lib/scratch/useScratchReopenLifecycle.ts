// Saved-scratch re-open lifecycle. A saved-scratch re-open must load its
// notation only AFTER the backend session exists (the store rejects a
// pattern load while `current` is null), so the open transition records the
// target pattern id and this composable applies it once the session becomes
// ready or the pattern arrives via PROJECT_STATE.

import { ref, watch, type Ref } from 'vue'
import type { ScratchPattern } from '@shared/bridge-protocol'

export interface ScratchReopenLifecycleOptions {
  open: Ref<boolean>
  libraryItemId: Ref<string | null | undefined>
  activeSessionId: Ref<string | null>
  savedPatterns: Ref<readonly ScratchPattern[]>
  getSavedScratchPatternId(itemId: string): string | null
  selectAndLoad(patternId: string): void
}

export interface ScratchReopenLifecycle {
  /** Drops any pending re-open target, e.g. when the dialog is closing. */
  clearPending(): void
}

export function useScratchReopenLifecycle(
  options: ScratchReopenLifecycleOptions
): ScratchReopenLifecycle {
  const pendingReopenPatternId = ref<string | null>(null)

  function tryLoadPendingReopen(): void {
    const patternId = pendingReopenPatternId.value
    if (!patternId || !options.activeSessionId.value) return
    if (!options.savedPatterns.value.some((pattern) => pattern.id === patternId)) return
    options.selectAndLoad(patternId)
    pendingReopenPatternId.value = null
  }

  // Re-opening a saved scratch: remember its notation id so the editor shows
  // the recorded pattern once the session is ready (a re-save updates it).
  watch(
    options.open,
    (open) => {
      if (!open) {
        pendingReopenPatternId.value = null
        return
      }
      const openedItemId = options.libraryItemId.value
      pendingReopenPatternId.value =
        openedItemId != null ? options.getSavedScratchPatternId(openedItemId) : null
    },
    { immediate: true }
  )

  watch(options.savedPatterns, tryLoadPendingReopen)
  watch(options.activeSessionId, tryLoadPendingReopen)

  function clearPending(): void {
    pendingReopenPatternId.value = null
  }

  return { clearPending }
}
