// FILE-SIZE EXCEPTION (justified): Electron main entry. Self-contained IPC groups
// and leaf concerns are extracted — audio dialogs/reads/transcode (ipc/audioHandlers),
// autosave filesystem IPCs (ipc/autosaveHandlers), bridge-port resolution (bridgePort),
// plus audioMetadata, audioPaths, preferences, autosaveStore. The residual is the
// stateful singleton core — window/backend lifecycle plus the prefs/window/project IPC
// handlers that all read and mutate shared singletons (the live `prefs` object,
// mainWindow, schedule/flush save timers). Threading those into a per-handler context
// bag would shift coupling rather than reduce it, so they stay together until a
// dedicated preferences service owns that state.
import { app, BrowserWindow, Menu, ipcMain, nativeTheme, dialog, shell, screen } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile, mkdir } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve as pathResolve } from 'node:path'
import { closeLogs, getSessionDir, initLogs, logMain, logRendererLine, type LogLevel } from './log'
import { tmpdir } from 'node:os'
import { IPC, type BackendStatus } from '../shared/ipc-channels'
import { BackendSupervisor } from './backendSupervisor'
import {
  DEFAULT_BRIDGE_PORT,
  findFreeBridgePort,
  isBridgePortEnvOverridden,
  resolveBridgePort
} from './bridgePort'
import { registerAudioHandlers } from './ipc/audioHandlers'
import { registerAutosaveHandlers } from './ipc/autosaveHandlers'
import { registerIssuedPath } from './audioPaths'
import {
  AUTOSAVE_DEFAULT_SECONDS,
  MAX_RECENT_PROJECTS,
  buildDefaultPrefs,
  clampAutosaveSeconds,
  getDefaultDebugLogDirectory,
  normaliseDebugPrefs,
  sanitiseRecentList,
  type AudioOutputPrefs,
  type AutosavePrefs,
  type DebugPrefs,
  type PathPrefs,
  type Preferences,
  type ToastPrefs,
  type UiPrefs
} from './preferences'

// ─── Theme / colours (kept in sync with the renderer Tailwind palette) ──────
const COLOUR_BG = '#18181b' // zinc-900


let backendSupervisor: BackendSupervisor | null = null
let mainWindow: BrowserWindow | null = null
// Set after the renderer's unsaved-changes guard allows close.
let userConfirmedClose = false

// ─── Backend bridge port ────────────────────────────────────────────────────
// Main owns the dynamic loopback port and passes it to backend/renderer.
let bridgePort = resolveBridgePort()
const bridgePortEnvOverridden = isBridgePortEnvOverridden()

// ─── Backend bridge AUTH token ──────────────────────────────────────────────
// Loopback is not a trust boundary; keep the token out of argv/HTML.
const bridgeToken = randomBytes(32).toString('hex')

// ─── Persisted preferences (window state + UI panel sizes) ──────────────────
// Debounced JSON writes avoid hammering disk during resize/move.

let prefs: Preferences = {
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
  debug: { loggingEnabled: false, devToolsEnabled: false, logDirectory: '' },
  toasts: { enabled: true },
  paths: { defaultProjectDir: '', defaultClipDir: '' },
  autosave: { enabled: true, intervalSeconds: AUTOSAVE_DEFAULT_SECONDS },
  audioOutput: { typeName: null, deviceName: null },
  recentProjects: []
}
let prefsPath = ''
let prefsSaveTimer: ReturnType<typeof setTimeout> | null = null

// Session-only clip dialog folder; each launch starts from preferences.
let currentClipDir = ''

// Startup-only debug gates; preference changes apply next launch.
let startupLoggingEnabled = false
let startupDevToolsEnabled = false

function getPrefsPath(): string {
  if (!prefsPath) prefsPath = join(app.getPath('userData'), 'preferences.json')
  return prefsPath
}

