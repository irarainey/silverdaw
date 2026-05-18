// Application-level shell state.
//
// Holds values sampled once at startup that gate UI features. Some
// (`debugMode`) only take effect on the next launch because they need
// process-wide bootstrap; others (`toastsEnabled`) are live-updated
// from the Preferences dialog.
//
//   - `debugMode`: mirrors `prefs.debug.enabled` (main process). Controls
//     the visibility of the Debug menu and whether the cross-layer file
//     logger is active.
//
//   - `toastsEnabled`: mirrors `prefs.toasts.enabled`. When false, the
//     notifications store silently drops new toasts (events are still
//     logged when debug mode is on).
//
// `hydrate()` is called once from `main.ts` BEFORE the Vue app mounts so
// the title bar's menu list, the keyboard-shortcut bindings, and the
// renderer logger all see the correct startup snapshot from the first
// render.

import { defineStore } from 'pinia'

interface AppState {
  debugMode: boolean
  toastsEnabled: boolean
  /** True once `hydrate()` has resolved its IPC round-trip. */
  hydrated: boolean
}

export const useAppStore = defineStore('app', {
  state: (): AppState => ({
    debugMode: false,
    toastsEnabled: true,
    hydrated: false
  }),

  actions: {
    async hydrate(): Promise<void> {
      if (this.hydrated) return
      try {
        const [debug, qol] = await Promise.all([
          window.silverdaw.getStartupDebugEnabled(),
          window.silverdaw.getQolPrefs()
        ])
        this.debugMode = debug
        this.toastsEnabled = qol.toasts.enabled
      } catch (err) {
        console.warn('[appStore] hydrate failed, using defaults:', err)
        this.debugMode = false
        this.toastsEnabled = true
      } finally {
        this.hydrated = true
      }
    },

    /** Update the toast visibility flag in-store. The Preferences
     *  dialog calls this after persisting the change to main so the
     *  effect is immediate without waiting for a re-hydrate. */
    setToastsEnabled(value: boolean): void {
      this.toastsEnabled = value
    }
  }
})
