// Owns the persisted preferences singleton: load/merge/clamp, debounced and
// synchronous JSON writes, the Recent Projects MRU, window bounds/state, and the
// session-only clip dialog folder. Main and the IPC handler modules reach prefs
// state exclusively through this service so save scheduling never drifts.

import { app, screen, type BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  MAX_RECENT_PROJECTS,
  buildDefaultPrefs,
  clampAutosaveSeconds,
  normaliseDebugPrefs,
  sanitiseRecentList,
  sanitiseStemPrefs,
  sanitiseStemModelDir,
  sanitiseUiPrefs,
  type AudioOutputPrefs,
  type AutosavePrefs,
  type DebugPrefs,
  type PathPrefs,
  type Preferences
} from './preferences'
import { logMain } from './log'

export class PrefsService {
  private prefs: Preferences = buildDefaultPrefs()
  private prefsPath = ''
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  // Session-only clip dialog folder; each launch starts from preferences.
  private currentClipDir = ''

  get(): Preferences {
    return this.prefs
  }

  getCurrentClipDir(): string {
    return this.currentClipDir
  }

  setCurrentClipDir(dir: string): void {
    this.currentClipDir = dir
  }

  getPrefsPath(): string {
    if (!this.prefsPath) this.prefsPath = join(app.getPath('userData'), 'preferences.json')
    return this.prefsPath
  }

  async load(): Promise<void> {
    const defaults = buildDefaultPrefs()
    this.prefs = structuredClone(defaults)
    try {
      const raw = await readFile(this.getPrefsPath(), 'utf8')
      // Treat an empty prefs file as first-run state.
      if (raw.trim().length === 0) {
        this.seedSessionPaths()
        await this.ensureProjectDirExists()
        return
      }
      const parsed = JSON.parse(raw) as Partial<Preferences>
      // Merge over defaults so new or invalid keys recover on upgrade.
      const savedPaths = (parsed.paths ?? {}) as Partial<PathPrefs>
      this.prefs = {
        window: { ...defaults.window, ...(parsed.window ?? {}) },
        ui: sanitiseUiPrefs(parsed.ui, defaults.ui),
        debug: normaliseDebugPrefs(parsed.debug as (Partial<DebugPrefs> & { enabled?: boolean }) | undefined, defaults.debug),
        toasts: { ...defaults.toasts, ...(parsed.toasts ?? {}) },
        paths: {
          defaultProjectDir:
            typeof savedPaths.defaultProjectDir === 'string' && savedPaths.defaultProjectDir.length > 0
              ? savedPaths.defaultProjectDir
              : defaults.paths.defaultProjectDir,
          defaultClipDir:
            typeof savedPaths.defaultClipDir === 'string' && savedPaths.defaultClipDir.length > 0
              ? savedPaths.defaultClipDir
              : defaults.paths.defaultClipDir,
          stemModelDir: sanitiseStemModelDir(savedPaths.stemModelDir)
        },
        autosave: {
          enabled:
            typeof (parsed.autosave as Partial<AutosavePrefs> | undefined)?.enabled === 'boolean'
              ? ((parsed.autosave as AutosavePrefs).enabled)
              : defaults.autosave.enabled,
          intervalSeconds: clampAutosaveSeconds(
            (parsed.autosave as Partial<AutosavePrefs> | undefined)?.intervalSeconds
          )
        },
        audioOutput: {
          typeName:
            typeof (parsed.audioOutput as Partial<AudioOutputPrefs> | undefined)?.typeName === 'string' &&
            (parsed.audioOutput as AudioOutputPrefs).typeName!.length > 0
              ? (parsed.audioOutput as AudioOutputPrefs).typeName
              : null,
          deviceName:
            typeof (parsed.audioOutput as Partial<AudioOutputPrefs> | undefined)?.deviceName === 'string' &&
            (parsed.audioOutput as AudioOutputPrefs).deviceName!.length > 0
              ? (parsed.audioOutput as AudioOutputPrefs).deviceName
              : null
        },
        keepAwakeMode:
          parsed.keepAwakeMode === 'on' || parsed.keepAwakeMode === 'off'
            ? parsed.keepAwakeMode
            : defaults.keepAwakeMode,
        recentProjects: sanitiseRecentList(parsed.recentProjects),
        stems: sanitiseStemPrefs(parsed.stems, defaults.stems)
      }
    } catch (err) {
      // Bad prefs should not block startup.
      const code = (err as { code?: string }).code
      if (code !== 'ENOENT') {
        logMain('WARN ', 'prefs', 'load failed, using defaults:', err)
      }
    }
    this.seedSessionPaths()
    await this.ensureProjectDirExists()
  }

  private seedSessionPaths(): void {
    this.currentClipDir = this.prefs.paths.defaultClipDir || this.prefs.paths.defaultProjectDir
  }

  // Best-effort: dialogs fall back if the configured project dir cannot be created.
  async ensureProjectDirExists(): Promise<void> {
    const dir = this.prefs.paths.defaultProjectDir
    if (!dir) return
    try {
      await mkdir(dir, { recursive: true })
    } catch (err) {
      logMain('WARN ', 'prefs', `could not create default project dir ${dir}:`, err)
    }
  }

  schedulePrefsSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flushSaveSync()
    }, 400)
  }

  flushSaveSync(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    try {
      const path = this.getPrefsPath()
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(this.prefs, null, 2), 'utf8')
    } catch (err) {
      logMain('WARN ', 'prefs', 'save failed:', err)
    }
  }

  bumpRecentProject(filePath: string): boolean {
    if (typeof filePath !== 'string' || filePath.length === 0) return false
    const key = filePath.toLowerCase()
    const existingIndex = this.prefs.recentProjects.findIndex((p) => p.toLowerCase() === key)
    if (existingIndex === 0) return false
    if (existingIndex > 0) this.prefs.recentProjects.splice(existingIndex, 1)
    this.prefs.recentProjects.unshift(filePath)
    if (this.prefs.recentProjects.length > MAX_RECENT_PROJECTS) {
      this.prefs.recentProjects.length = MAX_RECENT_PROJECTS
    }
    return true
  }

  // Clamp saved bounds so unplugged monitors cannot strand the window off-screen.
  resolveWindowBounds(): { x?: number; y?: number; width: number; height: number } {
    const w = this.prefs.window
    const width = Math.max(900, Math.min(8000, w.width))
    const height = Math.max(600, Math.min(8000, w.height))
    if (typeof w.x !== 'number' || typeof w.y !== 'number') {
      return { width, height }
    }
    const displays = screen.getAllDisplays()
    const onScreen = displays.some((d) => {
      const { x, y, width: dw, height: dh } = d.workArea
      return w.x! >= x && w.y! >= y && w.x! < x + dw && w.y! < y + dh
    })
    return onScreen ? { x: w.x, y: w.y, width, height } : { width, height }
  }

  captureWindowState(win: BrowserWindow | null): void {
    if (!win || win.isDestroyed()) return
    // Preserve unmaximized bounds while maximized.
    const maximized = win.isMaximized()
    this.prefs.window.maximized = maximized
    if (!maximized) {
      // `getNormalBounds()` avoids hidden-titlebar size drift on Windows.
      const b = win.getNormalBounds()
      this.prefs.window.x = b.x
      this.prefs.window.y = b.y
      this.prefs.window.width = b.width
      this.prefs.window.height = b.height
    }
    this.schedulePrefsSave()
  }
}
