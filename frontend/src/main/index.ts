import { app, BrowserWindow, Menu, ipcMain, nativeTheme, dialog, shell, screen } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve as pathResolve } from 'node:path'
import { closeLogs, getSessionDir, initLogs, logMain, logRendererLine, type LogLevel } from './log'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { parseFile, type IAudioMetadata, type IPicture } from 'music-metadata'
import type { AudioMetadata } from '../shared/types'

// ─── Audio metadata ─────────────────────────────────────────────────────────
// `AudioMetadata` lives in `src/shared/types.ts` and is shared with preload +
// renderer. The helpers below take a `music-metadata` parse result and emit
// the normalised wire shape.

/** Drop embedded pictures larger than this so we don't bloat the Pinia store. */
const MAX_COVER_ART_BYTES = 2 * 1024 * 1024

/**
 * Pick the best cover-art picture (preferring an explicit front cover) and
 * return its raw bytes + MIME type. The renderer turns the buffer into a
 * `Blob` + `URL.createObjectURL`, so we ship binary across IPC rather than
 * base64-inflated data URLs.
 */
function pickCoverArt(
  pictures: IPicture[] | undefined
): { data: ArrayBuffer; mimeType: string } | undefined {
  if (!pictures || pictures.length === 0) return undefined
  // Prefer a front-cover-type picture if the tag distinguishes them; else first.
  const front = pictures.find((p) => (p.type ?? '').toLowerCase().includes('cover')) ?? pictures[0]
  if (!front.data || front.data.length === 0 || front.data.length > MAX_COVER_ART_BYTES) {
    return undefined
  }
  // Copy into a fresh ArrayBuffer so we hand IPC an owned, transferable
  // buffer rather than a view into the (potentially larger) parse-result
  // arena `music-metadata` keeps internally.
  const src = front.data
  const data = src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength) as ArrayBuffer
  const mimeType = front.format || 'image/jpeg'
  return { data, mimeType }
}

function normalizeMetadata(meta: IAudioMetadata): AudioMetadata {
  const { common, format } = meta
  const out: AudioMetadata = {}
  if (common.title) out.title = common.title
  if (common.artist) out.artist = common.artist
  if (common.albumartist) out.albumArtist = common.albumartist
  if (common.album) out.album = common.album
  if (typeof common.year === 'number') out.year = common.year
  if (common.genre && common.genre.length > 0) out.genre = common.genre
  if (common.track) {
    if (typeof common.track.no === 'number') out.trackNumber = common.track.no
    if (typeof common.track.of === 'number') out.trackTotal = common.track.of
  }
  if (common.disk) {
    if (typeof common.disk.no === 'number') out.discNumber = common.disk.no
    if (typeof common.disk.of === 'number') out.discTotal = common.disk.of
  }
  if (typeof common.bpm === 'number') out.bpm = common.bpm
  if (common.key) out.key = common.key
  if (common.composer && common.composer.length > 0) out.composer = common.composer.join(', ')
  if (common.comment && common.comment.length > 0) {
    const first = common.comment[0]
    out.comment = typeof first === 'string' ? first : (first?.text ?? undefined)
  }
  if (format.codec) out.codec = format.codec
  if (format.container) out.container = format.container
  if (typeof format.bitrate === 'number') out.bitrate = format.bitrate
  if (typeof format.lossless === 'boolean') out.lossless = format.lossless
  if (format.tagTypes && format.tagTypes.length > 0) out.tagTypes = [...format.tagTypes]
  const cover = pickCoverArt(common.picture)
  if (cover) out.coverArt = cover
  return out
}

// ─── Theme / colours (kept in sync with the renderer Tailwind palette) ──────
const TITLE_BAR_HEIGHT = 36
const COLOUR_BG = '#18181b' // zinc-900
const COLOUR_FG = '#d4d4d8' // zinc-300