async function loadPreferences(): Promise<void> {
  const defaults = buildDefaultPrefs()
  prefs = structuredClone(defaults)
  try {
    const raw = await readFile(getPrefsPath(), 'utf8')
    // Treat an empty prefs file as first-run state.
    if (raw.trim().length === 0) {
      seedSessionPaths()
      await ensureProjectDirExists()
      return
    }
    const parsed = JSON.parse(raw) as Partial<Preferences>
    // Merge over defaults so new or invalid keys recover on upgrade.
    const savedPaths = (parsed.paths ?? {}) as Partial<PathPrefs>
    prefs = {
      window: { ...defaults.window, ...(parsed.window ?? {}) },
      ui: { ...defaults.ui, ...(parsed.ui ?? {}) },
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
            : defaults.paths.defaultClipDir
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
      recentProjects: sanitiseRecentList(parsed.recentProjects)
    }
    // Clamp persisted sample rate to the supported whitelist.
    if (prefs.ui.defaultProjectSampleRate !== 44100 && prefs.ui.defaultProjectSampleRate !== 48000) {
      prefs.ui.defaultProjectSampleRate = 44100
    }
    if (prefs.ui.skipButtonTarget !== 'timelineEnds' && prefs.ui.skipButtonTarget !== 'markers') {
      prefs.ui.skipButtonTarget = 'timelineEnds'
    }
    if (prefs.ui.waveformDisplayMode !== 'summary' && prefs.ui.waveformDisplayMode !== 'stereo') {
      prefs.ui.waveformDisplayMode = 'summary'
    }
    if (typeof prefs.ui.libraryPanelCollapsed !== 'boolean') {
      prefs.ui.libraryPanelCollapsed = false
    }
  } catch (err) {
    // Bad prefs should not block startup.
    const code = (err as { code?: string }).code
    if (code !== 'ENOENT') {
      console.warn('[prefs] load failed, using defaults:', err)
    }
  }
  seedSessionPaths()
  await ensureProjectDirExists()
}

function seedSessionPaths(): void {
  currentClipDir = prefs.paths.defaultClipDir || prefs.paths.defaultProjectDir
}

// Best-effort: dialogs fall back if the configured project dir cannot be created.
async function ensureProjectDirExists(): Promise<void> {
  const dir = prefs.paths.defaultProjectDir
  if (!dir) return
  try {
    await mkdir(dir, { recursive: true })
  } catch (err) {
    console.warn('[prefs] could not create default project dir', dir, err)
  }
}

function schedulePrefsSave(): void {
  if (prefsSaveTimer) clearTimeout(prefsSaveTimer)
  prefsSaveTimer = setTimeout(() => {
    prefsSaveTimer = null
    flushPrefsSaveSync()
  }, 400)
}

function flushPrefsSaveSync(): void {
  if (prefsSaveTimer) {
    clearTimeout(prefsSaveTimer)
    prefsSaveTimer = null
  }
  try {
    const path = getPrefsPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(prefs, null, 2), 'utf8')
  } catch (err) {
    console.warn('[prefs] save failed:', err)
  }
}

function bumpRecentProject(filePath: string): boolean {
  if (typeof filePath !== 'string' || filePath.length === 0) return false
  const key = filePath.toLowerCase()
  const existingIndex = prefs.recentProjects.findIndex((p) => p.toLowerCase() === key)
  if (existingIndex === 0) return false
  if (existingIndex > 0) prefs.recentProjects.splice(existingIndex, 1)
  prefs.recentProjects.unshift(filePath)
  if (prefs.recentProjects.length > MAX_RECENT_PROJECTS) {
    prefs.recentProjects.length = MAX_RECENT_PROJECTS
  }
  return true
}

// Clamp saved bounds so unplugged monitors cannot strand the window off-screen.
function resolveWindowBounds(): { x?: number; y?: number; width: number; height: number } {
  const w = prefs.window
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

function captureWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  // Preserve unmaximized bounds while maximized.
  const maximized = mainWindow.isMaximized()
  prefs.window.maximized = maximized
  if (!maximized) {
    // `getNormalBounds()` avoids hidden-titlebar size drift on Windows.
    const b = mainWindow.getNormalBounds()
    prefs.window.x = b.x
    prefs.window.y = b.y
    prefs.window.width = b.width
    prefs.window.height = b.height
  }
  schedulePrefsSave()
}

function resolveBackendExePath(): string {
  const exeName = process.platform === 'win32' ? 'SilverdawBackend.exe' : 'SilverdawBackend'

  // Dev uses the backend build tree; packaged builds use copied resources.
  if (app.isPackaged) {
    return join(process.resourcesPath, 'backend', exeName)
  }
  const buildConfig = process.env['SILVERDAW_BACKEND_CONFIG'] ?? 'Debug'
  return join(__dirname, '..', '..', '..', 'backend', 'build', 'SilverdawBackend_artefacts', buildConfig, exeName)
}

function buildBackendEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Keep AUTH token out of argv; the backend reads it from env.
    SILVERDAW_BRIDGE_TOKEN: bridgeToken,
    // Backend may fall back if the saved device is unavailable.
    ...(prefs.audioOutput.typeName && prefs.audioOutput.deviceName
      ? {
          SILVERDAW_OUTPUT_DEVICE_TYPE: prefs.audioOutput.typeName,
          SILVERDAW_OUTPUT_DEVICE_NAME: prefs.audioOutput.deviceName
        }
      : {}),
    // Export only when logging is enabled; empty env disables backend logger init.
    ...(startupLoggingEnabled ? { SILVERDAW_LOG_DIR: getSessionDir() } : {})
  }
}

function sendBackendStatus(status: BackendStatus): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.backend.status, status)
  }
}

function startBackend(): void {
  backendSupervisor = new BackendSupervisor({
    resolveExePath: resolveBackendExePath,
    buildEnv: buildBackendEnv,
    getPort: () => bridgePort,
    log: (level, scope, message) => logMain(level as LogLevel, scope, message),
    sendStatus: sendBackendStatus
  })
  backendSupervisor.start()
}

function createWindow(): void {
  const bounds = resolveWindowBounds()
  // Icon is optional; Electron falls back cleanly.
  const iconPath = join(app.getAppPath(), 'resources', 'icons', 'icon.ico')
  const icon = existsSync(iconPath) ? iconPath : undefined
  if (!icon) {
    logMain('INFO ', 'main', `no app icon at ${iconPath} — using Electron default`)
  }
  mainWindow = new BrowserWindow({
    // Set bounds after construction to avoid Windows hidden-titlebar DPI drift.
    minWidth: 900,
    minHeight: 600,
    backgroundColor: COLOUR_BG,
    icon,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: undefined,
    trafficLightPosition: { x: 12, y: 11 },
    webPreferences: {
      // Sandboxed renderers require the electron-vite CJS preload bundle.
      preload: join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      // Sandbox stays on because preload only needs safe Electron bridge APIs.
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  // Block reloads because they orphan backend state; gate packaged DevTools shortcuts.
  const RELOAD_KEYS = new Set(['F5', 'F3'])
  const blockDevTools = app.isPackaged && !startupDevToolsEnabled
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const isReloadKey = RELOAD_KEYS.has(input.key) ||
      (input.control && (input.key === 'r' || input.key === 'R')) ||
      (input.meta && (input.key === 'r' || input.key === 'R'))
    if (isReloadKey) {
      event.preventDefault()
      return
    }
    if (blockDevTools) {
      const isDevToolsKey =
        (input.control && input.shift && (input.key === 'i' || input.key === 'I')) ||
        input.key === 'F12'
      if (isDevToolsKey) {
        event.preventDefault()
      }
    }
  })

  // Block SPA navigation so browser history shortcuts do not steal transport keys.
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  // Deny new windows so untrusted content cannot escape our hardened BrowserWindow.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // Auto-open DevTools only in dev when the startup debug gate allows it.
  if (!app.isPackaged && startupDevToolsEnabled) {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow?.webContents.openDevTools({ mode: 'right' })
    })
  }

  // On Windows mixed-DPI setups, a second `setBounds` applies the target display scale.
  if (typeof bounds.x === 'number' && typeof bounds.y === 'number') {
    const rect = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height
    }
    mainWindow.setBounds(rect)
    if (process.platform === 'win32') mainWindow.setBounds(rect)
  } else {
    mainWindow.setSize(bounds.width, bounds.height)
    mainWindow.center()
  }

  // Maximize after applying normal bounds so restore targets the saved size.
  if (prefs.window.maximized) mainWindow.maximize()

  mainWindow.on('resize', captureWindowState)
  mainWindow.on('move', captureWindowState)
  mainWindow.on('maximize', captureWindowState)
  mainWindow.on('unmaximize', captureWindowState)
  mainWindow.on('close', (event) => {
    captureWindowState()
    flushPrefsSaveSync()
    // First close attempt runs the renderer's unsaved-changes guard.
    if (!userConfirmedClose) {
      event.preventDefault()
      mainWindow?.webContents.send(IPC.menu.action, 'app.requestClose')
    }
  })

  // Avoid showing a blank window before the first renderer paint.
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'))
  }
}

