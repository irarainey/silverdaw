// Electron main entry point (bootstrap). Owns the window/backend lifecycle and
// session-scoped singletons (mainWindow, bridge port/token, pending open path,
// startup debug gates) and wires them into the extracted modules: PrefsService
// (prefs state + persistence), window/menu, and the per-domain IPC handler
// groups under ipc/. Backend supervision lives in backendSupervisor; bridge-port
// resolution in bridgePort.

import { app, BrowserWindow, Menu, ipcMain, nativeTheme, dialog } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { extname, isAbsolute, join } from 'node:path'
import { closeLogs, getSessionDir, initLogs, logMain, type LogLevel, closeDiagnostics, getDiagnosticsDir, initDiagnostics, logDiag } from './log'
import { IPC, type BackendStatus } from '../shared/ipc-channels'
import { BackendSupervisor } from './backendSupervisor'
import {
  DEFAULT_BRIDGE_PORT,
  findFreeBridgePort,
  isBridgePortEnvOverridden,
  resolveBridgePort
} from './bridgePort'
import { getDefaultDebugLogDirectory } from './preferences'
import { PrefsService } from './prefsService'
import { createWindow } from './window'
import { applyChromiumSecuritySwitches, hardenDefaultSession } from './sessionSecurity'
import { destroyAllWindowsAndExit, handleMenuAction } from './menu'
import { registerAudioHandlers } from './ipc/audioHandlers'
import { registerAutosaveHandlers } from './ipc/autosaveHandlers'
import { registerWindowHandlers } from './ipc/windowHandlers'
import { registerPreferencesHandlers } from './ipc/preferencesHandlers'
import { registerProjectHandlers } from './ipc/projectHandlers'
import { registerMixdownHandlers } from './ipc/mixdownHandlers'
import { registerRuntimeHandlers } from './ipc/runtimeHandlers'
import { registerPeaksHandlers } from './ipc/peaksHandlers'
import { registerStemHandlers } from './ipc/stemHandlers'

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

// Persisted preferences (window state, UI sizes, paths, MRU) live in PrefsService.
const prefs = new PrefsService()

// Startup-only debug gates; preference changes apply next launch.
let startupLoggingEnabled = false
let startupDevToolsEnabled = false

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
  const { audioOutput, keepAwakeByDevice } = prefs.get()
  const hasPreferredDevice = Boolean(audioOutput.typeName && audioOutput.deviceName)
  // The device is opened during backend startup, before the renderer can push the per-device
  // keep-awake toggle. Pass the preferred device's persisted setting at spawn so keep-alive
  // energy flows from the very first audio block — a cold sleep-prone DAC otherwise latches
  // muted on the initial silence and only wakes on the first play (an audible click).
  const preferredDeviceKeepAwake =
    hasPreferredDevice && keepAwakeByDevice[audioOutput.deviceName as string] === true
  return {
    ...process.env,
    // Keep AUTH token out of argv; the backend reads it from env.
    SILVERDAW_BRIDGE_TOKEN: bridgeToken,
    // Backend may fall back if the saved device is unavailable.
    ...(hasPreferredDevice
      ? {
          SILVERDAW_OUTPUT_DEVICE_TYPE: audioOutput.typeName as string,
          SILVERDAW_OUTPUT_DEVICE_NAME: audioOutput.deviceName as string
        }
      : {}),
    // Enable keep-awake before the device opens so the wake burst + holding dither rouse a
    // cold DAC at stream start. The renderer still re-pushes the effective state on connect.
    ...(preferredDeviceKeepAwake ? { SILVERDAW_OUTPUT_KEEP_AWAKE: '1' } : {}),
    // Always-on diagnostics dir so the backend can write its crash report and an
    // INFO-level startup log even when the user's verbose logging is off. This is
    // what makes a failed/crashed launch diagnosable from the logs alone.
    SILVERDAW_DIAG_DIR: getDiagnosticsDir(),
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
  // Record exactly what the backend is handed, so a missing backend.log (e.g. under
  // MSIX redirection) is diagnosable from startup.log alone.
  logDiag(
    'INFO ',
    'backend',
    `env exe=${resolveBackendExePath()} diagDir=${getDiagnosticsDir() || '(none)'} ` +
      `logDir=${startupLoggingEnabled ? getSessionDir() : '(off)'} cwd=${app.getPath('temp')}`
  )
  backendSupervisor = new BackendSupervisor({
    resolveExePath: resolveBackendExePath,
    buildEnv: buildBackendEnv,
    getPort: () => bridgePort,
    // Writable cwd so the backend never inherits the read-only WindowsApps
    // install dir (MSIX); the temp dir is always writable/redirected.
    resolveCwd: () => app.getPath('temp'),
    log: (level, scope, message) => {
      logMain(level as LogLevel, scope, message)
      // Mirror backend lifecycle (spawn / exit / respawn / failed) to the always-on
      // diagnostics log so an install that never connects still leaves a trace.
      logDiag(level as LogLevel, scope, message)
    },
    sendStatus: sendBackendStatus
  })
  backendSupervisor.start()
}