// File extensions accepted by every audio open-dialog and (later) by the
// path-validation guard on `audio:readFile` / `audio:readMetadata`. Keep in
// sync with the JUCE backend's supported formats.
const AUDIO_FILE_EXTENSIONS = ['wav', 'mp3', 'flac', 'aiff', 'aif', 'ogg', 'm4a'] as const
const AUDIO_FILE_EXTENSIONS_SET: ReadonlySet<string> = new Set<string>(AUDIO_FILE_EXTENSIONS)

/**
 * Whitelist of absolute filesystem paths the renderer is allowed to read via
 * `audio:readFile` / `audio:readMetadata`. Populated when main hands a path
 * to the renderer (open-dialog result) or when the renderer reports a path
 * obtained from an OS drag-drop via `webUtils.getPathForFile` through the
 * `audio:registerDroppedPath` IPC.
 *
 * Without this guard a compromised renderer could read any file the main
 * process can — see FE-004 in the security review.
 */
const issuedAudioPaths: Set<string> = new Set<string>()

/**
 * Filesystem cache for renderer-side transcodes. The renderer decodes
 * lossy / non-native formats (e.g. .m4a) via the Web Audio API and asks
 * main to dump the PCM as a WAV; the backend then reads that WAV. Files
 * are keyed by a hash of the source path + decoded geometry so the same
 * import doesn't re-transcode on every clip placement.
 */
const TRANSCODE_CACHE_DIR = join(tmpdir(), 'silverdaw-transcode-cache')

/** Normalise to an absolute path so allow-list membership is canonical. */
function canonicalisePath(p: string): string {
  return pathResolve(p)
}

/**
 * Add a path to the allow-list using its canonical absolute form. Rejects
 * anything that isn't an absolute path with an accepted audio extension,
 * so a future regression that leaks `ipcRenderer.send` to a compromised
 * renderer can't pollute the read allow-list with arbitrary filesystem
 * locations. (FE-004 in the security review.)
 */
function registerIssuedPath(filePath: string): void {
  if (typeof filePath !== 'string' || filePath === '') return
  if (!isAbsolute(filePath)) {
    console.warn('[main] refusing to register non-absolute path:', filePath)
    return
  }
  const ext = extname(filePath).replace(/^\./, '').toLowerCase()
  if (!AUDIO_FILE_EXTENSIONS_SET.has(ext)) {
    console.warn('[main] refusing to register non-audio path:', filePath)
    return
  }
  issuedAudioPaths.add(canonicalisePath(filePath))
}

/**
 * True if `filePath` is on the allow-list AND has an accepted audio
 * extension. The extension check is belt-and-braces: every path that
 * makes it onto the allow-list has already passed the dialog filter or
 * a drag-drop from the OS, but defence-in-depth is cheap here.
 */
function isAllowedAudioPath(filePath: unknown): filePath is string {
  if (typeof filePath !== 'string' || filePath === '') return false
  const ext = extname(filePath).replace(/^\./, '').toLowerCase()
  if (!AUDIO_FILE_EXTENSIONS_SET.has(ext)) return false
  return issuedAudioPaths.has(canonicalisePath(filePath))
}

let backendProcess: ChildProcess | null = null
let mainWindow: BrowserWindow | null = null

// ─── Backend bridge port ────────────────────────────────────────────────────
// The JUCE backend listens on `ws://127.0.0.1:<bridgePort>`. The port is
// resolvable via `SILVERDAW_BRIDGE_PORT` so multiple Silverdaw instances (or a
// stand-alone backend used for debugging) can avoid colliding on 8765.
// Main passes the same value to the backend via `--port` AND exposes it to
// the renderer through `bridge:getPort`, so all three processes agree on
// one canonical source of truth.
const DEFAULT_BRIDGE_PORT = 8765
const MIN_BRIDGE_PORT = 1024
const MAX_BRIDGE_PORT = 65535

function resolveBridgePort(): number {
  const raw = process.env['SILVERDAW_BRIDGE_PORT']
  if (raw === undefined || raw === '') return DEFAULT_BRIDGE_PORT
  const parsed = Number.parseInt(raw, 10)
  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < MIN_BRIDGE_PORT ||
    parsed > MAX_BRIDGE_PORT
  ) {
    console.warn(
      `[main] SILVERDAW_BRIDGE_PORT=${raw} is not a valid port in [${MIN_BRIDGE_PORT}, ${MAX_BRIDGE_PORT}]; using default ${DEFAULT_BRIDGE_PORT}`
    )
    return DEFAULT_BRIDGE_PORT
  }
  return parsed
}