function handleMenuAction(action: string): void {
  if (!mainWindow) return
  const wc = mainWindow.webContents

  switch (action) {
    // File
    case 'file.newProject':
      wc.send(IPC.menu.action, action)
      break
    case 'file.openProject':
      wc.send(IPC.menu.action, action)
      break
    case 'file.save':
      wc.send(IPC.menu.action, action)
      break
    case 'file.saveAs':
      wc.send(IPC.menu.action, action)
      break
    case 'file.renameProject':
      wc.send(IPC.menu.action, action)
      break
    case 'file.projectProperties':
      wc.send(IPC.menu.action, action)
      break
    case 'file.addTrack':
      wc.send(IPC.menu.action, action)
      break
    case 'file.exportMixdown':
      wc.send(IPC.menu.action, action)
      break
    case 'file.exit':
      wc.send(IPC.menu.action, action)
      break
    case 'file.exitConfirmed':
    case 'app.confirmClose':
      // Renderer has cleared the unsaved-changes guard.
      userConfirmedClose = true
      BrowserWindow.getAllWindows().forEach((w) => {
        if (!w.isDestroyed()) w.destroy()
      })
      app.exit(0)
      break

    // Edit
    case 'edit.undo':
      // Renderer handles project undo; native text undo stays on keyboard shortcuts.
      wc.send(IPC.menu.action, action)
      break
    case 'edit.redo':
      wc.send(IPC.menu.action, action)
      break
    case 'edit.cut':
      // Renderer can target clips before falling back to native text cut.
      wc.send(IPC.menu.action, action)
      break
    case 'edit.copy':
      wc.send(IPC.menu.action, action)
      break
    case 'edit.paste':
      wc.send(IPC.menu.action, action)
      break
    case 'edit.preferences':
      wc.send(IPC.menu.action, action)
      break
    case 'edit.splitAtPlayhead':
      wc.send(IPC.menu.action, action)
      break
    case 'edit.duplicateClip':
      wc.send(IPC.menu.action, action)
      break
    case 'edit.deleteClip':
      wc.send(IPC.menu.action, action)
      break
    case 'edit.cropProjectToLastClip':
      wc.send(IPC.menu.action, action)
      break

    // View
    case 'view.zoomIn':
    case 'view.zoomOut':
    case 'view.zoomReset':
      wc.send(IPC.menu.action, action)
      break
    case 'view.toggleDevTools':
      if (app.isPackaged && !startupDevToolsEnabled) break
      wc.toggleDevTools()
      break
    case 'view.toggleFullScreen':
      mainWindow.setFullScreen(!mainWindow.isFullScreen())
      break

    // Help
    case 'help.docs':
      void shell.openExternal('https://github.com/irarainey/silverdaw')
      break
    case 'help.reportIssue':
      void shell.openExternal('https://github.com/irarainey/silverdaw/issues/new')
      break
    case 'help.about':
      wc.send(IPC.menu.action, action)
      break

    default:
      if (action.startsWith('file.openRecentByIndex:')) {
        wc.send(IPC.menu.action, action)
        break
      }
      if (action === 'file.clearRecentProjects') {
        wc.send(IPC.menu.action, action)
        break
      }
      if (action.startsWith('view.zoomPreset:')) {
        wc.send(IPC.menu.action, action)
        break
      }
      console.warn('[menu] unknown action:', action)
  }
}

// ─── .silverdaw file association + single-instance lock ────────────────────
// Accept only absolute `.silverdaw` argv paths; warm launches forward to the existing instance.

function extractProjectPathFromArgv(argv: readonly string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (!a || a.startsWith('--') || a.startsWith('-')) continue
    if (!isAbsolute(a)) continue
    if (extname(a).toLowerCase() !== '.silverdaw') continue
    if (!existsSync(a)) continue
    return a
  }
  return null
}

let pendingOpenPath: string | null = extractProjectPathFromArgv(process.argv)

const gotInstanceLock = app.requestSingleInstanceLock()
if (!gotInstanceLock) {
  // Exit synchronously before `whenReady` can double-spawn the backend.
  app.exit(0)
}

