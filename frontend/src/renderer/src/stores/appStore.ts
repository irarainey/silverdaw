// Application-level shell state.
//
// Holds values sampled once at startup that gate UI features but are NOT
// expected to change during the session — toggling them via Preferences
// only takes effect on the next launch. Currently:
//
//   - `debugMode`: mirrors `prefs.debug.enabled` (main process). Controls
//     the visibility of the Debug menu and whether the cross-layer file
//     logger is active.
//
// `hydrate()` is called once from `main.ts` BEFORE the Vue app mounts so
// the title bar's menu list, the keyboard-shortcut bindings, and the
// renderer logger all see the correct startup snapshot from the first
// render.

import { defineStore } from 'pinia'

interface AppState {
  debugMode: boolean
  /** True once `hydrate()` has resolved its IPC round-trip. */
  hydrated: boolean
}

export const useAppStore = defineStore('app', {
  state: (): AppState => ({
    debugMode: false,
    hydrated: false
  }),

  actions: {
    async hydrate(): Promise<void> {
      if (this.hydrated) return
      try {
        this.debugMode = await window.silverdaw.getStartupDebugEnabled()
      } catch (err) {
        console.warn('[appStore] hydrate failed, debug menu hidden:', err)
        this.debugMode = false
      } finally {
        this.hydrated = true
      }
    }
  }
})
