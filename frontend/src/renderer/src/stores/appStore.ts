// Application-level shell state.
//
// Holds values sampled once at startup that gate UI features. Some
// developer options only take effect on the next launch because they need
// process-wide bootstrap; others (`toastsEnabled`) are live-updated
// from the Preferences dialog.
//
//   - `loggingEnabled`: mirrors `prefs.debug.loggingEnabled` (main process).
//     Controls whether the cross-layer file logger is active.
//
//   - `devToolsEnabled`: mirrors `prefs.debug.devToolsEnabled` (main process).
//     Controls visibility of the Debug menu and DevTools shortcuts.
//
//   - `toastsEnabled`: mirrors `prefs.toasts.enabled`. When false, the
//     notifications store silently drops new toasts (events are still
//     logged when debug mode is on).
//
//   - `autosaveEnabled` / `autosaveIntervalSeconds`: mirror
//     `prefs.autosave.*`. The autosave manager watches these and
//     starts/stops its tick accordingly.
//
//   - `recentProjects`: mirror of `prefs.recentProjects`, head = most
//     recent. The File menu reads from this and the Start Screen renders
//     it. Refreshed lazily (`refreshRecentProjects`) after any save /
//     load / open dialog completes so the in-store copy doesn't go
//     stale.
//
//   - `startScreenDismissed` / `startupFlowComplete`: gate the empty-
//     project start screen so it shows exactly once per session, after
//     the startup coordinator (App.vue) has finished checking for
//     recoverable autosaves.
//
// `hydrate()` is called once from `main.ts` BEFORE the Vue app mounts so
// the title bar's menu list, the keyboard-shortcut bindings, and the
// renderer logger all see the correct startup snapshot from the first
// render.

import { defineStore } from 'pinia'
import { log } from '@/lib/log'

interface AppState {
  loggingEnabled: boolean
  devToolsEnabled: boolean
  toastsEnabled: boolean
  autosaveEnabled: boolean
  autosaveIntervalSeconds: number
  recentProjects: string[]
  /** False at boot; flipped true once the App.vue startup coordinator
   *  has finished checking for recoverable autosaves and either
   *  resolved them or skipped. Until this is true, the start screen
   *  stays hidden so we don't flash an empty-project overlay before
   *  recovery had a chance to surface. */
  startupFlowComplete: boolean
  /** Session-scoped flag: once the user has taken any project-creating
   *  action (New / Open / pick an MRU entry / restore an autosave), the
   *  start screen stops re-appearing even if the project state happens
   *  to be empty again later. */
  startScreenDismissed: boolean
  /** True once `hydrate()` has resolved its IPC round-trip. */
  hydrated: boolean
}

export const useAppStore = defineStore('app', {
  state: (): AppState => ({
    loggingEnabled: false,
    devToolsEnabled: false,
    toastsEnabled: true,
    autosaveEnabled: true,
    autosaveIntervalSeconds: 30,
    recentProjects: [],
    startupFlowComplete: false,
    startScreenDismissed: false,
    hydrated: false
  }),

  actions: {
    async hydrate(): Promise<void> {
      if (this.hydrated) return
      try {
        const [debug, qol, autosave, recents] = await Promise.all([
          window.silverdaw.getStartupDebugPreferences(),
          window.silverdaw.getQolPrefs(),
          window.silverdaw.getAutosaveConfig(),
          window.silverdaw.getRecentProjects()
        ])
        this.loggingEnabled = debug.loggingEnabled
        this.devToolsEnabled = debug.devToolsEnabled
        this.toastsEnabled = qol.toasts.enabled
        this.autosaveEnabled = autosave.enabled
        this.autosaveIntervalSeconds = autosave.intervalSeconds
        this.recentProjects = recents
      } catch (err) {
        log.warn('app', `hydrate failed, using defaults: ${String(err)}`)
        this.loggingEnabled = false
        this.devToolsEnabled = false
        this.toastsEnabled = true
        this.autosaveEnabled = true
        this.autosaveIntervalSeconds = 30
        this.recentProjects = []
      } finally {
        this.hydrated = true
      }
    },

    /** Update the toast visibility flag in-store. The Preferences
     *  dialog calls this after persisting the change to main so the
     *  effect is immediate without waiting for a re-hydrate. */
    setToastsEnabled(value: boolean): void {
      this.toastsEnabled = value
    },

    /** Update the in-store autosave config; the manager re-evaluates
     *  its timer on the next reactive tick. */
    setAutosaveConfig(value: { enabled?: boolean; intervalSeconds?: number }): void {
      if (typeof value.enabled === 'boolean') this.autosaveEnabled = value.enabled
      if (typeof value.intervalSeconds === 'number' && Number.isFinite(value.intervalSeconds)) {
        this.autosaveIntervalSeconds = Math.max(5, Math.min(600, Math.round(value.intervalSeconds)))
      }
    },

    /** Re-pull the MRU from main. Called after save / load / dialog
     *  flows so the File menu and the Start Screen always render the
     *  freshest list. */
    async refreshRecentProjects(): Promise<void> {
      try {
        this.recentProjects = await window.silverdaw.getRecentProjects()
      } catch (err) {
        log.warn('app', `refreshRecentProjects failed: ${String(err)}`)
      }
    },

    dismissStartScreen(): void {
      this.startScreenDismissed = true
    },

    markStartupFlowComplete(): void {
      this.startupFlowComplete = true
    }
  }
})
