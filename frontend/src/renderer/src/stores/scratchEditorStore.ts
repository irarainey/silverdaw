// Single source of truth for the one reused Scratch Editor dialog. A scratch
// session edits either a timeline clip or a whole library item, and only one is
// ever open at a time, so the dialog is hosted once (in App.vue) and driven by
// this store rather than mounting a separate instance per panel.

import { defineStore } from 'pinia'

interface ScratchEditorState {
  clipId: string | null
  libraryItemId: string | null
}

export const useScratchEditorStore = defineStore('scratchEditor', {
  state: (): ScratchEditorState => ({
    clipId: null,
    libraryItemId: null
  }),
  getters: {
    isOpen: (state): boolean => state.clipId !== null || state.libraryItemId !== null
  },
  actions: {
    /** Open the editor for a timeline clip. */
    openClip(clipId: string): void {
      this.libraryItemId = null
      this.clipId = clipId
    },
    /** Open the editor for a whole library item (its id is the session identity). */
    openLibraryItem(libraryItemId: string): void {
      this.clipId = null
      this.libraryItemId = libraryItemId
    },
    close(): void {
      this.clipId = null
      this.libraryItemId = null
    }
  }
})