app.on('second-instance', (_event, argv) => {
  const filePath = extractProjectPathFromArgv(argv)
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
  if (filePath && mainWindow) {
    mainWindow.webContents.send(IPC.project.openFromPath, filePath)
  }
})

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark'

  // AppUserModelID must be set before the first BrowserWindow on Windows.
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.silverdaw.app')
  }

  // Preferences must load before startup-only logger and DevTools decisions.
  await loadPreferences()
  startupLoggingEnabled = prefs.debug.loggingEnabled === true
  startupDevToolsEnabled = prefs.debug.devToolsEnabled === true

  // Only opted-in diagnostic sessions write cross-layer logs.
  if (startupLoggingEnabled) {
    const defaultLogDir = getDefaultDebugLogDirectory()
    const preferredLogDir = prefs.debug.logDirectory.trim()
    const logParent = preferredLogDir.length > 0 ? preferredLogDir : defaultLogDir
    const userDataFallbackLogDir = join(app.getPath('userData'), 'debug')
    const candidateLogDirs = Array.from(new Set([logParent, defaultLogDir, userDataFallbackLogDir]))
    let sessionDir: string | null = null
    for (const candidate of candidateLogDirs) {
      try {
        sessionDir = initLogs(candidate)
        if (candidate !== logParent) {
          logMain('WARN ', 'main', `preferred log dir failed, fell back to: ${sessionDir}`)
        }
        break
      } catch (err) {
        console.error(`[main] failed to initialise log directory ${candidate}:`, err)
      }
    }
    if (sessionDir) {
      logMain('INFO ', 'main', `session log dir: ${sessionDir}`)
      logMain('INFO ', 'main', `electron=${process.versions.electron} node=${process.versions.node}`)
    } else {
      console.error('[main] failed to initialise file logging; continuing with file logging disabled')
    }
  } else {
    console.log('[main] file logging disabled (Preferences > Developer > Write diagnostic logs is off)')
  }

  Menu.setApplicationMenu(null)

  ipcMain.on(IPC.menu.action, (_evt, action: string) => handleMenuAction(action))

  // Renderer logs are batched into the same session folder as main/backend logs.
  ipcMain.handle(
    IPC.log.appendBatch,
    (_evt, entries: Array<{ level: LogLevel; tag: string; message: string; timestamp: number }>) => {
      if (!Array.isArray(entries)) return
      for (const e of entries) {
        if (!e || typeof e.tag !== 'string' || typeof e.message !== 'string') continue
        logRendererLine(e.level ?? 'INFO ', e.tag, e.message, e.timestamp)
      }
    }
  )

  // Main-selected dynamic backend port.
  ipcMain.handle(IPC.bridge.getPort, () => bridgePort)

  // AUTH token only crosses the trusted preload bridge.
  ipcMain.handle(IPC.bridge.getToken, () => bridgeToken)

  // Watchdog restart keeps the same port/token for reconnect.
  ipcMain.handle(IPC.backend.restart, (_evt, reason: unknown) => {
    backendSupervisor?.requestRestart(typeof reason === 'string' ? reason : 'renderer request')
  })

  ipcMain.handle(IPC.app.getInfo, () => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node
  }))

  // Only http/https URLs may leave the app via the OS browser.
  ipcMain.on(IPC.app.openExternal, (_evt, url: unknown) => {
    if (typeof url !== 'string') return
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return
    void shell.openExternal(parsed.toString())
  })


  registerAudioHandlers({
    getMainWindow: () => mainWindow,
    getCurrentClipDir: () => currentClipDir,
    setCurrentClipDir: (dir) => {
      currentClipDir = dir
    }
  })

  ipcMain.handle(IPC.prefs.getUi, () => prefs.ui)

  ipcMain.on(IPC.window.minimize, () => {
    mainWindow?.minimize()
  })

  ipcMain.on(IPC.window.toggleMaximize, () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })

  ipcMain.on(IPC.window.close, () => {
    mainWindow?.webContents.send(IPC.menu.action, 'app.requestClose')
  })

  // Preferences-dialog saves should be durable immediately.
  ipcMain.on(IPC.prefs.setUi, (_evt, partial: Partial<UiPrefs>) => {
    prefs.ui = { ...prefs.ui, ...partial }
    flushPrefsSaveSync()
  })

  // ─── Developer preferences ───────────────────────────────────────────────
  // Startup snapshots gate logger init, backend env, and DevTools access.

  ipcMain.handle(IPC.debug.getStartupPrefs, () => ({
    loggingEnabled: startupLoggingEnabled,
    devToolsEnabled: startupDevToolsEnabled,
    logDirectory: prefs.debug.logDirectory
  }))
  ipcMain.handle(IPC.debug.getPrefs, () => ({ ...prefs.debug }))
  ipcMain.on(IPC.debug.setPrefs, (_evt, partial: unknown) => {
    if (!partial || typeof partial !== 'object') return
    const p = partial as Partial<DebugPrefs>
    const next: DebugPrefs = { ...prefs.debug }
    if (typeof p.loggingEnabled === 'boolean') next.loggingEnabled = p.loggingEnabled
    if (typeof p.devToolsEnabled === 'boolean') next.devToolsEnabled = p.devToolsEnabled
    if (typeof p.logDirectory === 'string') {
      const trimmed = p.logDirectory.trim()
      next.logDirectory = trimmed.length > 0 ? trimmed : getDefaultDebugLogDirectory()
    }
    if (
      next.loggingEnabled === prefs.debug.loggingEnabled &&
      next.devToolsEnabled === prefs.debug.devToolsEnabled &&
      next.logDirectory === prefs.debug.logDirectory
    ) {
      return
    }
    prefs.debug = next
    // These prefs only apply after restart, so persist synchronously.
    flushPrefsSaveSync()
  })

  // ─── Quality-of-life preferences (toasts, default paths) ────────────────
  ipcMain.handle(IPC.prefs.getQol, () => ({
    toasts: { ...prefs.toasts },
    paths: { ...prefs.paths }
  }))

  ipcMain.on(IPC.prefs.setQol, (_evt, partial: unknown) => {
    if (!partial || typeof partial !== 'object') return
    const p = partial as {
      toasts?: Partial<ToastPrefs>
      paths?: Partial<PathPrefs>
    }
    if (p.toasts && typeof p.toasts.enabled === 'boolean') {
      prefs.toasts = { ...prefs.toasts, enabled: p.toasts.enabled }
    }
    if (p.paths) {
      const nextPaths: PathPrefs = { ...prefs.paths }
      if (typeof p.paths.defaultProjectDir === 'string' && p.paths.defaultProjectDir.length > 0) {
        nextPaths.defaultProjectDir = p.paths.defaultProjectDir
      }
      if (typeof p.paths.defaultClipDir === 'string' && p.paths.defaultClipDir.length > 0) {
        nextPaths.defaultClipDir = p.paths.defaultClipDir
        // Apply the new default immediately for this session.
        currentClipDir = p.paths.defaultClipDir
      }
      prefs.paths = nextPaths
      // Best-effort; failures fall back in the dialog.
      void ensureProjectDirExists()
    }
    flushPrefsSaveSync()
  })

  ipcMain.handle(
    IPC.prefs.chooseDirectory,
    async (_evt, args: unknown): Promise<string | null> => {
      if (!mainWindow) return null
      const a = (args ?? {}) as { title?: string; defaultPath?: string }
      const result = await dialog.showOpenDialog(mainWindow, {
        title: typeof a.title === 'string' ? a.title : 'Choose folder',
        defaultPath: typeof a.defaultPath === 'string' ? a.defaultPath : undefined,
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0]
    }
  )

  // ─── Project file lifecycle ─────────────────────────────────────────────
  // Main owns native project dialogs and the Recent Projects MRU.

  ipcMain.on(IPC.project.setLastPath, (_evt, value: unknown) => {
    if (typeof value !== 'string' || value.length === 0) return
    if (bumpRecentProject(value)) flushPrefsSaveSync()
  })

  ipcMain.handle(IPC.project.fileExists, async (_evt, value: unknown): Promise<boolean> => {
    if (typeof value !== 'string' || value.length === 0) return false
    try {
      await readFile(value, { encoding: null, flag: 'r' })
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle(IPC.project.chooseOpen, async (): Promise<string | null> => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open Silverdaw Project',
      defaultPath: prefs.paths.defaultProjectDir || undefined,
      filters: [{ name: 'Silverdaw project', extensions: ['silverdaw'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(
    IPC.project.chooseSaveAs,
    async (_evt, defaultName: unknown): Promise<string | null> => {
      if (!mainWindow) return null
      const suggested =
        typeof defaultName === 'string' && defaultName.length > 0 ? defaultName : 'Untitled'
      const defaultPath = prefs.paths.defaultProjectDir
        ? join(prefs.paths.defaultProjectDir, `${suggested}.silverdaw`)
        : `${suggested}.silverdaw`
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Silverdaw Project',
        defaultPath,
        filters: [{ name: 'Silverdaw project', extensions: ['silverdaw'] }]
      })
      if (result.canceled || !result.filePath) return null
      return result.filePath
    }
  )

  // Default mixdowns under `mixdown/`; backend creates the folder only when writing.
  ipcMain.handle(
    IPC.mixdown.resolveDefaultPath,
    async (
      _evt,
      projectFilePath: unknown,
      projectName: unknown,
      format: unknown
    ): Promise<string> => {
      const safeName =
        (typeof projectName === 'string' && projectName.trim().length > 0
          ? projectName.trim()
          : 'Untitled')
          // Make the suggested filename valid on Windows.
          .replace(/[\\/:*?"<>|]/g, '_')
      const ext =
        format === 'mp3'
          ? 'mp3'
          : format === 'flac'
            ? 'flac'
            : format === 'aiff'
              ? 'aiff'
              : 'wav'
      const baseDir =
        typeof projectFilePath === 'string' && projectFilePath.length > 0
          ? dirname(projectFilePath)
          : prefs.paths.defaultProjectDir || tmpdir()
      return join(baseDir, 'mixdown', `${safeName}.${ext}`)
    }
  )

  ipcMain.handle(
    IPC.mixdown.chooseSaveAs,
    async (_evt, defaultPath: unknown, format: unknown): Promise<string | null> => {
      if (!mainWindow) return null
      const suggestedDefaultPath =
        typeof defaultPath === 'string' && defaultPath.length > 0
          ? defaultPath
          : join(prefs.paths.defaultProjectDir || tmpdir(), 'mixdown', 'Mixdown.wav')
      const ext =
        format === 'mp3'
          ? 'mp3'
          : format === 'flac'
            ? 'flac'
            : format === 'aiff'
              ? 'aiff'
              : 'wav'
      const filters =
        ext === 'mp3'
          ? [{ name: 'MP3 audio', extensions: ['mp3'] }]
          : ext === 'flac'
            ? [{ name: 'FLAC audio', extensions: ['flac'] }]
            : ext === 'aiff'
              ? [{ name: 'AIFF audio', extensions: ['aiff', 'aif'] }]
              : [{ name: 'WAV audio', extensions: ['wav'] }]
      try {
        await mkdir(dirname(suggestedDefaultPath), { recursive: true })
      } catch {
        // Best-effort: missing volume falls back to the dialog's last cwd.
      }
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Export Mixdown',
        defaultPath: suggestedDefaultPath,
        filters
      })
      if (result.canceled || !result.filePath) return null
      return result.filePath
    }
  )

  // Extra overwrite prompt for manually typed mixdown paths.
  ipcMain.handle(
    IPC.mixdown.confirmOverwrite,
    async (_evt, filePath: unknown): Promise<'overwrite' | 'cancel' | 'not-found'> => {
      if (typeof filePath !== 'string' || filePath.length === 0) return 'not-found'
      if (!existsSync(filePath)) return 'not-found'
      if (!mainWindow) return 'cancel'
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Overwrite', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Replace existing file?',
        message: `"${basename(filePath)}" already exists.`,
        detail: 'Choose Overwrite to replace it, or Cancel to edit the filename.'
      })
      return result.response === 0 ? 'overwrite' : 'cancel'
    }
  )

  // Pre-register project audio paths; `registerIssuedPath` still enforces the allow-list.
  ipcMain.handle(IPC.project.prepareOpen, async (_evt, filePath: unknown): Promise<boolean> => {
    if (typeof filePath !== 'string' || filePath.length === 0) return false
    if (extname(filePath).toLowerCase() !== '.silverdaw') return false
    try {
      const content = await readFile(filePath, 'utf8')
      // Project JSON may contain `filePath` anywhere in the tree.
      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch (parseErr) {
        console.warn('[project:prepareOpen] malformed project JSON:', filePath, parseErr)
        return false
      }
      const visit = (node: unknown): void => {
        if (Array.isArray(node)) {
          for (const item of node) visit(item)
          return
        }
        if (node !== null && typeof node === 'object') {
          for (const [k, v] of Object.entries(node)) {
            if (k === 'filePath' && typeof v === 'string' && v.length > 0) {
              registerIssuedPath(v)
            } else {
              visit(v)
            }
          }
        }
      }
      visit(parsed)
      return true
    } catch (err) {
      console.warn('[project:prepareOpen] could not read project file:', filePath, err)
      return false
    }
  })

  // Consume a pending launch path once so renderer reloads do not reopen it.
  ipcMain.handle(IPC.project.consumePendingOpenPath, (): string | null => {
    const p = pendingOpenPath
    pendingOpenPath = null
    return p
  })

  // ─── Recent projects (MRU) ─────────────────────────────────────────────
  ipcMain.handle(IPC.prefs.getRecentProjects, (): string[] => [...prefs.recentProjects])

  ipcMain.on(IPC.prefs.removeRecentProject, (_evt, value: unknown) => {
    if (typeof value !== 'string' || value.length === 0) return
    const key = value.toLowerCase()
    const before = prefs.recentProjects.length
    prefs.recentProjects = prefs.recentProjects.filter((p) => p.toLowerCase() !== key)
    if (prefs.recentProjects.length !== before) flushPrefsSaveSync()
  })

  ipcMain.on(IPC.prefs.clearRecentProjects, () => {
    if (prefs.recentProjects.length === 0) return
    prefs.recentProjects = []
    flushPrefsSaveSync()
  })

  // ─── Autosave preferences ───────────────────────────────────────────────
  ipcMain.handle(
    IPC.prefs.getAutosaveConfig,
    (): { enabled: boolean; intervalSeconds: number } => ({ ...prefs.autosave })
  )

  ipcMain.on(IPC.prefs.setAutosaveConfig, (_evt, partial: unknown) => {
    if (!partial || typeof partial !== 'object') return
    const p = partial as Partial<AutosavePrefs>
    let changed = false
    if (typeof p.enabled === 'boolean' && p.enabled !== prefs.autosave.enabled) {
      prefs.autosave = { ...prefs.autosave, enabled: p.enabled }
      changed = true
    }
    if (typeof p.intervalSeconds === 'number' && Number.isFinite(p.intervalSeconds)) {
      const clamped = clampAutosaveSeconds(p.intervalSeconds)
      if (clamped !== prefs.autosave.intervalSeconds) {
        prefs.autosave = { ...prefs.autosave, intervalSeconds: clamped }
        changed = true
      }
    }
    if (changed) schedulePrefsSave()
  })

  // ─── Audio output device preferences ────────────────────────────────────
  // Persist only backend-acknowledged selections; runtime state stays in the renderer.
  ipcMain.handle(
    IPC.prefs.getAudioOutput,
    (): { typeName: string | null; deviceName: string | null } => ({ ...prefs.audioOutput })
  )

  ipcMain.on(IPC.prefs.setAudioOutput, (_evt, partial: unknown) => {
    if (!partial || typeof partial !== 'object') return
    const p = partial as Partial<AudioOutputPrefs>
    const nextTypeName = typeof p.typeName === 'string' && p.typeName.length > 0 ? p.typeName : null
    const nextDeviceName =
      typeof p.deviceName === 'string' && p.deviceName.length > 0 ? p.deviceName : null
    if (
      prefs.audioOutput.typeName === nextTypeName &&
      prefs.audioOutput.deviceName === nextDeviceName
    ) {
      return
    }
    prefs.audioOutput = { typeName: nextTypeName, deviceName: nextDeviceName }
    schedulePrefsSave()
  })

  registerAutosaveHandlers()

  // Peaks reads are confined to the backend-produced cache directory.
  const peaksCacheDir = pathResolve(app.getPath('appData'), 'Silverdaw', 'peaks')
  ipcMain.handle(IPC.peaks.readCacheFile, async (_evt, value: unknown): Promise<ArrayBuffer | null> => {
    if (typeof value !== 'string' || value.length === 0) return null
    const canonical = pathResolve(value)
    if (!canonical.toLowerCase().startsWith(peaksCacheDir.toLowerCase() + '\\') &&
        canonical.toLowerCase() !== peaksCacheDir.toLowerCase()) {
      console.warn('[peaks:readCacheFile] refused path outside cache dir:', canonical)
      return null
    }
    try {
      const buf = await readFile(canonical)
      // Structured clone should receive a clean contiguous buffer.
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    } catch (err) {
      console.warn('[peaks:readCacheFile] read failed:', canonical, err)
      return null
    }
  })

  // Honour explicit dev port; otherwise probe past leftover processes.
  if (!bridgePortEnvOverridden) {
    const free = await findFreeBridgePort(DEFAULT_BRIDGE_PORT, 20)
    if (free === null) {
      const msg =
        `Could not find a free TCP port for the audio engine in the range ` +
        `${DEFAULT_BRIDGE_PORT}–${DEFAULT_BRIDGE_PORT + 19}. ` +
        `Close any other running Silverdaw windows and try again.`
      // Renderer does not exist yet, so use a native error dialog.
      dialog.showErrorBox('Unable to start Silverdaw', msg)
      app.exit(1)
      return
    }
    if (free !== bridgePort) {
      console.log(`[main] port ${bridgePort} busy; using ${free} instead`)
    }
    bridgePort = free
  }

  // Defer backend spawn until after initial window creation to protect first paint.
  createWindow()
  setImmediate(startBackend)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  backendSupervisor?.kill()
  backendSupervisor = null
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  backendSupervisor?.kill()
  backendSupervisor = null
  // Make sure any pending debounced write hits disk before we exit.
  flushPrefsSaveSync()
  logMain('INFO ', 'main', 'before-quit')
  closeLogs()
})