// Spawn the backend once the window has painted and shown, yielding a frame first so the
// blocking spawn() on a cold launch cannot delay first paint. Falls back to a short timer in
// case the window never emits `show` (e.g. an offscreen/headless edge case), so the backend is
// always launched exactly once.
function spawnBackendAfterWindowShown(win: BrowserWindow): void {
  let launched = false
  const launch = (): void => {
    if (launched) return
    launched = true
    startBackend()
    logDiag('INFO ', 'perf', `main backend-spawned @ ${Math.round(process.uptime() * 1000)}ms`)
  }
  win.once('show', () => setImmediate(launch))
  setTimeout(launch, 2000)
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

// Must run before app "ready": disables Chromium's Windows location provider
// so packaged builds never trigger the OS location consent prompt.
applyChromiumSecuritySwitches()

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

function buildCreateWindowContext(): Parameters<typeof createWindow>[0] {
  return {
    prefs,
    startupDevToolsEnabled,
    isCloseConfirmed: () => userConfirmedClose
  }
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark'

  // AppUserModelID must be set before the first BrowserWindow on Windows.
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.silverdaw.app')
  }

  // Always-on diagnostics FIRST (independent of the logging preference): captures the
  // backend crash report and startup lifecycle so a launch that never connects to the
  // audio engine is diagnosable even when verbose logging is off. Opened before prefs so
  // the phase-timing markers below are captured from the earliest phase.
  const diagDir = initDiagnostics(join(app.getPath('userData'), 'diagnostics'))
  if (diagDir) {
    logDiag('INFO ', 'main', `electron=${process.versions.electron} node=${process.versions.node} packaged=${app.isPackaged}`)
  }
  // Always-on startup phase timing (ms since process start) so cold/warm launch cost is
  // attributable from the diagnostics log alone.
  const mark = (phase: string): void =>
    logDiag('INFO ', 'perf', `main ${phase} @ ${Math.round(process.uptime() * 1000)}ms`)

  // Probe for a free bridge port in PARALLEL with loading preferences — neither depends on
  // the other, so overlapping them lets the backend spawn sooner.
  const portPromise: Promise<number | null> = bridgePortEnvOverridden
    ? Promise.resolve(bridgePort)
    : findFreeBridgePort(DEFAULT_BRIDGE_PORT, 20)

  // Preferences must load before startup-only logger and DevTools decisions.
  await prefs.load()
  mark('prefs-loaded')
  startupLoggingEnabled = prefs.get().debug.loggingEnabled === true
  startupDevToolsEnabled = prefs.get().debug.devToolsEnabled === true

  // Only opted-in diagnostic sessions write cross-layer logs.
  if (startupLoggingEnabled) {
    const defaultLogDir = getDefaultDebugLogDirectory()
    const preferredLogDir = prefs.get().debug.logDirectory.trim()
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
        logMain('ERROR', 'main', `failed to initialise log directory ${candidate}:`, err)
      }
    }
    if (sessionDir) {
      logMain('INFO ', 'main', `session log dir: ${sessionDir}`)
      logMain('INFO ', 'main', `electron=${process.versions.electron} node=${process.versions.node}`)
    } else {
      logMain('ERROR', 'main', 'failed to initialise file logging; continuing with file logging disabled')
    }
  } else {
    logMain('INFO ', 'main', 'file logging disabled (Preferences > Developer > Write diagnostic logs is off)')
  }

  Menu.setApplicationMenu(null)

  ipcMain.on(IPC.menu.action, (_evt, action: string) =>
    handleMenuAction(action, {
      getMainWindow: () => mainWindow,
      startupDevToolsEnabled,
      confirmClose: () => {
        userConfirmedClose = true
        destroyAllWindowsAndExit()
      }
    })
  )

  registerRuntimeHandlers({
    getBridgePort: () => bridgePort,
    getBridgeToken: () => bridgeToken,
    requestBackendRestart: (reason) => backendSupervisor?.requestRestart(reason)
  })

  registerAudioHandlers({
    getMainWindow: () => mainWindow,
    getCurrentClipDir: () => prefs.getCurrentClipDir(),
    setCurrentClipDir: (dir) => prefs.setCurrentClipDir(dir)
  })

  registerWindowHandlers({ getMainWindow: () => mainWindow })

  registerPreferencesHandlers({
    getMainWindow: () => mainWindow,
    prefs,
    getStartupLoggingEnabled: () => startupLoggingEnabled,
    getStartupDevToolsEnabled: () => startupDevToolsEnabled
  })

  registerProjectHandlers({
    getMainWindow: () => mainWindow,
    prefs,
    consumePendingOpenPath: () => {
      const p = pendingOpenPath
      pendingOpenPath = null
      return p
    }
  })

  registerMixdownHandlers({ getMainWindow: () => mainWindow, prefs })

  registerAutosaveHandlers()

  registerPeaksHandlers()

  registerStemHandlers({ getMainWindow: () => mainWindow, prefs })

  // Resolve the port probed in parallel with prefs/logging above.
  const free = await portPromise
  if (!bridgePortEnvOverridden) {
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
      logMain('INFO ', 'main', `port ${bridgePort} busy; using ${free} instead`)
    }
    bridgePort = free
  }
  mark('port-resolved')

  // Create the window FIRST, then spawn the backend once the window has painted and shown.
  // On a cold first launch after install, Node's spawn() blocks the main thread for several
  // seconds while Windows pages in and virus-scans the freshly-installed backend executable;
  // spawning before the window is shown would stall first paint behind that block. The renderer
  // retries the bridge connection until the backend is up, so deferring the spawn delays only
  // audio readiness, not the UI.
  hardenDefaultSession()

  mainWindow = createWindow(buildCreateWindowContext())
  mark('window-created')

  spawnBackendAfterWindowShown(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow(buildCreateWindowContext())
    }
  })
  })
  .catch((err) => {
  // A rejection here means the main process is only half-initialised (prefs,
  // port probe, IPC wiring, or window creation failed) and is unusable.
  // logMain always mirrors to the console, so this surfaces even if file
  // logging was never initialised, before we exit.
  logMain('ERROR', 'main', 'fatal error during startup', err)
  app.exit(1)
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
  prefs.flushSaveSync()
  logMain('INFO ', 'main', 'before-quit')
  logDiag('INFO ', 'main', 'before-quit')
  closeLogs()
  closeDiagnostics()
})
