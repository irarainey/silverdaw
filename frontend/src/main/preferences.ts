import { app } from 'electron'
import { dirname, join, resolve as pathResolve } from 'node:path'
import type { DebugPreferences, SkipButtonTarget, WaveformDisplayMode } from '../shared/types'

export interface WindowPrefs {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

export interface UiPrefs {
  trackHeaderWidth: number
  libraryPanelHeight: number
  followPlayback: boolean
  showLibraryTileImages: boolean
  /** Auto-warp library drops to project BPM when source BPM is usable. */
  matchProjectTempoOnDrop: boolean
  /** Default `targetSampleRate` for new projects; only 44 100 and 48 000 are accepted. */
  defaultProjectSampleRate: number
  skipButtonTarget: SkipButtonTarget
  waveformDisplayMode: WaveformDisplayMode
  libraryPanelCollapsed: boolean
}

export type DebugPrefs = DebugPreferences

export interface ToastPrefs {
  enabled: boolean
}

// Default dialog folders never grant audio read access; trusted picks still drive the allow-list.
export interface PathPrefs {
  defaultProjectDir: string
  defaultClipDir: string
}

// Renderer owns autosave timing; main owns the project-scoped files.
export interface AutosavePrefs {
  enabled: boolean
  /** Clamped 5..600 so corrupt prefs cannot spam autosaves. */
  intervalSeconds: number
}

// Persisted output device is passed at backend spawn; unavailable devices fall back at runtime.
export interface AudioOutputPrefs {
  typeName: string | null
  deviceName: string | null
}

export interface Preferences {
  window: WindowPrefs
  ui: UiPrefs
  debug: DebugPrefs
  toasts: ToastPrefs
  paths: PathPrefs
  autosave: AutosavePrefs
  audioOutput: AudioOutputPrefs
  /** MRU `.silverdaw` paths, newest first, capped and case-insensitive. */
  recentProjects: string[]
}

export const MAX_RECENT_PROJECTS = 10
export const AUTOSAVE_MIN_SECONDS = 5
export const AUTOSAVE_MAX_SECONDS = 600
export const AUTOSAVE_DEFAULT_SECONDS = 30

// `app.getPath` is only safe after `app.whenReady`, so defaults are lazy.
function getApplicationDirectory(): string {
  return app.isPackaged ? dirname(app.getPath('exe')) : pathResolve(__dirname, '..', '..', '..')
}

export function getDefaultDebugLogDirectory(): string {
  return join(getApplicationDirectory(), 'debug')
}

export function buildDefaultPrefs(): Preferences {
  const home = app.getPath('home')
  // Prefer Music/Silverdaw, falling back to home when Music is unavailable.
  let musicDir = ''
  try {
    musicDir = app.getPath('music')
  } catch {
    musicDir = ''
  }
  const defaultProjectDir = musicDir ? join(musicDir, 'Silverdaw') : join(home, 'Silverdaw')
  const defaultClipDir = musicDir || defaultProjectDir
  return {
    window: { width: 1400, height: 900, maximized: false },
    ui: {
      trackHeaderWidth: 175,
      libraryPanelHeight: 180,
      followPlayback: true,
      showLibraryTileImages: true,
      matchProjectTempoOnDrop: true,
      defaultProjectSampleRate: 44100,
      skipButtonTarget: 'timelineEnds',
      waveformDisplayMode: 'summary',
      libraryPanelCollapsed: false
    },
    debug: {
      loggingEnabled: false,
      devToolsEnabled: false,
      logDirectory: getDefaultDebugLogDirectory()
    },
    toasts: { enabled: true },
    paths: { defaultProjectDir, defaultClipDir },
    autosave: { enabled: true, intervalSeconds: AUTOSAVE_DEFAULT_SECONDS },
    audioOutput: { typeName: null, deviceName: null },
    recentProjects: []
  }
}

export function normaliseDebugPrefs(saved: Partial<DebugPrefs> & { enabled?: boolean } | undefined, defaults: DebugPrefs): DebugPrefs {
  const legacyEnabled = typeof saved?.enabled === 'boolean' ? saved.enabled : undefined
  const hasSplitFlags =
    typeof saved?.loggingEnabled === 'boolean' ||
    typeof saved?.devToolsEnabled === 'boolean'
  const loggingEnabled =
    typeof saved?.loggingEnabled === 'boolean'
      ? saved.loggingEnabled
      : hasSplitFlags
        ? defaults.loggingEnabled
        : legacyEnabled ?? defaults.loggingEnabled
  const devToolsEnabled =
    typeof saved?.devToolsEnabled === 'boolean'
      ? saved.devToolsEnabled
      : hasSplitFlags
        ? defaults.devToolsEnabled
        : legacyEnabled ?? defaults.devToolsEnabled
  const savedLogDirectory = typeof saved?.logDirectory === 'string' ? saved.logDirectory.trim() : ''
  const logDirectory = savedLogDirectory.length > 0 ? savedLogDirectory : defaults.logDirectory
  return { loggingEnabled, devToolsEnabled, logDirectory }
}

export function clampAutosaveSeconds(input: unknown): number {
  const value = typeof input === 'number' && Number.isFinite(input) ? input : AUTOSAVE_DEFAULT_SECONDS
  if (value < AUTOSAVE_MIN_SECONDS) return AUTOSAVE_MIN_SECONDS
  if (value > AUTOSAVE_MAX_SECONDS) return AUTOSAVE_MAX_SECONDS
  return Math.round(value)
}

export function sanitiseRecentList(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of input) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed.length === 0) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
    if (out.length >= MAX_RECENT_PROJECTS) break
  }
  return out
}
