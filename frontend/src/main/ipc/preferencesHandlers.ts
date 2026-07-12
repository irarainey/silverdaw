// Preferences IPC handlers: UI panel sizes, developer/debug gates, quality-of-life
// (toasts + default paths), folder picker, autosave config, and audio output
// selection. All prefs state and save scheduling go through PrefsService.
// Registered from main/index.ts.

import { ipcMain, dialog, type BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { getDefaultDebugLogDirectory } from '../preferences'
import type {
  AudioOutputPrefs,
  AutosavePrefs,
  DebugPrefs,
  PathPrefs,
  ToastPrefs
} from '../preferences'
import type { MidiDeckSelection, MidiDevicePreferences } from '../../shared/types'
import { clampAutosaveSeconds, sanitiseStemPrefs, sanitiseBrakePrefs, sanitiseBackspinPrefs, sanitiseUiPrefs } from '../preferences'
import type { PrefsService } from '../prefsService'

export interface PreferencesHandlersContext {
  getMainWindow(): BrowserWindow | null
  prefs: PrefsService
  getStartupLoggingEnabled(): boolean
  getStartupDevToolsEnabled(): boolean
}

export function registerPreferencesHandlers(ctx: PreferencesHandlersContext): void {
  const { prefs } = ctx

  ipcMain.handle(IPC.prefs.getUi, () => prefs.get().ui)

  // Preferences-dialog saves should be durable immediately. The renderer-supplied
  // partial is validated per-field before merging so it cannot corrupt the layout.
  ipcMain.on(IPC.prefs.setUi, (_evt, partial: unknown) => {
    const p = prefs.get()
    p.ui = sanitiseUiPrefs(partial, p.ui)
    prefs.flushSaveSync()
  })

  // ─── Developer preferences ───────────────────────────────────────────────
  // Startup snapshots gate logger init, backend env, and DevTools access.

  ipcMain.handle(IPC.debug.getStartupPrefs, () => ({
    loggingEnabled: ctx.getStartupLoggingEnabled(),
    devToolsEnabled: ctx.getStartupDevToolsEnabled(),
    logDirectory: prefs.get().debug.logDirectory
  }))
  ipcMain.handle(IPC.debug.getPrefs, () => ({ ...prefs.get().debug }))
  ipcMain.on(IPC.debug.setPrefs, (_evt, partial: unknown) => {
    if (!partial || typeof partial !== 'object') return
    const p = partial as Partial<DebugPrefs>
    const current = prefs.get().debug
    const next: DebugPrefs = { ...current }
    if (typeof p.loggingEnabled === 'boolean') next.loggingEnabled = p.loggingEnabled
    if (typeof p.devToolsEnabled === 'boolean') next.devToolsEnabled = p.devToolsEnabled
    if (typeof p.logDirectory === 'string') {
      const trimmed = p.logDirectory.trim()
      next.logDirectory = trimmed.length > 0 ? trimmed : getDefaultDebugLogDirectory()
    }
    if (
      next.loggingEnabled === current.loggingEnabled &&
      next.devToolsEnabled === current.devToolsEnabled &&
      next.logDirectory === current.logDirectory
    ) {
      return
    }
    prefs.get().debug = next
    // These prefs only apply after restart, so persist synchronously.
    prefs.flushSaveSync()
  })

  // ─── Quality-of-life preferences (toasts, default paths) ────────────────
  ipcMain.handle(IPC.prefs.getQol, () => ({
    toasts: { ...prefs.get().toasts },
    paths: { ...prefs.get().paths }
  }))

  ipcMain.on(IPC.prefs.setQol, (_evt, partial: unknown) => {
    if (!partial || typeof partial !== 'object') return
    const p = partial as {
      toasts?: Partial<ToastPrefs>
      paths?: Partial<PathPrefs>
    }
    const store = prefs.get()
    if (p.toasts && typeof p.toasts.enabled === 'boolean') {
      store.toasts = { ...store.toasts, enabled: p.toasts.enabled }
    }
    if (p.paths) {
      const nextPaths: PathPrefs = { ...store.paths }
      if (typeof p.paths.defaultProjectDir === 'string' && p.paths.defaultProjectDir.length > 0) {
        nextPaths.defaultProjectDir = p.paths.defaultProjectDir
      }
      if (typeof p.paths.defaultClipDir === 'string' && p.paths.defaultClipDir.length > 0) {
        nextPaths.defaultClipDir = p.paths.defaultClipDir
        // Apply the new default immediately for this session.
        prefs.setCurrentClipDir(p.paths.defaultClipDir)
      }
      store.paths = nextPaths
      // Best-effort; failures fall back in the dialog.
      void prefs.ensureProjectDirExists()
    }
    prefs.flushSaveSync()
  })

  ipcMain.handle(
    IPC.prefs.chooseDirectory,
    async (_evt, args: unknown): Promise<string | null> => {
      const win = ctx.getMainWindow()
      if (!win) return null
      const a = (args ?? {}) as { title?: string; defaultPath?: string }
      const result = await dialog.showOpenDialog(win, {
        title: typeof a.title === 'string' ? a.title : 'Choose Folder',
        defaultPath: typeof a.defaultPath === 'string' ? a.defaultPath : undefined,
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0]
    }
  )

  // ─── Autosave preferences ───────────────────────────────────────────────
  ipcMain.handle(
    IPC.prefs.getAutosaveConfig,
    (): { enabled: boolean; intervalSeconds: number } => ({ ...prefs.get().autosave })
  )

  ipcMain.on(IPC.prefs.setAutosaveConfig, (_evt, partial: unknown) => {
    if (!partial || typeof partial !== 'object') return
    const p = partial as Partial<AutosavePrefs>
    const store = prefs.get()
    let changed = false
    if (typeof p.enabled === 'boolean' && p.enabled !== store.autosave.enabled) {
      store.autosave = { ...store.autosave, enabled: p.enabled }
      changed = true
    }
    if (typeof p.intervalSeconds === 'number' && Number.isFinite(p.intervalSeconds)) {
      const clamped = clampAutosaveSeconds(p.intervalSeconds)
      if (clamped !== store.autosave.intervalSeconds) {
        store.autosave = { ...store.autosave, intervalSeconds: clamped }
        changed = true
      }
    }
    if (changed) prefs.schedulePrefsSave()
  })

  // ─── Audio output device preferences ────────────────────────────────────
  // Persist only backend-acknowledged selections; runtime state stays in the renderer.
  ipcMain.handle(
    IPC.prefs.getAudioOutput,
    (): { typeName: string | null; deviceName: string | null } => ({ ...prefs.get().audioOutput })
  )

  ipcMain.on(IPC.prefs.setAudioOutput, (_evt, partial: unknown) => {
    if (!partial || typeof partial !== 'object') return
    const p = partial as Partial<AudioOutputPrefs>
    const store = prefs.get()
    const nextTypeName = typeof p.typeName === 'string' && p.typeName.length > 0 ? p.typeName : null
    const nextDeviceName =
      typeof p.deviceName === 'string' && p.deviceName.length > 0 ? p.deviceName : null
    if (
      store.audioOutput.typeName === nextTypeName &&
      store.audioOutput.deviceName === nextDeviceName
    ) {
      return
    }
    store.audioOutput = { typeName: nextTypeName, deviceName: nextDeviceName }
    prefs.schedulePrefsSave()
  })

  // ─── Per-device output keep-awake toggles (on / off) ────────────────────
  ipcMain.handle(
    IPC.prefs.getKeepAwakeByDevice,
    (): Record<string, boolean> => ({ ...prefs.get().keepAwakeByDevice })
  )

  ipcMain.on(IPC.prefs.setKeepAwakeForDevice, (_evt, deviceName: unknown, enabled: unknown) => {
    if (typeof deviceName !== 'string') return
    const name = deviceName.trim()
    if (name.length === 0) return
    if (typeof enabled !== 'boolean') return
    const store = prefs.get()
    const next = { ...store.keepAwakeByDevice }
    // Off is the implicit default — clear the entry rather than store `false`.
    if (enabled) {
      if (next[name] === true) return
      next[name] = true
    } else {
      if (!(name in next)) return
      delete next[name]
    }
    store.keepAwakeByDevice = next
    prefs.schedulePrefsSave()
  })

  ipcMain.handle(
    IPC.prefs.getEnabledMidiInputs,
    (): Record<string, boolean> => ({ ...prefs.get().enabledMidiInputs })
  )

  ipcMain.on(IPC.prefs.setMidiInputEnabled, (_evt, identifier: unknown, enabled: unknown) => {
    if (typeof identifier !== 'string' || typeof enabled !== 'boolean') return
    const key = identifier.trim()
    if (key.length === 0) return
    const next = { ...prefs.get().enabledMidiInputs }
    if (enabled) next[key] = true
    else delete next[key]
    prefs.get().enabledMidiInputs = next
    prefs.schedulePrefsSave()
  })

  ipcMain.handle(
    IPC.prefs.getMidiDeckSelections,
    (): Record<string, MidiDeckSelection> => ({ ...prefs.get().midiDeckSelections })
  )

  ipcMain.on(
    IPC.prefs.setMidiDeckSelection,
    (_evt, identifier: unknown, selection: unknown) => {
      if (typeof identifier !== 'string' || !selection || typeof selection !== 'object') return
      const key = identifier.trim()
      const candidate = selection as Partial<MidiDeckSelection>
      if (
        key.length === 0 ||
        typeof candidate.deck1Enabled !== 'boolean' ||
        typeof candidate.deck2Enabled !== 'boolean'
      ) {
        return
      }
      const current = prefs.get().midiDeckSelections[key]
      if (
        current?.deck1Enabled === candidate.deck1Enabled &&
        current.deck2Enabled === candidate.deck2Enabled
      ) {
        return
      }
      prefs.get().midiDeckSelections = {
        ...prefs.get().midiDeckSelections,
        [key]: {
          deck1Enabled: candidate.deck1Enabled,
          deck2Enabled: candidate.deck2Enabled
        }
      }
      prefs.schedulePrefsSave()
    }
  )

  ipcMain.handle(
    IPC.prefs.getMidiDevicePreferences,
    (): Record<string, MidiDevicePreferences> => ({ ...prefs.get().midiDevicePreferences })
  )

  ipcMain.on(
    IPC.prefs.setMidiDevicePreferences,
    (_evt, identifier: unknown, preferences: unknown) => {
      if (typeof identifier !== 'string' || !preferences || typeof preferences !== 'object') return
      const key = identifier.trim()
      const candidate = preferences as Partial<MidiDevicePreferences>
      if (
        key.length === 0 ||
        typeof candidate.scrubAudioEnabled !== 'boolean' ||
        (candidate.crossfaderDirection !== 'leftToRight' &&
          candidate.crossfaderDirection !== 'rightToLeft')
      ) {
        return
      }
      const current = prefs.get().midiDevicePreferences[key]
      if (
        current?.scrubAudioEnabled === candidate.scrubAudioEnabled &&
        current.crossfaderDirection === candidate.crossfaderDirection
      ) {
        return
      }
      prefs.get().midiDevicePreferences = {
        ...prefs.get().midiDevicePreferences,
        [key]: {
          scrubAudioEnabled: candidate.scrubAudioEnabled,
          crossfaderDirection: candidate.crossfaderDirection
        }
      }
      prefs.schedulePrefsSave()
    }
  )

  // ─── Stem-separation preferences (GPU intent) ───────────────────────────
  ipcMain.handle(IPC.prefs.getStems, () => ({ ...prefs.get().stems }))

  ipcMain.handle(IPC.prefs.setStems, (_evt, partial: unknown) => {
    const store = prefs.get()
    const next = sanitiseStemPrefs(partial, store.stems)
    const cur = store.stems
    // Persist when ANY stem preference changed. Comparing every key (not just
    // useGpu/quality) is essential: the cleanup toggles are saved on their own,
    // so a guard that ignored them silently dropped enhance* changes.
    const unchanged = (Object.keys(next) as (keyof typeof next)[]).every((k) => next[k] === cur[k])
    if (unchanged) return
    store.stems = next
    prefs.flushSaveSync()
  })

  // ─── Turntable-brake defaults (duration + curve presets) ────────────────
  ipcMain.handle(IPC.prefs.getBrake, () => ({ ...prefs.get().brake }))

  ipcMain.on(IPC.prefs.setBrake, (_evt, partial: unknown) => {
    const store = prefs.get()
    const next = sanitiseBrakePrefs(partial, store.brake)
    if (next.duration === store.brake.duration && next.curve === store.brake.curve) return
    store.brake = next
    prefs.flushSaveSync()
  })

  // ─── Turntable-backspin defaults (duration + intensity presets) ─────────
  ipcMain.handle(IPC.prefs.getBackspin, () => ({ ...prefs.get().backspin }))

  ipcMain.on(IPC.prefs.setBackspin, (_evt, partial: unknown) => {
    const store = prefs.get()
    const next = sanitiseBackspinPrefs(partial, store.backspin)
    if (next.duration === store.backspin.duration && next.intensity === store.backspin.intensity) return
    store.backspin = next
    prefs.flushSaveSync()
  })
}