const bridgePort = resolveBridgePort()

// ─── Backend bridge AUTH token ──────────────────────────────────────────────
// Loopback alone is not a strong trust boundary — any other process running
// as the same user can connect to the WebSocket. Each backend launch gets a
// fresh 256-bit random token; main passes it to the backend via the
// `SILVERDAW_BRIDGE_TOKEN` env var (NOT a CLI arg — argv is visible in the OS
// process table) and exposes it to the renderer through `bridge:getToken`,
// so the renderer can send it as the first WebSocket message. The backend
// closes any socket that fails to AUTH on its first envelope.
const bridgeToken = randomBytes(32).toString('hex')

// ─── Persisted preferences (window state + UI panel sizes) ──────────────────
// Stored as JSON in `<userData>/preferences.json`. Writes are debounced so a
// burst of resize/move events doesn't hammer the disk; an unconditional
// flush runs on `before-quit` to make sure the final state is captured.

interface WindowPrefs {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

interface UiPrefs {
  trackHeaderWidth: number
  libraryPanelHeight: number
}

interface Preferences {
  window: WindowPrefs
  ui: UiPrefs
}

const DEFAULT_PREFS: Preferences = {
  window: { width: 1400, height: 900, maximized: false },
  ui: { trackHeaderWidth: 175, libraryPanelHeight: 180 }
}

let prefs: Preferences = structuredClone(DEFAULT_PREFS)
let prefsPath = ''
let prefsSaveTimer: ReturnType<typeof setTimeout> | null = null

function getPrefsPath(): string {
  if (!prefsPath) prefsPath = join(app.getPath('userData'), 'preferences.json')
  return prefsPath
}

async function loadPreferences(): Promise<void> {
  try {
    const raw = await readFile(getPrefsPath(), 'utf8')
    // Empty file = no prefs yet (e.g. atomic-write was interrupted, or a
    // brand-new install before the first save). Treat the same as ENOENT
    // so we don't spam stderr with a SyntaxError on every startup.
    if (raw.trim().length === 0) {
      return
    }
    const parsed = JSON.parse(raw) as Partial<Preferences>
    // Merge over defaults so newly-added keys get sane values on first run
    // after an upgrade.
    prefs = {
      window: { ...DEFAULT_PREFS.window, ...(parsed.window ?? {}) },
      ui: { ...DEFAULT_PREFS.ui, ...(parsed.ui ?? {}) }
    }
  } catch (err) {
    // ENOENT on first run is expected; anything else is logged but we still
    // fall back to defaults rather than blocking startup.
    const code = (err as { code?: string }).code
    if (code !== 'ENOENT') {
      console.warn('[prefs] load failed, using defaults:', err)
    }
    prefs = structuredClone(DEFAULT_PREFS)
  }
}

function schedulePrefsSave(): void {
  if (prefsSaveTimer) clearTimeout(prefsSaveTimer)
  prefsSaveTimer = setTimeout(() => {
    prefsSaveTimer = null
    void flushPrefsSave()
  }, 400)
}

async function flushPrefsSave(): Promise<void> {
  if (prefsSaveTimer) {
    clearTimeout(prefsSaveTimer)
    prefsSaveTimer = null
  }
  try {
    const path = getPrefsPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(prefs, null, 2), 'utf8')
  } catch (err) {
    console.warn('[prefs] save failed:', err)
  }
}

/**
 * Return a window bounds object clamped to fall inside one of the currently
 * connected displays. Prevents the window from opening off-screen after a
 * monitor is unplugged.
 */
