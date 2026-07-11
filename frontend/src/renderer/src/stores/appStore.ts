// Application shell state hydrated before Vue mounts.

import { defineStore } from 'pinia'
import { log } from '@/lib/log'
import type { RecentProject } from '@shared/types'

interface AppState {
  loggingEnabled: boolean
  devToolsEnabled: boolean
  toastsEnabled: boolean
  autosaveEnabled: boolean
  autosaveIntervalSeconds: number
  recentProjects: RecentProject[]
  /** Prevents the start screen flashing before autosave recovery resolves. */
  startupFlowComplete: boolean
  /** Session-scoped gate so the start screen appears at most once. */
  startScreenDismissed: boolean
  /** Recent project selected while the startup screen waits for the engine or load result. */
  openingRecentProjectPath: string | null
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
    openingRecentProjectPath: null,
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

    setToastsEnabled(value: boolean): void {
      this.toastsEnabled = value
    },

    /** Autosave manager re-evaluates its timer on the next reactive tick. */
    setAutosaveConfig(value: { enabled?: boolean; intervalSeconds?: number }): void {
      if (typeof value.enabled === 'boolean') this.autosaveEnabled = value.enabled
      if (typeof value.intervalSeconds === 'number' && Number.isFinite(value.intervalSeconds)) {
        this.autosaveIntervalSeconds = Math.max(5, Math.min(600, Math.round(value.intervalSeconds)))
      }
    },

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

    beginRecentProjectOpen(filePath: string): void {
      this.openingRecentProjectPath = filePath
    },

    finishRecentProjectOpen(): void {
      this.openingRecentProjectPath = null
    },

    markStartupFlowComplete(): void {
      this.startupFlowComplete = true
    }
  }
})
