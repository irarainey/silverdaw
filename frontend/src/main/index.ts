import { app, BrowserWindow, Menu, ipcMain, nativeTheme, dialog, shell } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

// ─── Theme / colours (kept in sync with the renderer Tailwind palette) ──────
const TITLE_BAR_HEIGHT = 36
const COLOUR_BG = '#18181b' // zinc-900
const COLOUR_FG = '#d4d4d8' // zinc-300

let backendProcess: ChildProcess | null = null
let mainWindow: BrowserWindow | null = null

function startBackend(): void {
  // In dev: JUCE's juce_add_console_app outputs to
  //   <repo>/backend/build/JackdawBackend_artefacts/<Config>/JackdawBackend.exe
  // In a packaged build this path will need to be re-resolved.
  const exeName = process.platform === 'win32' ? 'JackdawBackend.exe' : 'JackdawBackend'
  const buildConfig = process.env['JACKDAW_BACKEND_CONFIG'] ?? 'Debug'
  const exePath = join(
    __dirname,
    '..',
    '..',
    '..',
    'backend',
    'build',
    'JackdawBackend_artefacts',
    buildConfig,
    exeName
  )

  backendProcess = spawn(exePath, [], { stdio: 'inherit' })

  backendProcess.on('exit', (code) => {
    console.log(`[backend] exited with code ${code}`)
    backendProcess = null
  })

  backendProcess.on('error', (err) => {
    console.error('[backend] failed to start:', err)
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: COLOUR_BG,
    // Show the window immediately. `backgroundColor` paints the frame dark
    // before any HTML loads, so there is no flash-of-unstyled-content even
    // without the `ready-to-show` deferral.
    show: true,
    // Frameless on Windows/Linux; macOS gets its native traffic-light buttons inset.
    titleBarStyle: 'hidden',
    titleBarOverlay:
      process.platform === 'win32' || process.platform === 'linux'
        ? { color: COLOUR_BG, symbolColor: COLOUR_FG, height: TITLE_BAR_HEIGHT }
        : undefined,
    trafficLightPosition: { x: 12, y: 11 },
    webPreferences: {
      // electron-vite emits the preload bundle as `index.mjs` (ESM).
      preload: join(__dirname, '..', 'preload', 'index.mjs'),
      contextIsolation: true,
      sandbox: false
    }
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
          filters: [{ name: 'Jackdaw project', extensions: ['jdaw'] }],
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
      void shell.openExternal('https://github.com/irarainey/jackdaw')
      break
    case 'help.reportIssue':
      void shell.openExternal('https://github.com/irarainey/jackdaw/issues/new')
      break
    case 'help.about':
      void dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'About Jackdaw',
        message: 'Jackdaw',
        detail: `Version 0.1.0\nElectron ${process.versions.electron}\nNode ${process.versions.node}\nChromium ${process.versions.chrome}`,
        buttons: ['OK']
      })
      break

    default:
      console.warn('[menu] unknown action:', action)
  }
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark'

  // Hide the native application menu — we render our own in HTML.
  Menu.setApplicationMenu(null)

  ipcMain.on('menu:action', (_evt, action: string) => handleMenuAction(action))

  // Show a native message box with the current backend connection state.
  // The renderer holds the live state, so it passes the boolean through.
  ipcMain.on('dialog:status', (_evt, connected: boolean) => {
    if (!mainWindow) return
    void dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Status',
      message: connected ? 'Backend connected' : 'Backend disconnected',
      detail: connected
        ? 'The audio engine bridge is connected and ready.'
        : 'The audio engine bridge is not currently connected.',
      buttons: ['OK']
    })
  })

  // Open an audio file via the OS dialog and stream its bytes back to the renderer.
  // Returns null if the user cancels.
  ipcMain.handle('audio:open', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add Track from File',
      filters: [
        { name: 'Audio files', extensions: ['wav', 'mp3', 'flac', 'aiff', 'aif', 'ogg', 'm4a'] }
      ],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    const buf = await readFile(filePath)
    // Copy into a plain ArrayBuffer so it survives the IPC boundary cleanly.
    const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    return { filePath, fileName: basename(filePath), data }
  })

  // Multi-file variant used by the library panel's Import button.
  // Returns an array of opened files (paths + bytes) or `[]` if cancelled.
  ipcMain.handle('audio:openMany', async () => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Audio into Library',
      filters: [
        { name: 'Audio files', extensions: ['wav', 'mp3', 'flac', 'aiff', 'aif', 'ogg', 'm4a'] }
      ],
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return []
    const out: { filePath: string; fileName: string; data: ArrayBuffer }[] = []
    for (const filePath of result.filePaths) {
      try {
        const buf = await readFile(filePath)
        const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
        out.push({ filePath, fileName: basename(filePath), data })
      } catch (err) {
        console.error('[audio:openMany] read failed for', filePath, err)
      }
    }
    return out
  })

  // Read an audio file by absolute path (e.g. one obtained from an OS
  // drag-drop via `webUtils.getPathForFile`). Returns null on failure.
  ipcMain.handle('audio:readFile', async (_evt, filePath: string) => {
    try {
      const buf = await readFile(filePath)
      const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      return { filePath, fileName: basename(filePath), data }
    } catch (err) {
      console.error('[audio:readFile] failed for', filePath, err)
      return null
    }
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
})