function resolveWindowBounds(): { x?: number; y?: number; width: number; height: number } {
  const w = prefs.window
  const width = Math.max(900, Math.min(8000, w.width))
  const height = Math.max(600, Math.min(8000, w.height))
  if (typeof w.x !== 'number' || typeof w.y !== 'number') {
    return { width, height }
  }
  // Confirm the saved top-left is on a connected display; if not, drop the
  // position and let Electron centre the window on the primary display.
  const displays = screen.getAllDisplays()
  const onScreen = displays.some((d) => {
    const { x, y, width: dw, height: dh } = d.workArea
    return w.x! >= x && w.y! >= y && w.x! < x + dw && w.y! < y + dh
  })
  return onScreen ? { x: w.x, y: w.y, width, height } : { width, height }
}

function captureWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  // Don't overwrite the saved x/y/width/height while the window is in a
  // maximized state — we want to restore the *unmaximized* bounds next time.
  const maximized = mainWindow.isMaximized()
  prefs.window.maximized = maximized
  if (!maximized) {
    // `getNormalBounds()` is symmetric with `setBounds()` — round-tripping
    // through it keeps the window from drifting bigger each session.
    // `getBounds()` on Windows with `titleBarStyle: 'hidden'` returns
    // values that, when fed back into the constructor or `setBounds`,
    // produce a slightly larger window — a few px of growth per restart.
    const b = mainWindow.getNormalBounds()
    prefs.window.x = b.x
    prefs.window.y = b.y
    prefs.window.width = b.width
    prefs.window.height = b.height
  }
  schedulePrefsSave()
}

function startBackend(): void {
  // In dev: JUCE's juce_add_console_app outputs to
  //   <repo>/backend/build/SilverdawBackend_artefacts/<Config>/SilverdawBackend.exe
  // In a packaged build this path will need to be re-resolved.
  const exeName = process.platform === 'win32' ? 'SilverdawBackend.exe' : 'SilverdawBackend'
  const buildConfig = process.env['SILVERDAW_BACKEND_CONFIG'] ?? 'Debug'
  const exePath = join(
    __dirname,
    '..',
    '..',
    '..',
    'backend',
    'build',
    'SilverdawBackend_artefacts',
    buildConfig,
    exeName
  )

  backendProcess = spawn(exePath, ['--port', String(bridgePort)], {
    stdio: 'inherit',
    // Forward `SILVERDAW_BRIDGE_TOKEN` via the spawn env (NOT via argv —
    // command-line arguments are visible in the OS process table). The
    // backend's `resolveBridgeToken()` reads the same env var and
    // requires every WebSocket client to AUTH with this exact value.
    // `SILVERDAW_LOG_DIR` is exported so the C++ logger writes its
    // `backend.log` into the same per-session folder as `main.log` and
    // `renderer.log`, enabling cross-layer timeline correlation.
    env: {
      ...process.env,
      SILVERDAW_BRIDGE_TOKEN: bridgeToken,
      SILVERDAW_LOG_DIR: getSessionDir()
    }
  })

  backendProcess.on('exit', (code) => {
    logMain('INFO ', 'backend', `exited with code ${String(code)}`)
    console.log(`[backend] exited with code ${code}`)
    backendProcess = null
  })

  backendProcess.on('error', (err) => {
    logMain('ERROR', 'backend', `failed to start: ${err.message}`)
    console.error('[backend] failed to start:', err)
  })
}

function createWindow(): void {
  const bounds = resolveWindowBounds()
  // Resolve the window icon from `<app>/resources/icons/icon.ico`. The
  // file is optional — if the user hasn't dropped one in yet, Electron
  // falls back to its default and the app still starts cleanly. See
  // `resources/README.md` for the spec.
  const iconPath = join(app.getAppPath(), 'resources', 'icons', 'icon.ico')
  const icon = existsSync(iconPath) ? iconPath : undefined
  if (!icon) {
    logMain('INFO ', 'main', `no app icon at ${iconPath} — using Electron default`)
  }
  mainWindow = new BrowserWindow({
    // Important: do NOT pass x/y/width/height in the constructor on Windows
    // with `titleBarStyle: 'hidden'` + multi-monitor mixed DPI. The
    // constructor interprets those values in a different coordinate space
    // than `getBounds()` reports, causing the saved size to drift bigger
    // on every restart. We hide the window, position+size it explicitly
    // via `setBounds()` (which is symmetric with `getBounds`/`getNormalBounds`),
    // then show it.
    minWidth: 900,
    minHeight: 600,
    backgroundColor: COLOUR_BG,
    icon,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay:
      process.platform === 'win32' || process.platform === 'linux'
        ? { color: COLOUR_BG, symbolColor: COLOUR_FG, height: TITLE_BAR_HEIGHT }
        : undefined,
    trafficLightPosition: { x: 12, y: 11 },
    webPreferences: {
      // electron-vite emits the preload bundle as `index.cjs` (CommonJS).
      // Sandboxed renderers can only load CJS preload scripts.
      preload: join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      // Preload uses only contextBridge / ipcRenderer / webUtils, all of
      // which remain available in a sandboxed preload. Keeping sandbox on
      // restores Chromium's renderer-process isolation guarantees.
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  // Apply saved bounds. Use `setBounds` so we're symmetric with the
  // `getBounds()` we save in `captureWindowState` — round-tripping is
  // stable even on a secondary monitor with a different DPI scale.
  //
  // Windows mixed-DPI workaround: when the constructor-default display has
  // a different scale factor than the target display (e.g. primary @ 125%,
  // secondary @ 100%), the FIRST `setBounds` call applies the size using
  // the previous display's scale, then the window moves to the new
  // display and Electron reports back a size scaled by the ratio. Calling
  // `setBounds` a second time — now that Electron knows which display the
  // window lives on — applies the size at the correct scale.
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

  // Restore maximized state without losing the unmaximized bounds: the
  // `setBounds` above used the unmaximized size, so calling `maximize()`
  // now gives us the right "double-click title bar → restore" target.
  if (prefs.window.maximized) mainWindow.maximize()

  mainWindow.show()

  // Persist window position / size / maximized state. `resize` and `move`
  // fire continuously while the user drags, so saves are debounced inside
  // `captureWindowState`.
  mainWindow.on('resize', captureWindowState)
  mainWindow.on('move', captureWindowState)
  mainWindow.on('maximize', captureWindowState)
  mainWindow.on('unmaximize', captureWindowState)
  mainWindow.on('close', () => {
    captureWindowState()
    void flushPrefsSave()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'))
  }
}

/**
 * Menu actions invoked from the custom HTML menu bar via IPC.
 * Most of these are stubs that just log; they will be wired to backend
 * commands as features land.
 */
function handleMenuAction(action: string): void {
  if (!mainWindow) return
  const wc = mainWindow.webContents

  switch (action) {
    // File
    case 'file.newProject':
      console.log('[menu] new project (todo)')
      break
    case 'file.openProject':
      void dialog
        .showOpenDialog(mainWindow, {
          title: 'Open Project',
          filters: [{ name: 'Silverdaw project', extensions: ['silverdaw'] }],
          properties: ['openFile']
        })
        .then((r) => console.log('[menu] open project:', r.filePaths))
      break
    case 'file.save':
      console.log('[menu] save (todo)')
      break
    case 'file.saveAs':
      console.log('[menu] save as (todo)')
      break
    case 'file.addTrack':
      // Forwarded to the renderer (see below); the renderer drives the
      // open-file flow so it can decode + render in one place.
      wc.send('menu:action', action)
      break
    case 'file.exportMixdown':
      console.log('[menu] export mixdown (todo)')
      break
    case 'file.exit':
      // Destroy every window (skips the renderer's close-event handlers) and
      // exit hard. app.quit() can occasionally stall when a detached devtools
      // window or pending IPC keeps the event loop busy.
      BrowserWindow.getAllWindows().forEach((w) => {
        if (!w.isDestroyed()) w.destroy()
      })
      app.exit(0)
      break

    // Edit
    case 'edit.undo':
      wc.undo()
      break
    case 'edit.redo':
      wc.redo()
      break
    case 'edit.cut':
      wc.cut()
      break
    case 'edit.copy':
      wc.copy()
      break
    case 'edit.paste':
      wc.paste()
      break
    case 'edit.preferences':
      console.log('[menu] preferences (todo)')
      break

    // View
    case 'view.reload':
      wc.reload()
      break
    case 'view.toggleDevTools':
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
      void dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'About Silverdaw',
        message: 'Silverdaw',
        detail: `Version 0.1.0\nElectron ${process.versions.electron}\nNode ${process.versions.node}\nChromium ${process.versions.chrome}`,
        buttons: ['OK']
      })
      break

    default:
      console.warn('[menu] unknown action:', action)
  }
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark'

  // Windows: associate the running process with a stable AppUserModelID
  // so the taskbar groups our windows under one icon and the start-menu
  // pin (post-install, Phase 6) targets the right shortcut. Must be set
  // BEFORE the first BrowserWindow is created.
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.silverdaw.app')
  }

  // Initialise cross-layer logging before anything else so this session's
  // main / backend / renderer events all land in one `.logs/<stamp>/` dir.
  // Repo root is the directory above `frontend/`; for prod builds we
  // fall back to the executable's parent so user installs aren't trying
  // to write into Program Files.
  const repoRoot = !app.isPackaged
    ? pathResolve(__dirname, '..', '..', '..')
    : pathResolve(app.getPath('userData'))
  const sessionDir = initLogs(repoRoot)
  logMain('INFO ', 'main', `session log dir: ${sessionDir}`)
  logMain('INFO ', 'main', `electron=${process.versions.electron} node=${process.versions.node}`)

  // Load persisted preferences (window bounds + UI panel sizes) before the
  // first window is created so the restored size/position is applied at
  // construction time rather than as a post-show resize flash.
  await loadPreferences()

  // Hide the native application menu — we render our own in HTML.
  Menu.setApplicationMenu(null)

  ipcMain.on('menu:action', (_evt, action: string) => handleMenuAction(action))

  // Renderer-side logger flushes batches of structured log entries here so
  // they land in the same session directory as main / backend events.
  // Each entry is { level, tag, message, timestamp }; the level is the
  // same 5-char padded form used by the backend so columns align.
  ipcMain.handle(
    'log:append-batch',
    (_evt, entries: Array<{ level: LogLevel; tag: string; message: string; timestamp: number }>) => {
      if (!Array.isArray(entries)) return
      for (const e of entries) {
        if (!e || typeof e.tag !== 'string' || typeof e.message !== 'string') continue
        logRendererLine(e.level ?? 'INFO ', e.tag, e.message, e.timestamp)
      }
    }
  )

  // Tell the renderer which port the JUCE bridge is listening on. Resolved
  // once at main-process start (env var or default) and shared with the
  // spawned backend via `--port`.
  ipcMain.handle('bridge:getPort', () => bridgePort)

  // Hand the renderer the per-session AUTH token so it can send the
  // initial `{type:'AUTH',payload:{token}}` envelope. The token never
  // appears in argv or in the renderer's HTML — only the trusted preload
  // bridge can fetch it.
  ipcMain.handle('bridge:getToken', () => bridgeToken)

  // Open an audio file via the OS dialog and stream its bytes back to the renderer.
  // Returns null if the user cancels.
  ipcMain.handle('audio:open', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add Track from File',
      filters: [{ name: 'Audio files', extensions: [...AUDIO_FILE_EXTENSIONS] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    const buf = await readFile(filePath)
    // Copy into a plain ArrayBuffer so it survives the IPC boundary cleanly.
    const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    // Whitelist this path so the renderer can re-read it later via
    // `audio:readFile` (e.g. when the user re-imports the same file).
    registerIssuedPath(filePath)
    return { filePath, fileName: basename(filePath), data }
  })

  // Multi-file variant used by the library panel's Import button.
  // Returns an array of opened files (paths + bytes) or `[]` if cancelled.
  ipcMain.handle('audio:openMany', async () => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Audio into Library',
      filters: [{ name: 'Audio files', extensions: [...AUDIO_FILE_EXTENSIONS] }],
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return []
    const out: { filePath: string; fileName: string; data: ArrayBuffer }[] = []
    for (const filePath of result.filePaths) {
      try {
        const buf = await readFile(filePath)
        const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
        registerIssuedPath(filePath)
        out.push({ filePath, fileName: basename(filePath), data })
      } catch (err) {
        console.error('[audio:openMany] read failed for', filePath, err)
      }
    }
    return out
  })

  // Renderer reports a path it obtained from an OS drag-drop via
  // `webUtils.getPathForFile`. The path is added to the allow-list so the
  // follow-up `audio:readFile` / `audio:readMetadata` calls will pass the
  // FE-004 guard. We intentionally do NO further validation here: only the
  // OS shell can have populated this string (the renderer can't fabricate
  // a `File` with an arbitrary path), and even if it could, the actual
  // read still has to satisfy the extension allow-list below.
  ipcMain.on('audio:registerDroppedPath', (_evt, filePath: unknown) => {
    if (typeof filePath !== 'string') return
    registerIssuedPath(filePath)
  })

  // Read an audio file by absolute path (e.g. one obtained from an OS
  // drag-drop via `webUtils.getPathForFile`). Returns null on failure or
  // when the path is not on the allow-list.
  ipcMain.handle('audio:readFile', async (_evt, filePath: unknown) => {
    if (!isAllowedAudioPath(filePath)) {
      console.warn('[audio:readFile] rejected path not on allow-list:', filePath)
      return null
    }
    try {
      const buf = await readFile(filePath)
      const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      return { filePath, fileName: basename(filePath), data }
    } catch (err) {
      console.error('[audio:readFile] failed for', filePath, err)
      return null
    }
  })

  // Extract ID3 / Vorbis / iTunes / BWF metadata from an audio file. Returns
  // a normalized subset of fields the renderer can display in the library
  // card and tooltip. Resolves to `null` if parsing fails (the import still
  // succeeds with only the technical info from Web Audio).
  ipcMain.handle('audio:readMetadata', async (_evt, filePath: unknown) => {
    if (!isAllowedAudioPath(filePath)) {
      console.warn('[audio:readMetadata] rejected path not on allow-list:', filePath)
      return null
    }
    try {
      const meta = await parseFile(filePath, { duration: false, skipCovers: false })
      return normalizeMetadata(meta)
    } catch (err) {
      console.warn('[audio:readMetadata] failed for', filePath, err)
      return null
    }
  })

  // Write decoded PCM (from the renderer's Web Audio decoder) to a temp
  // WAV file the JUCE backend can read. Used for formats the backend's
  // AudioFormatManager doesn't understand natively on this platform —
  // notably AAC / M4A / MP4 on Windows, where JUCE's bundled formats only
  // cover WAV/AIFF/FLAC/Ogg + the Windows Media SDK (WMA family + MP3).
  //
  // Returns the absolute path to the written WAV, or `null` on failure.
  // The path is added to the audio allow-list so the renderer may re-read
  // it via `audio:readFile` if it ever needs to (the backend reads it via
  // its own filesystem access, independently of the allow-list).
  ipcMain.handle('audio:writeTempWav', async (_evt, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return null
    const p = payload as {
      sourcePath?: unknown
      channels?: unknown
      sampleRate?: unknown
    }
    if (typeof p.sourcePath !== 'string' || !isAllowedAudioPath(p.sourcePath)) {
      console.warn('[audio:writeTempWav] rejected source not on allow-list:', p.sourcePath)
      return null
    }
    if (typeof p.sampleRate !== 'number' || !Number.isFinite(p.sampleRate) || p.sampleRate <= 0) {
      return null
    }
    if (!Array.isArray(p.channels) || p.channels.length === 0 || p.channels.length > 8) {
      return null
    }
    const chans: Float32Array[] = []
    let frameCount = -1
    for (const c of p.channels) {
      let arr: Float32Array
      if (c instanceof Float32Array) {
        arr = c
      } else if (c instanceof ArrayBuffer) {
        arr = new Float32Array(c)
      } else if (ArrayBuffer.isView(c)) {
        const view = c as ArrayBufferView
        arr = new Float32Array(view.buffer, view.byteOffset, view.byteLength / 4)
      } else {
        return null
      }
      if (frameCount < 0) frameCount = arr.length
      else if (arr.length !== frameCount) return null
      chans.push(arr)
    }
    if (frameCount <= 0) return null

    try {
      await mkdir(TRANSCODE_CACHE_DIR, { recursive: true })
    } catch (err) {
      console.error('[audio:writeTempWav] failed to create cache dir:', err)
      return null
    }

    // Cache key includes channel + frame + rate so a re-decode that
    // produced different output (sample-rate change, etc.) won't collide.
    const hash = createHash('sha1')
      .update(canonicalisePath(p.sourcePath))
      .update(`|sr=${p.sampleRate}|ch=${chans.length}|n=${frameCount}`)
      .digest('hex')
      .slice(0, 16)
    const outPath = join(TRANSCODE_CACHE_DIR, `${hash}.wav`)

    // 32-bit float WAV (WAVE_FORMAT_IEEE_FLOAT, code 0x0003). JUCE's WAV
    // reader handles both float and integer PCM; float avoids quantising
    // the renderer's already-decoded sample data.
    const numChannels = chans.length
    const bitsPerSample = 32
    const byteRate = p.sampleRate * numChannels * 4
    const blockAlign = numChannels * 4
    const dataSize = frameCount * blockAlign
    const headerSize = 44
    const buf = Buffer.alloc(headerSize + dataSize)

    let off = 0
    buf.write('RIFF', off)
    off += 4
    buf.writeUInt32LE(headerSize + dataSize - 8, off)
    off += 4
    buf.write('WAVE', off)
    off += 4
    buf.write('fmt ', off)
    off += 4
    buf.writeUInt32LE(16, off)
    off += 4
    buf.writeUInt16LE(3 /* IEEE_FLOAT */, off)
    off += 2
    buf.writeUInt16LE(numChannels, off)
    off += 2
    buf.writeUInt32LE(p.sampleRate, off)
    off += 4
    buf.writeUInt32LE(byteRate, off)
    off += 4
    buf.writeUInt16LE(blockAlign, off)
    off += 2
    buf.writeUInt16LE(bitsPerSample, off)
    off += 2
    buf.write('data', off)
    off += 4
    buf.writeUInt32LE(dataSize, off)
    off += 4
    // Interleave planar channels frame-by-frame.
    for (let f = 0; f < frameCount; f++) {
      for (let c = 0; c < numChannels; c++) {
        buf.writeFloatLE(chans[c]![f]!, off)
        off += 4
      }
    }

    try {
      await writeFile(outPath, buf)
    } catch (err) {
      console.error('[audio:writeTempWav] failed to write WAV:', err)
      return null
    }
    registerIssuedPath(outPath)
    return outPath
  })

  // Hand the renderer its persisted preferences (UI panel sizes etc.) on
  // request. Window bounds are applied by main so they aren't included.
  ipcMain.handle('prefs:getUi', () => prefs.ui)

  // Update one or more UI preference keys. The renderer calls this whenever
  // the user resizes a panel; main debounces the write to disk.
  ipcMain.on('prefs:setUi', (_evt, partial: Partial<UiPrefs>) => {
    prefs.ui = { ...prefs.ui, ...partial }
    schedulePrefsSave()
  })

  // Create the window first so the user sees a frame immediately; defer
  // backend-process spawn to the next tick so it doesn't contend with the
  // renderer for CPU during initial paint.
  createWindow()
  setImmediate(startBackend)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (backendProcess) {
    backendProcess.kill()
    backendProcess = null
  }
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (backendProcess) {
    backendProcess.kill()
    backendProcess = null
  }
  // Make sure any pending debounced write hits disk before we exit.
  void flushPrefsSave()
  logMain('INFO ', 'main', 'before-quit')
  closeLogs()
})
